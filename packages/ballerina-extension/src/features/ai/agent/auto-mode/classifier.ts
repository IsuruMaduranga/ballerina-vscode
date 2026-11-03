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
 * The two-stage classifier call. There is no candidate-chain fallback: the
 * WSO2 Integrator Copilot has one model per login method, so the caller
 * supplies the one model call (`ClassifierModelCall`, Sonnet through
 * `getAnthropicClient` in production, a fake in tests).
 *
 *   Stage 1 grades HARM ONLY (64 output tokens). Severity below 50 allows,
 *   with no stage 2.
 *   Stage 2 applies user intent and the ALLOW exceptions (4096 tokens), must
 *   cite a rule to block, and must quote the user to clear on intent.
 *
 * Both stages share the system prompt and transcript byte for byte, and the
 * user message goes as stable blocks with a cache breakpoint after the
 * history (classifier-cache.ts), so stage 2 and the next gated command read
 * the history stage 1 wrote. A reply cut off at its limit is retried once
 * with more room (1024 for stage 1, 8192 for stage 2).
 *
 * The model call retries rate limits and server errors itself, inside the
 * stage timeout. A timeout, or a failure below HTTP (the request never got an
 * answer), is retried once (after a short pause for a network failure) and
 * then reported as its own tier, which the gate returns to the model as "not
 * judged" rather than counting it toward the pause. Every other failure
 * blocks as not judged too: no credentials, a provider error, a transcript
 * the provider cannot fit (never clipped to fit), a truncated or unparseable
 * reply.
 */

import type { ClassifierCacheState, ClassifierUserText } from "./classifier-cache";
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
import { actionLength, MAX_ACTION_CHARS } from "./transcript";

/** A slow classifier stalls every shell call, so each stage's wait is capped. */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

/**
 * How many times the model call retries a rate limit (429), a conflict or
 * request timeout (409, 408) or a server error (5xx), with backoff. One 429
 * otherwise left the command unjudged; the stage timeout still bounds it.
 */
export const CLASSIFIER_MAX_RETRIES = 10;

/** Pause before retrying after a network failure, so a brief drop can clear. */
export const TRANSPORT_RETRY_DELAY_MS = 1500;

export interface ClassifierCallResult {
    text: string;
    /** The AI SDK's finish reason; `length` means the reply was cut off. */
    finishReason: string;
}

/** One model call: the system prompt (cached for an hour) and one user message. */
export type ClassifierModelCall = (args: {
    system: string;
    /** The user message's whole text. */
    user: string;
    /** The same text as its stable blocks, with where the cache breakpoints go. */
    userParts: ClassifierUserText;
    maxOutputTokens: number;
    abortSignal: AbortSignal;
}) => Promise<ClassifierCallResult>;

export interface ClassifierDeps {
    call: ClassifierModelCall;
    /** The run's abort signal: a user stop cancels the classification. */
    signal?: AbortSignal;
    timeoutMs?: number;
    /** The pause before the one retry after a network failure (tests shorten it). */
    transportRetryDelayMs?: number;
    /** The thread's cache hint, kept by the caller between calls and updated here. */
    cache?: ClassifierCacheState;
    /** A debug trace of each verdict (the decision log carries the durable record). */
    onTrace?: (line: string) => void;
}

type StepKind = "timeout" | "cancelled" | "error" | "truncated" | "transcript-too-long";

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

/**
 * Whether a failure happened below HTTP: the request never got an answer (a
 * failed fetch, a reset or refused connection, a DNS miss). Like a timeout it
 * says nothing about the command, so it takes the timeout path: one retry,
 * then "not judged". A provider's own error reply (a 500, a 429) is not one.
 */
export function isTransportFailure(message: string): boolean {
    return /\bfetch failed\b|\bfailed to fetch\b|cannot connect to api\b|\becon(nreset|nrefused|naborted)\b|\benotfound\b|\beai_again\b|\bepipe\b|socket hang up|other side closed|\bund_err_socket\b|network (error|is unreachable)/i.test(
        message,
    );
}

/**
 * Whether the provider refused the request because the input does not fit its
 * context window, not because of the command or the reply's length.
 */
export function isTranscriptTooLong(message: string): boolean {
    return /prompt is too long|input is too long|too many (input )?tokens|exceeds? (the )?(model'?s? )?(maximum )?context (window|length|limit)|exceed context limit|context[_ ]length[_ ]exceeded|maximum context length/i.test(
        message,
    );
}

/**
 * A provider's error without its advice to the user ("Please try again with a
 * different prompt", "try rephrasing your request", a link): handed to the
 * agent, that advice invites rephrasing the command past the gate.
 */
