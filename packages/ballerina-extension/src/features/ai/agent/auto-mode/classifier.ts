// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * The two-stage classifier call (design §4), from pincer-agent
 * `extensions/auto-mode/classifier.ts` (`3b290c8`) without its candidate
 * chain: the WSO2 Integrator Copilot has one model per login method, so the
 * caller supplies the one model call (`ClassifierModelCall`, Sonnet 5 through
 * `getAnthropicClient` in production, a fake in tests).
 *
 *   Stage 1 grades HARM ONLY (64 output tokens). Severity below 50 allows,
 *   with no stage 2.
 *   Stage 2 applies user intent and the ALLOW exceptions (1024 tokens), must
 *   cite a rule to block, and must quote the user to clear on intent.
 *
 * Both stages share the system prompt and transcript byte for byte, so stage 2
 * reads stage 1's cache. A reply cut off at its limit is retried once with
 * more room (1024 for stage 1, 4096 for stage 2). Every failure blocks: no
 * credentials, provider error, truncated or unparseable reply. A timeout is
 * retried once and then reported as its own tier, which the gate returns to
 * the model as "not judged" rather than counting it toward the pause.
 */

import {
    buildPayload,
    type ClassifyRequest,
    type ClassifyVerdict,
    parseSeverity,
    parseStage2,
    SEVERITY_THRESHOLD,
    stage1User,
    stage2User,
} from "./prompt";

/** A slow classifier stalls every shell call, so each stage's wait is capped. */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

export interface ClassifierCallResult {
    text: string;
    /** The AI SDK's finish reason; `length` means the reply was cut off. */
    finishReason: string;
}

/** One model call: the system prompt (cached for an hour) and one user message. */
export type ClassifierModelCall = (args: {
    system: string;
    user: string;
    maxOutputTokens: number;
    abortSignal: AbortSignal;
}) => Promise<ClassifierCallResult>;

export interface ClassifierDeps {
    call: ClassifierModelCall;
    /** The run's abort signal: a user stop cancels the classification. */
    signal?: AbortSignal;
    timeoutMs?: number;
    /** A debug trace of each verdict (the decision log carries the durable record). */
    onTrace?: (line: string) => void;
}

type StepKind = "timeout" | "cancelled" | "error" | "truncated";

class StepError extends Error {
    constructor(readonly kind: StepKind, message: string) {
        super(message);
    }
}

/** A signal that aborts when either input does (`AbortSignal.any` is not in this package's lib). */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (a.aborted) { return a; }
    if (b.aborted) { return b; }
    const controller = new AbortController();
    const abort = (source: AbortSignal) => () => controller.abort(source.reason);
    a.addEventListener("abort", abort(a), { once: true });
    b.addEventListener("abort", abort(b), { once: true });
    return controller.signal;
}

/** Whether an error message is a timeout or an equivalent abort, not a substantive failure. */
export function isClassifierTimeout(message: string): boolean {
    return /\babort|\btimed?\s*out\b|\btimeout\b|\betimedout\b|\bdeadline\b/i.test(message);
}

/** Classify one shell call. Never rejects. */
export async function classify(request: ClassifyRequest, deps: ClassifierDeps): Promise<ClassifyVerdict> {
    const { system, userPrefix, index } = buildPayload(request);
    const timeoutMs = deps.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const afterRuleDenial = request.transcript.some((entry) => entry.kind === "denied");

    const once = async (user: string, maxOutputTokens: number): Promise<ClassifierCallResult> => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const abortSignal = deps.signal ? eitherSignal(deps.signal, timeout) : timeout;
        try {
            return await deps.call({ system, user, maxOutputTokens, abortSignal });
        } catch (error) {
            if (deps.signal?.aborted) { throw new StepError("cancelled", "cancelled"); }
            const message = error instanceof Error ? error.message : String(error);
            if (timeout.aborted || isClassifierTimeout(message)) { throw new StepError("timeout", message); }
            throw new StepError("error", message);
        }
    };

    /** One stage: a timeout is retried once, a cut-off reply once with more room. */
    const stage = async (user: string, base: number, big: number): Promise<string> => {
        let result: ClassifierCallResult;
        try {
            result = await once(user, base);
        } catch (error) {
            if (!(error instanceof StepError) || error.kind !== "timeout") { throw error; }
            result = await once(user, base);
        }
        if (result.finishReason !== "length") { return result.text; }
        const retried = await once(user, big);
        if (retried.finishReason === "length") { throw new StepError("truncated", "verdict truncated at its output limit"); }
        return retried.text;
    };

    try {
        const s1 = await stage(stage1User(userPrefix), 64, 1024);
        const sev1 = parseSeverity(s1);
        if (sev1 !== null && sev1 < SEVERITY_THRESHOLD) {
            deps.onTrace?.(`[auto-mode] ${request.toolName} → allow [s1=${sev1}]`);
            return { decision: "allow", reason: "", tier: "allow" };
        }
        const s2 = await stage(stage2User(userPrefix, afterRuleDenial), 1024, 4096);
        let verdict = parseStage2(s2, index, request.userMessages);
        // Stage 1 flagged it and stage 2 cleared it citing nothing: an allow, tagged so the
        // decision log shows a clear that rests on nothing checkable.
        if (verdict.decision === "allow" && verdict.tier === "allow" && !verdict.ruleId) {
            verdict = { ...verdict, ruleId: "unverified-clear" };
        }
        deps.onTrace?.(`[auto-mode] ${request.toolName} → ${verdict.decision}${verdict.ruleId ? ` (${verdict.ruleId})` : ""} [s1=${sev1 ?? "?"} s2=${parseSeverity(s2) ?? "?"}]`);
        return verdict;
    } catch (error) {
        const kind: StepKind = error instanceof StepError ? error.kind : "error";
        const message = error instanceof Error ? error.message : String(error);
        switch (kind) {
            case "cancelled":
                return { decision: "block", reason: "Auto-mode classification was cancelled.", tier: "unmatched" };
            case "truncated":
                return {
                    decision: "block",
                    reason: "The approval classifier's reply was cut off before its verdict was complete.",
                    tier: "unmatched",
                };
            case "timeout":
                return {
                    decision: "block",
                    tier: "timeout",
                    reason: `Auto mode could not screen this ${request.toolName} call in time: the approval classifier timed out, so the call was not judged either way.`,
                };
            default:
                return { decision: "block", reason: `The auto-mode classifier could not be reached (${message}).`, tier: "unmatched" };
        }
    }
}
