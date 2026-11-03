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
 * The permission gate for one shell call:
 *
 *   safety floor → pre-gate → guarded file operations →
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
 * and the model client. For a PowerShell line it first awaits PowerShell's own
 * parse (`powershell-parser.ts`), which the decision then reads; with no parse
 * no PowerShell line is cleared.
 */

import { classifierNotJudgedText } from "./classifier";
import type { ClassifyVerdict } from "./prompt";
import { UNATTENDED_PROMPT_TIMEOUT_MS, type PauseTracker } from "./pause";
import { bashParserReady } from "./bash-parser";
import type { PowerShellParse } from "./powershell-parser";
import { powershellReadOnly } from "./powershell-rules";
import { powershellTreeContainedEdits } from "./powershell-tree";
import { powerShellParser } from "../shell/shell-spawn";
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
export type ShellAllowedBy = "pre-gate" | "file-operation" | "session-rule" | "classifier" | "user";

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
    /** Whether an undecided command should construct a session-rule suggestion. Defaults to true. */
    offerSessionRule?: boolean;
    /** The system temp directory holding the review baselines (floor target); `os.tmpdir()` when absent. */
    tmpDir?: string;
    /** Which shell the command is for; bash when absent. */
    shell?: "bash" | "powershell";
    /** The caller uses a capable model; permit guarded file operations in auto mode only. */
    allowContainedFileOperations?: boolean;
    /** PowerShell's own parse of a PowerShell line; without one the PowerShell pre-gate clears nothing. */
    powershellParse?: PowerShellParse;
}

/** `evidence` is the bash pre-gate's analysis; a PowerShell decision has none. */
export type ShellGateDecision =
    | { outcome: "allow"; layer: "pre-gate" | "file-operation" | "session-rule"; reason?: string; evidence?: ShellEvidence }
    | { outcome: "ask"; reasons: string[]; grant?: SessionRuleGrant; floor?: true; evidence?: ShellEvidence };

/**
 * Decide one PowerShell command: the textual floor, then the verdicts read
 * from PowerShell's own parse: a read-only line is cleared in both modes, and
 * Claude Code's acceptEdits cmdlets (`Set-Content`, `Add-Content`,
 * `Remove-Item`, `Clear-Content`) on the working space only where guarded file
 * operations are allowed (auto mode, a capable model). Without a parse
 * nothing is cleared. Session rules match the text, statement by statement.
 */
function decidePowerShellCommand(input: ShellGateInput): ShellGateDecision {
    const { command, cwd, home, readableRoots, writableRoots, sessionRules, tmpDir, powershellParse } = input;
    const floor = powershellFloorReason(command, { cwd, home, tmpDir });
    if (floor) {
        return { outcome: "ask", reasons: [`The command is always shown to you because ${floor}.`], floor: true };
    }
    const verdict = powershellReadOnly({ parse: powershellParse, cwd, home, readableRoots });
    if (verdict.readOnly) {
        return { outcome: "allow", layer: "pre-gate" };
    }
    if (input.allowContainedFileOperations && powershellParse && powershellTreeContainedEdits(powershellParse, { cwd, home, writableRoots }).ok) {
        return { outcome: "allow", layer: "file-operation", reason: "guarded in-workspace file operation" };
    }
    const context = { cwd, home, writableRoots };
    const rule = matchPowerShellSessionRule(sessionRules, command, context);
    if (rule) {
        return { outcome: "allow", layer: "session-rule", reason: `${rule.kind} rule \`${rule.command}\`` };
    }
    return {
        outcome: "ask",
        reasons: [verdict.reason ? `not a read-only command: ${verdict.reason}` : "not a read-only command"],
        grant: input.offerSessionRule === false ? undefined : suggestPowerShellSessionRule(command, context),
    };
}

/** Decide one command without asking anyone or calling a model. */
export function decideShellCommand(input: ShellGateInput): ShellGateDecision {
    if (input.shell === "powershell") { return decidePowerShellCommand(input); }
    const { command, cwd, home, readableRoots, writableRoots, sessionRules, tmpDir } = input;
    const evidence = analyzeShellCommand({ command, cwd, home, readableRoots, writableRoots });
    const floor = bashFloorReason(command, { cwd, home, tmpDir }, evidence);
    if (floor) {
        return { outcome: "ask", reasons: [`The command is always shown to you because ${floor}.`], floor: true, evidence };
    }
    if (evidence.verdict === "safe") {
        return { outcome: "allow", layer: "pre-gate", evidence };
    }
    const reasons = [...evidence.notes];
    // Only the analyzer's guarded mkdir/touch/rm/rmdir/mv/cp subset qualifies.
    // Git destruction is classified even when the checkout is clean.
    if (input.allowContainedFileOperations && evidence.containedNonNetwork) {
        return { outcome: "allow", layer: "file-operation", reason: "guarded in-workspace file operation", evidence };
    }
    const rule = matchSessionRule(sessionRules, command, evidence);
    if (rule) {
        return { outcome: "allow", layer: "session-rule", reason: `${rule.kind} rule \`${rule.command}\``, evidence };
    }
    return {
        outcome: "ask",
        reasons,
        grant: input.offerSessionRule === false ? undefined : suggestSessionRule(command, evidence, cwd),
        evidence,
    };
}

