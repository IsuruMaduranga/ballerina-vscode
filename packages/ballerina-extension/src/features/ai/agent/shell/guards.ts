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
 * Pre-execution guards for the shell tool (pure). Ported from pincer-agent
 * `extensions/bash/guards.ts` (tip `2602e3c`) with BI's tool names in the
 * messages and without the monitor-tool pointer (BI has no monitor tool).
 *
 * Each guard recognises a workflow anti-pattern BEFORE the command runs and
 * refuses it with an instructive error: what tripped it, why it is a problem,
 * the sanctioned alternative, and a clause closing the obvious workaround.
 * These are steering, not security — the gate still applies to everything
 * that passes. A guard concludes only on a positive parse, so an unparseable
 * command always passes through.
 *
 * Guards, in order:
 * - interactive guard (foreground + background): a command that needs a TTY
 *   (`vim`, `git rebase -i`, `git add -p`, `watch`) hangs until the timeout —
 *   or silently no-ops — in this pipe-connected shell.
 * - wait guard (foreground): a command that LEADS with `sleep` exists only to
 *   wait. A provably short sleep (< 2 s) is pacing and passes; a sleep deeper
 *   in a chain is a pause inside real work and is left alone.
 * - poll-loop guard (foreground): a `while`/`until`/`for` loop that sleeps is
 *   the same stall spelled as a loop.
 * - orphan guard (foreground): `nohup`/`setsid`/a top-level `&` detaches a
 *   process nothing manages, losing its output and exit status. A command
 *   that ends with `wait` reaps its own children and passes.
 */

import { gitSubcommand, leadTokens, parseCommand, resolvePayload, type Segment, type Token } from "../auto-mode/shell-analysis";

export const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function bashGuardReason(command: string, opts: { background: boolean }): string | undefined {
    // A heredoc/here-string body is data, but parseCommand tokenizes it as live
    // shell — every guard would misfire on body text. Judge only the command
    // that PRECEDES the first `<<`: `sleep 600 <<< ""` is still a sleep, while
    // a `cat <<EOF` body is never read.
    const lead = command.split(/<</)[0];
    if (lead !== command && !lead.trim()) { return undefined; }
    const { segments, parseFailed } = parseCommand(lead);
    if (parseFailed || segments.length === 0) { return undefined; }
    const interactive = interactiveReason(segments);
    if (interactive || opts.background) { return interactive; }
    return waitReason(segments) ?? pollLoopReason(lead, segments) ?? orphanReason(lead, segments);
}

// ---------------------------------------------------------------------------
// Wait guard

/**
 * Seconds a `sleep` invocation provably lasts (GNU sleep sums multiple
 * duration arguments), or undefined when any argument is not a literal.
 */
function sleepSeconds(args: Token[]): number | undefined {
    if (args.length === 0) { return undefined; }
    let total = 0;
    for (const arg of args) {
        const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(arg.value);
        if (!match) { return undefined; }
        total += Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]] ?? 1);
    }
    return total;
}

/**
 * The wait guard's grammar-independent half, for the PowerShell guards to
 * share later: measure the run of LEADING sleep statements — `sleep 1 &&
 * sleep 1 && …` is one wait spelled as a chain, so the pacing exemption
 * applies only to a single provably short sleep. An unprovable duration
 * (`sleep "$DELAY"`) counts as long: the model controls the literal.
 * `sleepSeconds` returns null for a statement that is not a sleep.
 */
export function leadingSleepReason<T>(
    statements: T[],
    sleepSecondsOf: (statement: T) => number | undefined | null,
    raw: (statement: T) => string,
    opts: { sleepName: string; joiner: string },
): string | undefined {
    let leadSleeps = 0;
    let total: number | undefined = 0;
    for (const statement of statements) {
        const seconds = sleepSecondsOf(statement);
        if (seconds === null) { break; }
        leadSleeps++;
        total = total === undefined || seconds === undefined ? undefined : total + seconds;
    }
    if (leadSleeps === 0) { return undefined; }
    if (leadSleeps === 1 && total !== undefined && total < 2) { return undefined; }
    const rest = statements.slice(leadSleeps).map(raw).filter(Boolean).join("; ");
    const shown = statements.slice(0, leadSleeps).map(raw).join(opts.joiner);
    const echo = rest ? `\`${shown}\` followed by: ${clip(rest)}` : `standalone \`${shown}\``;
    return (
        `Blocked: ${echo}. A foreground ${opts.sleepName} holds up the whole turn while it runs. ` +
        "To wait for a command you started, run it with run_in_background: true — you are told when it finishes, so there is nothing to poll — " +
        "and call task_output with block: true only when your next step cannot go on without its result. " +
        "If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds. " +
        "Do not chain shorter sleeps to work around this block."
    );
}

function waitReason(segments: Segment[]): string | undefined {
    return leadingSleepReason(
        segments,
        (seg) => {
            const { command: cmd, args } = resolvePayload(leadTokens(seg));
            return cmd === "sleep" ? sleepSeconds(args) : null;
        },
        (seg) => seg.raw,
        { sleepName: "sleep", joiner: " && " },
    );
}

