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
 * The permission gate for one shell call (design §2, §3):
 *
 *   safety floor → pre-gate → git recoverability →
 *     ask mode:  a session rule the user granted → the approval banner
 *     auto mode: the classifier (a block goes back to the model) → the
 *                banner only once repeated blocks have paused auto mode
 *
 * The floor may only stop, and sends the call to the banner in both modes; it
 * never reaches the classifier and never gets a session rule. The other
 * deterministic layers may only allow. In auto mode a classifier block is
 * returned to the model with the reason; three consecutive or twenty total
 * blocks pause auto mode, and the next undecided call asks the user, whose
 * approval resumes it. A classifier timeout is returned as "not judged" and
 * does not count toward the pause.
 *
 * `decideShellCommand` is the synchronous deterministic part.
 * `authorizeShellCommand` adds the banner and the classifier, both supplied
 * by the caller, so this module stays free of `vscode`, the approval manager
 * and the model client.
 */

import type { ClassifyVerdict } from "./prompt";
import type { PauseTracker } from "./pause";
import { checkRecoverability } from "./recoverability";
import { powershellReadOnly } from "./powershell-rules";
import { bashFloorReason, powershellFloorReason } from "./safety-floor";
import {
    addSessionRule,
    matchPowerShellSessionRule,
    matchSessionRule,
    suggestPowerShellSessionRule,
    suggestSessionRule,
    type SessionRule,
    type SessionRuleGrant,
} from "./session-rules";
import { analyzeShellCommand, type ShellEvidence } from "./shell-analysis";

export type { SessionRule, SessionRuleGrant };

/** Ask every undecided command, or let the classifier judge it (the default). */
export type ShellMode = "auto" | "ask";

/** Who let a command run, for the tool row and the decision log. */
export type ShellAllowedBy = "pre-gate" | "recoverability" | "session-rule" | "classifier" | "user";

/**
 * The gate's answer to the shell tool: run, or return this text to the model
 * instead. `mayWrite` is false only when the pre-gate proved the command
 * writes nothing, so the tool can skip its touched-file scan.
 */
export type ShellAuthorization =
    | { allowed: true; mayWrite: boolean; by: ShellAllowedBy }
    | { allowed: false; text: string; by: "user" | "classifier" | "timeout"; rule?: string };

/** Whether a cleared command may still change workspace files: only a pre-gate read with no write target cannot. */
function mayWrite(decision: ShellGateDecision): boolean {
    return !(decision.outcome === "allow" && decision.layer === "pre-gate" && (decision.evidence?.writes.length ?? 0) === 0);
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
    /** Rules the user granted from earlier banners in this session (ask mode only). */
    sessionRules: readonly SessionRule[];
    /** The system temp directory holding the review baselines (floor target); `os.tmpdir()` when absent. */
    tmpDir?: string;
    /** Which shell the command is for; bash when absent. */
    shell?: "bash" | "powershell";
}

/** `evidence` is the bash pre-gate's analysis; a PowerShell decision has none. */
export type ShellGateDecision =
    | { outcome: "allow"; layer: "pre-gate" | "recoverability" | "session-rule"; reason?: string; evidence?: ShellEvidence }
    | { outcome: "ask"; reasons: string[]; grant?: SessionRuleGrant; floor?: true; evidence?: ShellEvidence };

/**
 * Decide one PowerShell command (design §6): the textual floor, then the
 * read-only allowlist as the only pre-gate. There is no containment fast path
 * and no recoverability judge, so an in-workspace `Remove-Item` is judged,
 * never cleared deterministically.
 */
function decidePowerShellCommand(input: ShellGateInput): ShellGateDecision {
    const { command, cwd, home, readableRoots, sessionRules, tmpDir } = input;
    const floor = powershellFloorReason(command, { cwd, home, tmpDir });
    if (floor) {
        return { outcome: "ask", reasons: [`The command is always shown to you because ${floor}.`], floor: true };
    }
    const verdict = powershellReadOnly(command, { cwd, home, readableRoots });
    if (verdict.readOnly) {
        return { outcome: "allow", layer: "pre-gate" };
    }
    const rule = matchPowerShellSessionRule(sessionRules, command);
    if (rule) {
        return { outcome: "allow", layer: "session-rule", reason: `exact rule \`${rule.command}\`` };
    }
    return { outcome: "ask", reasons: [verdict.reason ? `not a read-only command: ${verdict.reason}` : "not a read-only command"], grant: suggestPowerShellSessionRule(command) };
}

/** Decide one command without asking anyone or calling a model. */
export function decideShellCommand(input: ShellGateInput): ShellGateDecision {
    if (input.shell === "powershell") { return decidePowerShellCommand(input); }
    const { command, cwd, home, readableRoots, writableRoots, sessionRules, tmpDir } = input;
    const evidence = analyzeShellCommand({ command, cwd, home, readableRoots, writableRoots });
    const floor = bashFloorReason(command, { cwd, home, tmpDir });
    if (floor) {
        return { outcome: "ask", reasons: [`The command is always shown to you because ${floor}.`], floor: true, evidence };
    }
    if (evidence.verdict === "safe") {
        return { outcome: "allow", layer: "pre-gate", evidence };
    }
    const reasons = [...evidence.notes];
    // The only risk is an in-workspace delete or a whole-tree reset: it runs when
    // git can put the bytes back (non-repo, dirty, untracked or ignored content is
    // unrecoverable and continues).
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
    /** Why the command is being asked about, one line each. */
    reasons: string[];
    /** The session rule the banner offers, when one is safe to offer. */
    grant?: SessionRuleGrant;
}