/** What the banner shows for one command. */
export interface ShellApprovalPrompt {
    command: string;
    /** Why the command is being asked about, one line each. */
    reasons: string[];
    /** The session rule the banner offers, when one is safe to offer. */
    grant?: SessionRuleGrant;
    /** Used only for the first consecutive-pause resume prompt. */
    timeoutMs?: number;
}

/** The user's answer. `allow-session` is only valid when the prompt carried a grant. */
export type ShellApprovalAnswer = "allow" | "deny" | "allow-session" | "timeout";

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
    /** Judges the command with the classifier (the caller builds the transcript), with the PowerShell parse when there is one. Never rejects. */
    classify: (command: string, powershellParse?: PowerShellParse) => Promise<ClassifyVerdict>;
    /** The thread's pause tracker. */
    pause: PauseTracker;
}

export interface ShellGateCallbacks {
    /** Shows the banner and resolves with the user's answer; an unanswered expiry is `timeout`. */
    ask: (prompt: ShellApprovalPrompt) => Promise<ShellApprovalAnswer>;
    /** Stores a granted rule for the rest of the session. */
    grantRule: (rule: SessionRule) => void;
    /** The classifier and pause state; required in auto mode. */
    auto?: AutoModeGate;
    /** Records every decision (the decision log). */
    onDecision?: (record: GateDecisionRecord) => void;
    /** The user declined a command: it enters the classifier's transcript as a denial. */
    onUserDenied?: (command: string) => void;
    /** PowerShell's own parse of a line, or undefined when it cannot be had; the shared parse server when absent. */
    parsePowerShell?: (command: string) => Promise<PowerShellParse | undefined>;
}

/**
 * PowerShell's own parse of a `powershell` call's line, from the shared parse
 * server on the tool's own executable (`shell/shell-spawn.ts
 * powerShellParser`). Undefined when the parser cannot answer (no PowerShell,
 * a timeout of 5 s on first start and 2 s after, a crash, Constrained
 * Language Mode): the gate then clears nothing and the line is classified or
 * asked about.
 */
export async function parsePowerShell(command: string): Promise<PowerShellParse | undefined> {
    const parser = powerShellParser();
    if (!parser) { return undefined; }
    const outcome = await parser.parse(command);
    return outcome.ok ? outcome.parse : undefined;
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
    // The PowerShell pre-gate judges a `git` statement with the bash git check, so both shells need the bash parser.
    await bashParserReady();
    if (input.shell === "powershell" && input.powershellParse === undefined) {
        input = { ...input, powershellParse: await (callbacks.parsePowerShell ?? parsePowerShell)(input.command) };
    }
    const auto = mode === "auto" ? callbacks.auto : undefined;
    // Session rules are an ask-mode convenience; auto mode never inherits them.
    const decision = decideShellCommand(mode === "auto"
        ? { ...input, sessionRules: [], offerSessionRule: false }
        : { ...input, allowContainedFileOperations: false });
    if (decision.outcome === "allow") {
        auto?.pause.recordAllow();
        callbacks.onDecision?.({ outcome: "allow", source: "pre-gate", reason: decision.reason ?? decision.layer });
        return { allowed: true, mayWrite: mayWrite(decision), by: decision.layer };
    }

    let reasons = decision.reasons;
    let grant = decision.grant;
    let timeoutMs: number | undefined;
    if (auto && !decision.floor) {
        if (!auto.pause.isPaused()) {
            const verdict = await auto.classify(input.command, input.powershellParse);
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
            if (verdict.noVerdict) {
                return { allowed: false, text: classifierNotJudgedText(verdict), by: "classifier" };
            }
            auto.pause.recordBlock({ toolName: input.shell === "powershell" ? "powershell" : "shell", subject: input.command, reason: verdict.reason, tier: verdict.tier, ruleId: verdict.ruleId, raw: verdict.raw });
            return { allowed: false, text: classifierBlockedText(verdict), by: "classifier", rule: verdict.ruleId ?? verdict.reason };
        }
        // Paused: this is the resume prompt, not a per-action approval.
        reasons = [pausedReason(auto.pause), ...reasons];
        if (auto.pause.takeTimedPrompt()) {
            timeoutMs = UNATTENDED_PROMPT_TIMEOUT_MS;
            reasons.push("This request is automatically declined after two minutes without an answer, so an unattended run can continue.");
        }
        grant = undefined;
    }
    if (decision.floor || auto) { grant = undefined; }

    let answer: ShellApprovalAnswer;
    try {
        answer = await callbacks.ask({ command: input.command, reasons, grant, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch {
        answer = "deny";
    }
    callbacks.onDecision?.({ outcome: answer === "deny" || answer === "timeout" ? "block" : "allow", source: "user", reason: answer === "timeout" ? "approval prompt expired" : decision.floor ? "floor" : undefined });
    if (answer === "timeout") {
        return { allowed: false, text: "The approval prompt expired without an answer. The command did not run. Continue with work that does not need approval; do not treat this as the user's permission or an explicit refusal.", by: "timeout" };
    }
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