// ---------------------------------------------------------------------------
// Poll-loop guard

function pollLoopReason(command: string, segments: Segment[]): string | undefined {
    const first = leadTokens(segments[0])[0]?.value;
    if (first !== "while" && first !== "until" && first !== "for") { return undefined; }
    // `sleep` counts only in command position (segment lead, or right after a
    // `do`/`then`/`else` keyword) — `echo sleep` is data, not a wait.
    const sleeps = segments.some((seg) => resolvePayload(leadTokens(seg)).command === "sleep");
    if (!sleeps) { return undefined; }
    return (
        `Blocked: a foreground polling loop (\`${clip(command, 160)}\`). It holds up the whole turn while it spins. ` +
        "Start the underlying work with run_in_background: true and let its completion reach you on its own, or wait for it with task_output and block: true. " +
        "Do not shorten the sleep or unroll the loop to work around this block."
    );
}

// ---------------------------------------------------------------------------
// Orphan guard

/** True when the command backgrounds something with a top-level unquoted `&`. */
export function hasBackgroundAmp(command: string): boolean {
    let inSingle = false;
    let inDouble = false;
    let inAnsiC = false; // $'…' honors backslash-escaped quotes, unlike '…'
    let escape = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inAnsiC) {
            if (ch === "\\") { escape = true; } else if (ch === "'") { inAnsiC = false; }
            continue;
        }
        if (ch === "'" && !inSingle && !inDouble && command[i - 1] === "$") {
            inAnsiC = true;
            continue;
        }
        if (ch === "\\" && !inSingle) {
            escape = true;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (inSingle || inDouble || ch !== "&") { continue; }
        const prev = command[i - 1];
        const next = command[i + 1];
        if (next === "&") {
            i++; // logical &&
            continue;
        }
        if (next === ">") { continue; } // &> redirect
        if (prev === ">" || prev === "|") { continue; } // 2>&1 fd duplication, |& pipe
        return true;
    }
    return false;
}

function orphanReason(command: string, segments: Segment[]): string | undefined {
    const message = (via: string) =>
        `Blocked: this command detaches a process with ${via}, leaving an orphan nothing can manage — its output and exit status would be lost. ` +
        "Run it with run_in_background: true instead: it returns a task id at once, you are told when it finishes, task_output reads its output and kill_task stops it. " +
        "To start a Ballerina service, use runBallerinaPackage. " +
        "If you need shell-level parallelism inside one command, end it with `wait` so the children are reaped.";

    for (const seg of segments) {
        const { peeled } = resolvePayload(leadTokens(seg));
        const detacher = peeled.find((p) => p === "nohup" || p === "setsid");
        if (detacher) { return message(`\`${detacher}\``); }
    }
    // Only a `wait` that comes LAST reaps the children — `wait; job &` still
    // orphans the job it precedes.
    const lastCmd = resolvePayload(leadTokens(segments[segments.length - 1])).command;
    if (hasBackgroundAmp(command) && lastCmd !== "wait") { return message("`&`"); }
    return undefined;
}

// ---------------------------------------------------------------------------
// Interactive guard

const EDITORS = new Set(["vi", "vim", "nvim", "view", "vimdiff", "nano", "pico", "emacs"]);

function interactiveReason(segments: Segment[]): string | undefined {
    for (const seg of segments) {
        const { command: cmd, args } = resolvePayload(leadTokens(seg));
        if (EDITORS.has(cmd)) {
            if (cmd === "emacs" && args.some((a) => ["--batch", "-batch", "--script"].includes(a.value))) { continue; }
            return (
                `Blocked: \`${cmd}\` is an interactive editor and this shell has no terminal — it would hang until the timeout. ` +
                "Read files with file_read and change them with file_edit or file_write."
            );
        }
        if (cmd === "watch") {
            return (
                "Blocked: `watch` needs an interactive terminal, which this shell does not have. " +
                "Run the command with run_in_background: true and read its output with task_output instead."
            );
        }
        if (cmd !== "git") { continue; }
        const { sub, rest } = gitSubcommand(args);
        const flags = new Set(rest.map((t) => t.value));
        if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
            return (
                "Blocked: `git rebase -i` opens an interactive editor, which this shell cannot provide — it would hang until the timeout. " +
                "Drive it non-interactively instead: `GIT_SEQUENCE_EDITOR=: git rebase …` accepts the todo list as-is, or restructure history with `git rebase --onto`, `git commit --amend`, or `git cherry-pick`."
            );
        }
        if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((f) => flags.has(f))) {
            return (
                "Blocked: interactive `git add` prompts on a terminal this shell does not have — it would read end-of-file and stage nothing while appearing to succeed. " +
                "Stage whole files with `git add <paths>`, or stage a partial change non-interactively with `git apply --cached` and a crafted diff."
            );
        }
    }
    return undefined;
}
