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
 * The shared body of the shell tool (`shell` for bash; `powershell` in Phase
 * B2), in the shape of pincer-agent's `extensions/lib/shell-tool.ts`
 * `registerShellTool` (tip `2602e3c`): guard → millisecond timeout clamp →
 * foreground run, or a background task on the shared registry. Each tool
 * supplies what differs (its name, spawn, guard and command wrapper); this
 * module owns the orchestration.
 *
 * Pure apart from starting processes and writing log files: no `ai`, `zod` or
 * `vscode` import, so the Jest suite drives it directly. The AI SDK tool that
 * wraps it is `tools/shell-tool.ts`. The permission gate is not here: the
 * caller authorizes a command before calling `runShellCall`.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { generateTaskId } from "../background/types";
import { startBackgroundShell } from "./background";
import { tailCap } from "./output";
import { clampTimeoutMs, finishLine, type RunSummary, runProcess } from "./runner";
import { shellLaunch, type ShellSpawn } from "./shell-spawn";

/** Claude Code's default for a foreground call without a `timeout`. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The most output a foreground result carries (Claude Code's 30,000). Past it
 * the full output goes to a file in the scratchpad and the result keeps the tail.
 */
export const FOREGROUND_OUTPUT_CAP = 30_000;

/** The model-facing parameters, Claude Code's Bash tool shape. */
export interface ShellCallParams {
    command: string;
    description?: string;
    /** Milliseconds, at most `MAX_TIMEOUT_MS`. */
    timeout?: number;
    run_in_background?: boolean;
}

export interface ShellCallContext {
    /** The tool's registered name (`shell`, `powershell`). */
    toolName: string;
    /** How the model sees the shell in messages (`Bash`, `PowerShell`). */
    label: string;
    /** The resolved shell, or undefined when none resolves on this machine. */
    spawn: ShellSpawn | undefined;
    /** Steering guard on the model's command; a string refuses the call. */
    guard: (command: string, opts: { background: boolean }) => string | undefined;
    /** Rewrites the command before it is spawned (PowerShell's UTF-8 prefix). Default: identity. */
    wrapCommand?: (command: string) => string;
    /** The workspace root. */
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** The run the call belongs to (`subagents/types.ts buildRunKey`). */
    runKey: string;
    toolCallId: string;
    /** The run's abort signal: it stops a foreground command and every background task the run started. */
    signal?: AbortSignal;
    /** The thread's scratchpad (`shell/scratchpad.ts`): task logs and spilled output go under it. */
    scratchpadDir?: string;
    /** Called once when a background command finishes on its own (the touched-file scan). */
    onBackgroundFinished?: () => void;
}

export type ShellCallResult =
    | { kind: "refused"; text: string }
    | { kind: "foreground"; text: string; summary: RunSummary; timeoutMs: number; outputFile?: string }
    | { kind: "background"; text: string; taskId: string; logPath?: string };

/** `<scratchpad>/tasks/<taskId>/output.log`, its directory created; undefined without a scratchpad or when it cannot be created. */
export function taskLogPath(scratchpadDir: string | undefined, taskId: string): string | undefined {
    if (!scratchpadDir) { return undefined; }
    try {
        const dir = join(scratchpadDir, "tasks", taskId);
        mkdirSync(dir, { recursive: true });
        return join(dir, "output.log");
    } catch {
        return undefined;
    }
}

/**
 * The model-facing text of a finished foreground call: the output, headed by
 * how the command ended unless it succeeded, and a pointer to the full output
 * when only the tail is shown.
 */
export function foregroundText(summary: RunSummary, timeoutMs: number, spill?: { path: string; length: number }): string {
    const line = finishLine(summary, timeoutMs);
    const head =
        line === "completed" ? ""
            : line === "stopped" ? "Command stopped: the run was aborted.\n\n"
                : `Command ${line}.\n\n`;
    const output = summary.output.length > FOREGROUND_OUTPUT_CAP ? tailCap(summary.output, FOREGROUND_OUTPUT_CAP) : summary.output;
    const note = summary.output.length > FOREGROUND_OUTPUT_CAP
        ? spill
            ? `\n\n[Output was ${spill.length} characters; the last ${FOREGROUND_OUTPUT_CAP} are shown above. The full output is in ${spill.path}.]`
            : `\n\n[Output was ${summary.output.length} characters; the last ${FOREGROUND_OUTPUT_CAP} are shown above.]`
        : "";
    return `${head}${output}${note}`;
}

/** The text returned when a background task starts. */
export function backgroundStartText(label: string, taskId: string, description: string, logPath?: string): string {
    return (
        `${label} task ${taskId} is running in the background (${description}).\n\n` +
        "You will be told when it finishes, in a <system-reminder> on a later tool result, so you do not need to wait or poll; keep working. " +
        (logPath ? `Its output so far is in ${logPath}. ` : "Read its output so far with task_output. ") +
        "If your next step cannot go on without the result, call task_output with block: true. Stop it with kill_task."
    );
}

/** Guard, clamp, then run the command in the foreground or start it in the background. Never rejects. */
export async function runShellCall(params: ShellCallParams, ctx: ShellCallContext): Promise<ShellCallResult> {
    const background = params.run_in_background === true;
    const guardReason = ctx.guard(params.command, { background });
    if (guardReason) { return { kind: "refused", text: guardReason }; }
    if (!ctx.spawn) {
        return { kind: "refused", text: `No ${ctx.label} executable is available on this machine, so the command did not run.` };
    }
    const command = (ctx.wrapCommand ?? ((c: string) => c))(params.command);
    const launch = shellLaunch(ctx.spawn, command);
    const description = params.description || params.command.slice(0, 80);

    if (!background) {
        const timeoutMs = clampTimeoutMs(params.timeout) ?? DEFAULT_TIMEOUT_MS;
        const summary = await runProcess(launch, { cwd: ctx.cwd, env: ctx.env, timeoutMs, signal: ctx.signal });
        let spill: { path: string; length: number } | undefined;
        if (summary.output.length > FOREGROUND_OUTPUT_CAP) {
            const path = taskLogPath(ctx.scratchpadDir, generateTaskId("shell"));
            if (path) {
                try {
                    writeFileSync(path, summary.output);
                    spill = { path, length: summary.output.length };
                } catch {
                    // The tail in the result stays authoritative.
                }
            }
        }
        return { kind: "foreground", text: foregroundText(summary, timeoutMs, spill), summary, timeoutMs, outputFile: spill?.path };
    }

    // A background task has no default timeout: it runs until it ends, kill_task, or the run ends.
    const taskId = generateTaskId("shell");
    const logPath = taskLogPath(ctx.scratchpadDir, taskId);
    const started = startBackgroundShell({
        id: taskId,
        runKey: ctx.runKey,
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        command: params.command,
        description,
        launch,
        cwd: ctx.cwd,
        env: ctx.env,
        timeoutMs: clampTimeoutMs(params.timeout),
        logPath,
        runSignal: ctx.signal,
        onFinished: ctx.onBackgroundFinished ? () => ctx.onBackgroundFinished() : undefined,
    });
    if (started.kind === "full") { return { kind: "refused", text: started.reason }; }
    return { kind: "background", text: backgroundStartText(ctx.label, taskId, description, logPath), taskId, logPath };
}
