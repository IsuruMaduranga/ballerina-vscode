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

import { join } from "path";
import { generateTaskId } from "../background/types";
import { startBackgroundShell } from "./background";
import { persistedOutputBlock, PREVIEW_CHARS, startAndEnd } from "./output";
import { balRunDirectory } from "./bal-run";
import { exitJudgeFor, type ShellDialect } from "./exit-semantics";
import { ensureScratchpadDir } from "./scratchpad";
import { clampTimeoutMs, finishLine, type ProcessLaunch, type RunSummary, runProcess } from "./runner";
import { shellLaunch, type ShellSpawn } from "./shell-spawn";

/** Claude Code's default for a foreground call without a `timeout`. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The most output a foreground result carries whole (Claude Code's 30,000
 * characters). Past it the full output goes to a file in the scratchpad, and
 * the result names the file and previews the output's start.
 */
export const FOREGROUND_OUTPUT_CAP = 30_000;

/**
 * The tail of a foreground run's output kept in memory. It stays above
 * `FOREGROUND_OUTPUT_CAP`, the spill threshold, so the whole output is still
 * in memory when the spill file opens; past the cap the file holds it all.
 */
export const FOREGROUND_MEMORY_CAP = 64 * 1024;

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
    /** Which exit semantics the shell's commands follow (`exit-semantics.ts exitJudgeFor`). */
    dialect: ShellDialect;
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
    | {
        kind: "foreground";
        text: string;
        /** `logPath` is the file holding the whole output, when it was too long to return. */
        summary: RunSummary;
        /** How the command ended (`runner.ts finishLine`), with its exit semantics applied. */
        finish: string;
    }
    | { kind: "background"; text: string; taskId: string; logPath?: string }
    | { kind: "service"; text: string; start: ServiceStartResult; packagePath: string };

/** `<scratchpad>/tasks/<taskId>/output.log`, its directory created; undefined without a scratchpad or when it cannot be created. */
export function taskLogPath(scratchpadDir: string | undefined, taskId: string): string | undefined {
    if (!scratchpadDir) { return undefined; }
    const dir = ensureScratchpadDir(join(scratchpadDir, "tasks", taskId));
    return dir ? join(dir, "output.log") : undefined;
}

/** A foreground call's timeout: the model's value clamped, or `DEFAULT_TIMEOUT_MS`. */
export function foregroundTimeoutMs(timeout: number | undefined): number {
    return clampTimeoutMs(timeout) ?? DEFAULT_TIMEOUT_MS;
}

/**
 * The model-facing text of a finished foreground call: headed by how the
 * command ended (`line`, `runner.ts finishLine`) unless it succeeded, then
 * `finishedOutputText`.
 */
export function foregroundText(summary: RunSummary, line: string): string {
    const head =
        line === "completed" ? ""
            : line === "stopped" ? "Command stopped: the run was aborted.\n\n"
                : `Command ${line}.\n\n`;
    return `${head}${finishedOutputText(summary)}`;
}

/**
 * A finished command's output for the model (a foreground result, or `task_output` on a finished
 * background command): whole up to `FOREGROUND_OUTPUT_CAP`, else the persisted-output block naming the
 * file that holds it (`summary.logPath`) and previewing its start. Without that file (no scratchpad, a
 * failed spool) the block also carries the end of the output kept in memory, within the same cap.
 */
export function finishedOutputText(summary: Pick<RunSummary, "output" | "head" | "length" | "logPath">): string {
    if (summary.length <= FOREGROUND_OUTPUT_CAP) { return summary.output; }
    const end = summary.logPath ? "" : summary.output.slice(-(FOREGROUND_OUTPUT_CAP - PREVIEW_CHARS));
    return persistedOutputBlock(summary.length, summary.head, summary.logPath, end);
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
    // Service output is never saved to a file, and a failed start ends in its error: keep both ends.
    const output = startAndEnd(start.output, FOREGROUND_OUTPUT_CAP, PREVIEW_CHARS).trim();
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

    const exitOk = exitJudgeFor(ctx.dialect, params.command);
    if (!background) {
        const timeoutMs = foregroundTimeoutMs(params.timeout);
        // A long output is spooled from its first character once it passes the cap, so the file holds all of it.
        const spill = { afterChars: FOREGROUND_OUTPUT_CAP, path: () => taskLogPath(ctx.scratchpadDir, generateTaskId("shell")) };
        const summary = await runProcess(launch, { cwd: ctx.cwd, env: ctx.env, timeoutMs, signal: ctx.signal, spill, outputCap: FOREGROUND_MEMORY_CAP });
        // A nonzero exit `exitOk` accepts (grep's "no match") is a success.
        const finish = finishLine(summary, timeoutMs, exitOk);
        return { kind: "foreground", text: foregroundText(summary, finish), summary, finish };
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
        exitOk,
        onFinished: ctx.onBackgroundFinished,
    });
    if (started.kind === "full") { return { kind: "refused", text: started.reason }; }
    return { kind: "background", text: backgroundStartText(ctx.label, taskId, description, logPath), taskId, logPath };
}