/** The user's answer. `allow-session` is only valid when the prompt carried a grant. */
export type ShellApprovalAnswer = "allow" | "deny" | "allow-session";

/** One gate decision for the decision log (`decision-log.ts decisionEntry` adds the time and clips). */
export interface GateDecisionRecord {
    outcome: "allow" | "block" | "prompt";
    source: "pre-gate" | "classifier" | "floor" | "user";
    tier?: string;
    ruleId?: string;
    reason?: string;
    raw?: string;
}

export interface AutoModeGate {
    /** Judges the command with the classifier (the caller builds the transcript). Never rejects. */
    classify: (command: string) => Promise<ClassifyVerdict>;
    /** The thread's pause tracker. */
    pause: PauseTracker;
}

export interface ShellGateCallbacks {
    /** Shows the banner and resolves with the user's answer (a timeout or abort is `deny`). */
    ask: (prompt: ShellApprovalPrompt) => Promise<ShellApprovalAnswer>;
    /** Stores a granted rule for the rest of the session. */
    grantRule: (rule: SessionRule) => void;
    /** The classifier and pause state; required in auto mode. */
    auto?: AutoModeGate;
    /** Records every decision (the decision log). */
    onDecision?: (record: GateDecisionRecord) => void;
    /** The user declined a command: it enters the classifier's transcript as a denial. */
    onUserDenied?: (command: string) => void;
}

/** The text the model receives when the user declines a command. */
export function deniedText(command: string): string {
    return (
        `The user declined to run this command: ${command}\n\n` +
        "It did not run. Do not retry it or work around it with a different command that has the same effect. " +
        "If the task needs it, say so and ask the user how to proceed; otherwise continue with other work."
    );
}

/** The text the model receives when the classifier blocks a command in auto mode. */
export function classifierBlockedText(verdict: ClassifyVerdict): string {
    const hard = verdict.tier === "hard_deny";
    return (
        `Auto mode did not run this command. The safety check blocked it: ${verdict.reason}\n\n` +
        (hard
            ? "This is a boundary the user's approval does not move in auto mode. "
            : "If the user explicitly asks for this exact action on this target, it can be cleared then. ") +
        "Do not try to get the same effect another way. Continue with work that does not need it, or tell the user what you wanted to do and why and let them decide."
    );
}

/** The text the model receives when the classifier timed out. */
export function classifierTimeoutText(verdict: ClassifyVerdict): string {
    return (
        `${verdict.reason}\n\n` +
        "This is not a judgement that the command is unsafe. Try it again in a moment. If it keeps failing, continue with other work " +
        "(file reads and plain read-only commands do not need the check) and tell the user if this command is essential."
    );
}

/** The banner reason when auto mode is paused. */
export function pausedReason(pause: PauseTracker): string {
    const { lifetime } = pause.stats();
    return `Auto mode is paused after ${lifetime} blocked command${lifetime === 1 ? "" : "s"}. Allowing this command resumes it.`;
}

/** Decide, classify or ask. Never rejects: a failed prompt denies. */
export async function authorizeShellCommand(input: ShellGateInput, mode: ShellMode, callbacks: ShellGateCallbacks): Promise<ShellAuthorization> {
    const auto = mode === "auto" ? callbacks.auto : undefined;
    // Session rules are an ask-mode convenience; in auto mode the classifier is the boundary.
    const decision = decideShellCommand(auto ? { ...input, sessionRules: [] } : input);
    if (decision.outcome === "allow") {
        callbacks.onDecision?.({ outcome: "allow", source: "pre-gate", reason: decision.reason ?? decision.layer });
        return { allowed: true, mayWrite: mayWrite(decision), by: decision.layer };
    }

    let reasons = decision.reasons;
    let grant = decision.grant;
    if (auto && !decision.floor) {
        if (!auto.pause.isPaused()) {
            const verdict = await auto.classify(input.command);
            const record = { source: "classifier" as const, tier: verdict.tier, ruleId: verdict.ruleId, reason: verdict.reason || undefined, raw: verdict.raw };
            if (verdict.decision === "allow") {
                auto.pause.recordAllow();
                callbacks.onDecision?.({ ...record, outcome: "allow" });
                return { allowed: true, mayWrite: true, by: "classifier" };
            }
            callbacks.onDecision?.({ ...record, outcome: "block" });
            if (verdict.tier === "timeout") {
                return { allowed: false, text: classifierTimeoutText(verdict), by: "timeout" };
            }
            auto.pause.recordBlock({ toolName: input.shell === "powershell" ? "powershell" : "shell", subject: input.command, reason: verdict.reason, tier: verdict.tier, ruleId: verdict.ruleId, raw: verdict.raw });
            return { allowed: false, text: classifierBlockedText(verdict), by: "classifier", rule: verdict.ruleId ?? verdict.reason };
        }
        // Paused: this is the resume prompt, not a per-action approval.
        reasons = [pausedReason(auto.pause), ...reasons];
        grant = undefined;
    }
    if (decision.floor || auto) { grant = undefined; }

    let answer: ShellApprovalAnswer;
    try {
        answer = await callbacks.ask({ command: input.command, reasons, grant });
    } catch {
        answer = "deny";
    }
    callbacks.onDecision?.({ outcome: answer === "deny" ? "block" : "allow", source: "user", reason: decision.floor ? "floor" : undefined });
    if (answer === "deny") {
        callbacks.onUserDenied?.(input.command);
        return { allowed: false, text: deniedText(input.command), by: "user" };
    }
    // Approving a prompt is what resumes a paused auto mode.
    auto?.pause.resume();
    if (answer === "allow-session" && grant) {
        callbacks.grantRule(grant.rule);
    }
    return { allowed: true, mayWrite: true, by: "user" };
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
