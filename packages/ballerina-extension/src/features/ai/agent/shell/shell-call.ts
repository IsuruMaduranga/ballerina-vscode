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
 * B2): guard → millisecond timeout clamp → foreground run, or a background
 * task on the shared registry. Each tool
 * supplies what differs (its name, spawn, guard and command wrapper); this
 * module owns the orchestration.
 *
 * Pure apart from starting processes and writing log files: no `ai`, `zod` or
 * `vscode` import, so the Jest suite drives it directly. The AI SDK tool that
 * wraps it is `tools/shell-tool.ts`. The permission gate is not here: the
 * caller authorizes a command before calling `runShellCall`.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { generateTaskId } from "../background/types";
import { startBackgroundShell } from "./background";
import { tailCap } from "./output";
import { balRunDirectory } from "./bal-run";
import { ensureScratchpadDir } from "./scratchpad";
import { clampTimeoutMs, finishLine, type ProcessLaunch, type RunSummary, runProcess } from "./runner";
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
    /** The run's abort signal: it stops a foreground command. A background command outlives the run. */
    signal?: AbortSignal;
    /** The thread's scratchpad (`shell/scratchpad.ts`): task logs and spilled output go under it. */
    scratchpadDir?: string;
    /** Called once when a background command finishes on its own (the touched-file scan). */
    onBackgroundFinished?: () => void;
    /**
     * Starts a background `bal run` as a service (`tools/ballerina-run.ts startShellService`). Without it,
     * such a command is an ordinary background task.
     */
    startService?: (start: { launch: ProcessLaunch; cwd: string; env?: NodeJS.ProcessEnv; packagePath: string }) => Promise<ServiceStartResult>;
}

/** How a background `bal run` started as a service went. */
export type ServiceStartResult =
    | { kind: "started"; taskId: string; output: string }
    | { kind: "failed"; exitCode: number; output: string; timedOut: boolean };

export type ShellCallResult =
    | { kind: "refused"; text: string }
    | { kind: "foreground"; text: string; summary: RunSummary; timeoutMs: number; outputFile?: string }
    | { kind: "background"; text: string; taskId: string; logPath?: string }
    | { kind: "service"; text: string; start: ServiceStartResult; packagePath: string };

/** `<scratchpad>/tasks/<taskId>/output.log`, its directory created; undefined without a scratchpad or when it cannot be created. */
export function taskLogPath(scratchpadDir: string | undefined, taskId: string): string | undefined {
    if (!scratchpadDir) { return undefined; }
    const dir = ensureScratchpadDir(join(scratchpadDir, "tasks", taskId));
    return dir ? join(dir, "output.log") : undefined;
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

/** The text returned when a background `bal run` was started as a service. */
export function serviceStartText(description: string, packagePath: string, start: ServiceStartResult): string {
    const output = tailCap(start.output, FOREGROUND_OUTPUT_CAP).trim();
    if (start.kind === "failed") {
        const why = start.timedOut
            ? "The service did not become ready within 60 seconds, so it was stopped."
            : `The service exited with code ${start.exitCode} before it was ready.`;
        return `${why}\n\n${output || "(no output)"}`;
    }
    return (
        `Service ${start.taskId} is running (${description}) in ${packagePath}.\n\n` +
        "It keeps running after your turn and in the user's other chats of this project. " +
        "Read its later output with task_output (each call returns only the new output). " +
        "Stop it with kill_task before you start it again, for example after a code change, or when the user asks.\n\n" +
        `Startup output:\n${output}`
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

    // A background `bal run` is a service: project-wide, kept across chats, listed in the running chip.
    const servicePath = ctx.startService ? balRunDirectory(params.command, ctx.cwd) : undefined;
    if (servicePath !== undefined) {
        const start = await ctx.startService({ launch, cwd: ctx.cwd, env: ctx.env, packagePath: servicePath });
        return { kind: "service", text: serviceStartText(description, servicePath, start), start, packagePath: servicePath };
    }

    // A background task has no default timeout: it runs until it ends or something stops it (kill_task,
    // the user, a chat change, VS Code closing). It is not tied to the run's signal.
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
        onFinished: ctx.onBackgroundFinished,
    });
    if (started.kind === "full") { return { kind: "refused", text: started.reason }; }
    return { kind: "background", text: backgroundStartText(ctx.label, taskId, description, logPath), taskId, logPath };
}
