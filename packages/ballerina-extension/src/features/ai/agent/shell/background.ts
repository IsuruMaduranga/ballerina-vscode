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
 * A shell command run in the background (`run_in_background: true`): started through the runner,
 * registered on the shared background registry, collected with `task_output`, stopped with `kill_task`,
 * and ended with its run (pincer-agent `extensions/bash/background.ts` + `lib/shell-tool.ts`, tip
 * `5059966`, on BI's registry instead of pi's).
 *
 * The task's own `AbortController` stops the process tree. It is linked to the run's signal, so an
 * aborted generation ends every background command it started; `kill_task` and run-end cleanup abort it
 * directly. Completion fills `output`, `exitCode` and `finishStatus` once and is then reported by the
 * registry's `<system-reminder>` drain, unless `task_output` delivered it first.
 */

import { ensureBackgroundCapacity, registerBackgroundTask } from "../background/registry";
import { type BackgroundShell, generateTaskId } from "../background/types";
import { type ProcessLaunch, type RunSummary, shellFinish, startProcess } from "./runner";

export interface StartBackgroundShellOptions {
    /** The task id; generated when absent. Pass one when the log path must name the task before it starts. */
    id?: string;
    runKey: string;
    toolCallId: string;
    /** `shell` or `powershell`. */
    toolName: string;
    /** The command as the model wrote it (the launch may wrap it). */
    command: string;
    description: string;
    launch: ProcessLaunch;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Where to spool the full output; named in the completion notice. */
    logPath?: string;
    /** The run's abort signal. */
    runSignal?: AbortSignal;
    /** Called once when the command finishes on its own (not after a run-end or `kill_task` stop). */
    onFinished?: (task: BackgroundShell, summary: RunSummary) => void;
    /** Reported synchronously by run-end cleanup, inside the run that owns the task. */
    onRunEnd?: () => void;
}

export type StartBackgroundShellResult =
    | { kind: "started"; task: BackgroundShell }
    | { kind: "full"; reason: string };

export function startBackgroundShell(opts: StartBackgroundShellOptions): StartBackgroundShellResult {
    const capacity = ensureBackgroundCapacity();
    if (capacity.kind === "full") { return capacity; }

    const abortController = new AbortController();
    let unlinkRunSignal: (() => void) | undefined;
    if (opts.runSignal) {
        if (opts.runSignal.aborted) {
            abortController.abort(opts.runSignal.reason);
        } else {
            const onRunAbort = () => abortController.abort(opts.runSignal.reason);
            opts.runSignal.addEventListener("abort", onRunAbort, { once: true });
            unlinkRunSignal = () => opts.runSignal.removeEventListener("abort", onRunAbort);
        }
    }

    const running = startProcess(opts.launch, {
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        signal: abortController.signal,
        logPath: opts.logPath,
    });

    const task: BackgroundShell = {
        kind: "shell",
        id: opts.id ?? generateTaskId("shell"),
        toolName: opts.toolName,
        command: opts.command,
        description: opts.description,
        runKey: opts.runKey,
        toolCallId: opts.toolCallId,
        startTime: new Date(),
        output: "",
        completed: false,
        success: null,
        aborted: false,
        abortController,
        notified: false,
        logPath: opts.logPath,
        exitCode: null,
        peek: () => running.output(),
        onRunEnd: opts.onRunEnd,
    };
    registerBackgroundTask(task);

    running.finished.then((summary) => {
        unlinkRunSignal?.();
        // Ended from outside (run end, kill_task): that path already completed the entry and reported it.
        if (task.runEnded || task.completed) { return; }
        const { status, detail } = shellFinish(summary, opts.timeoutMs);
        task.output = summary.output;
        task.exitCode = summary.exitCode;
        task.finishStatus = status;
        task.finishDetail = detail;
        task.success = status === "completed";
        task.aborted = status === "killed";
        task.completedAt = new Date();
        task.completed = true;
        opts.onFinished?.(task, summary);
    });

    return { kind: "started", task };
}