export function providerErrorSummary(message: string): string {
    // Advice follows a sentence end, a colon or semicolon, or a line break.
    const cut = message.search(/(?:[.!:;]\s+|\n\s*)(please\b|if this seems|try\b|you can\b|learn more|see\b)/i);
    const kept = cut >= 0 ? message.slice(0, cut + 1) : message;
    return kept.replace(/:?\s*https?:\/\/\S+/g, "").trim().replace(/[:;]$/, "");
}

/** Wait `ms`, or less when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) { return resolve(); }
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}

/** Classify one shell call. Never rejects. */
export async function classify(request: ClassifyRequest, deps: ClassifierDeps): Promise<ClassifyVerdict> {
    const actionChars = actionLength(request.transcript);
    if (actionChars > MAX_ACTION_CHARS) {
        return {
            decision: "block",
            reason: `This call is ${actionChars} characters, more than the ${MAX_ACTION_CHARS} the auto-mode classifier reviews in full. Split it into smaller calls.`,
            tier: "unmatched",
            noVerdict: true,
        };
    }
    const { system, userPrefix, history, tail, index } = buildPayload(request);
    const timeoutMs = deps.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const afterRuleDenial = request.transcript.some((entry) => entry.kind === "denied");
    const historyEnd = history.length - 1;

    const once = async (user: string, maxOutputTokens: number): Promise<ClassifierCallResult> => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const abortSignal = deps.signal ? eitherSignal(deps.signal, timeout) : timeout;
        const userParts: ClassifierUserText = {
            parts: [...history, tail, user.slice(userPrefix.length)],
            historyEnd,
            previousHistoryEnd: deps.cache?.historyEnd,
        };
        try {
            return await deps.call({ system, user, userParts, maxOutputTokens, abortSignal });
        } catch (error) {
            if (deps.signal?.aborted) { throw new StepError("cancelled", "cancelled"); }
            const message = error instanceof Error ? error.message : String(error);
            if (timeout.aborted || isClassifierTimeout(message) || isTransportFailure(message)) { throw new StepError("timeout", message); }
            if (isTranscriptTooLong(message)) { throw new StepError("transcript-too-long", message); }
            throw new StepError("error", message);
        } finally {
            // Sent: the next call can look this history up by its end.
            if (deps.cache) { deps.cache.historyEnd = historyEnd; }
        }
    };

    /** One stage: a timeout or network failure is retried once, a cut-off reply once with more room. */
    const stage = async (user: string, base: number, big: number): Promise<string> => {
        let result: ClassifierCallResult;
        try {
            result = await once(user, base);
        } catch (error) {
            if (!(error instanceof StepError) || error.kind !== "timeout") { throw error; }
            if (isTransportFailure(error.message)) {
                await pause(deps.transportRetryDelayMs ?? TRANSPORT_RETRY_DELAY_MS, deps.signal);
                if (deps.signal?.aborted) { throw new StepError("cancelled", "cancelled"); }
            }
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
        const s2 = await stage(stage2User(userPrefix, afterRuleDenial), 4096, 8192);
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
                return { decision: "block", reason: "Auto-mode classification was cancelled.", tier: "unmatched", noVerdict: true };
            case "truncated":
                return {
                    decision: "block",
                    reason: "The approval classifier's reply was cut off before its verdict was complete.",
                    tier: "unmatched",
                    noVerdict: true,
                };
            case "transcript-too-long":
                // The provider is authoritative about its window. The history is
                // not clipped to fit: a verdict on part of the chat is not one.
                return {
                    decision: "block",
                    reason: "This chat's history is longer than the approval classifier's context window, so the command was not judged. A new chat starts a new history.",
                    tier: "unmatched",
                    noVerdict: true,
                    transcriptTooLong: true,
                };
            case "timeout": {
                const network = isTransportFailure(message);
                return {
                    decision: "block",
                    tier: "timeout",
                    noVerdict: true,
                    reason: `Auto mode could not screen this ${request.toolName} call${network ? "" : " in time"}: the approval classifier is temporarily unavailable (${network ? `network error: ${providerErrorSummary(message)}` : "timed out"}), so the call was not judged either way.`,
                };
            }
            default:
                return { decision: "block", reason: `The auto-mode classifier returned no verdict (${providerErrorSummary(message)}).`, tier: "unmatched", noVerdict: true };
        }
    }
}

/**
 * The text the agent receives for a command the classifier never judged
 * (a provider error, a cut-off or unreadable reply, a transcript too long):
 * not a denial, and nothing to route around.
 */
export function classifierNotJudgedText(verdict: ClassifyVerdict): string {
    return (
        `${verdict.reason}\n\n` +
        "This is not a judgement that the command is unsafe: the safety check gave no verdict, so the command did not run. " +
        "Do not rephrase it or route around the check. Continue with work that does not need this command " +
        "(file reads and plain read-only commands do not need the check). If the command is essential, tell the user what you were about to run and why."
    );
}
