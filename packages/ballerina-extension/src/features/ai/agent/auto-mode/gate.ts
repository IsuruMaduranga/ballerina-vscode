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
 * The permission gate for one shell call (design §3), ask-mode branch only:
 *
 *   pre-gate (`shell-analysis.ts`) → git recoverability (`recoverability.ts`)
 *   → a session rule the user granted → the approval banner.
 *
 * The safety floor and the classifier are Phase B. Until they land nothing
 * skips the banner except a pre-gate "safe", a recoverable in-workspace
 * delete, or a rule the user granted from an earlier banner. Every layer here
 * can only allow; none can deny, so a gap in any of them costs one prompt.
 *
 * The decision itself is `decideShellCommand` (synchronous; the only I/O is
 * the pre-gate's path resolution and the recoverability judge's git queries).
 * `authorizeShellCommand` wraps it with the banner, which the caller supplies,
 * so this module stays free of `vscode` and the approval manager.
 */

import { checkRecoverability } from "./recoverability";
import { addSessionRule, matchSessionRule, suggestSessionRule, type SessionRule, type SessionRuleGrant } from "./session-rules";
import { analyzeShellCommand, type ShellEvidence } from "./shell-analysis";

export type { SessionRule, SessionRuleGrant };

/**
 * The gate's answer to the shell tool: run, or return this text to the model
 * instead. `mayWrite` is false only when the pre-gate proved the command
 * writes nothing, so the tool can skip its touched-file scan.
 */
export type ShellAuthorization = { allowed: true; mayWrite: boolean } | { allowed: false; text: string };

/** Whether a cleared command may still change workspace files: only a pre-gate read with no write target cannot. */
function mayWrite(decision: ShellGateDecision): boolean {
    return !(decision.outcome === "allow" && decision.layer === "pre-gate" && decision.evidence.writes.length === 0);
}

export interface ShellGateInput {
    command: string;
    /** The workspace root the command runs in. */
    cwd: string;
    home: string;
    /** `readable-roots.ts`, resolved once per run. */
    readableRoots: string[];
    /** The thread's scratchpad (resolved): writes there count as contained. */
    writableRoots: string[];
    /** Rules the user granted from earlier banners in this session. */
    sessionRules: readonly SessionRule[];
}

export type ShellGateDecision =
    | { outcome: "allow"; layer: "pre-gate" | "recoverability" | "session-rule"; reason?: string; evidence: ShellEvidence }
    | { outcome: "ask"; reasons: string[]; grant?: SessionRuleGrant; evidence: ShellEvidence };

/** Decide one bash command without asking anyone. */
export function decideShellCommand(input: ShellGateInput): ShellGateDecision {
    const { command, cwd, home, readableRoots, writableRoots, sessionRules } = input;
    const evidence = analyzeShellCommand({ command, cwd, home, readableRoots, writableRoots });
    if (evidence.verdict === "safe") {
        return { outcome: "allow", layer: "pre-gate", evidence };
    }
    const reasons = [...evidence.notes];
    // The only risk is an in-workspace delete or a whole-tree reset: it runs when
    // git can put the bytes back (non-repo, dirty, untracked or ignored content is
    // unrecoverable and asks).
    if (evidence.containedNonNetwork) {
        const targets = evidence.writes.filter((write) => !write.outsideCwd && write.resolved).map((write) => write.resolved as string);
        const recoverability = checkRecoverability(cwd, { targets, wholeTree: evidence.wholeTree });
        if (recoverability.verdict === "recoverable") {
            return { outcome: "allow", layer: "recoverability", reason: recoverability.reason, evidence };
        }
        reasons.push(`git recoverability: ${recoverability.reason}`);
    }
    const rule = matchSessionRule(sessionRules, command, evidence);
    if (rule) {
        return { outcome: "allow", layer: "session-rule", reason: `${rule.kind} rule \`${rule.command}\``, evidence };
    }
    return { outcome: "ask", reasons, grant: suggestSessionRule(command, evidence, cwd), evidence };
}

/** What the banner shows for one command. */
export interface ShellApprovalPrompt {
    command: string;
    /** Why the command was not cleared, one line each, from the gate's evidence. */
    reasons: string[];
    /** The session rule the banner offers, when one is safe to offer. */
    grant?: SessionRuleGrant;
}

/** The user's answer. `allow-session` is only valid when the prompt carried a grant. */
export type ShellApprovalAnswer = "allow" | "deny" | "allow-session";

export interface ShellGateCallbacks {
    /** Shows the banner and resolves with the user's answer (a timeout or abort is `deny`). */
    ask: (prompt: ShellApprovalPrompt) => Promise<ShellApprovalAnswer>;
    /** Stores a granted rule for the rest of the session. */
    grantRule: (rule: SessionRule) => void;
    /** Observes every decision (the decision log in Phase B). */
    onDecision?: (decision: ShellGateDecision, answer?: ShellApprovalAnswer) => void;
}

/** The text the model receives when the user declines a command. */
export function deniedText(command: string): string {
    return (
        `The user declined to run this command: ${command}\n\n` +
        "It did not run. Do not retry it or work around it with a different command that has the same effect. " +
        "If the task needs it, say so and ask the user how to proceed; otherwise continue with other work."
    );
}

/** Decide, and ask the user when the gate cannot clear the command. Never rejects: a failed prompt denies. */
export async function authorizeShellCommand(input: ShellGateInput, callbacks: ShellGateCallbacks): Promise<ShellAuthorization> {
    const decision = decideShellCommand(input);
    if (decision.outcome === "allow") {
        callbacks.onDecision?.(decision);
        return { allowed: true, mayWrite: mayWrite(decision) };
    }
    let answer: ShellApprovalAnswer;
    try {
        answer = await callbacks.ask({ command: input.command, reasons: decision.reasons, grant: decision.grant });
    } catch {
        answer = "deny";
    }
    callbacks.onDecision?.(decision, answer);
    if (answer === "deny") {
        return { allowed: false, text: deniedText(input.command) };
    }
    if (answer === "allow-session" && decision.grant) {
        callbacks.grantRule(decision.grant.rule);
    }
    return { allowed: true, mayWrite: true };
}

/**
 * The session rules of one thread, kept in memory. "Session" is the chat
 * thread for as long as the extension host runs: rules never reach disk, so a
 * window reload or a new thread starts with none.
 */
export class SessionRuleStore {
    private readonly rules = new Map<string, SessionRule[]>();

    get(threadKey: string): readonly SessionRule[] {
        return this.rules.get(threadKey) ?? [];
    }

    add(threadKey: string, rule: SessionRule): void {
        this.rules.set(threadKey, addSessionRule(this.get(threadKey), rule));
    }

    clear(threadKey: string): void {
        this.rules.delete(threadKey);
    }
}

export const sessionRuleStore = new SessionRuleStore();
