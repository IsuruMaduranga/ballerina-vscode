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
 * The one process runner: every child the Copilot starts — the shell tool's commands, `bal run`,
 * `bal test` — goes through `spawnLaunch`, and every run the Copilot waits on through `startProcess`.
 * The shape is pincer-agent's `extensions/bash/background.ts` and `lib/shell-spawn.ts` (tip `5059966`),
 * without pi:
 *
 * - `shell: false`, an argv array, `windowsHide`. A `.bat`/`.cmd` (`bal.bat`) reaches here already wrapped
 *   by `commandLaunch`; a shell command already wrapped by `shellLaunch`.
 * - Its own process group (`detachedSpawnOptions`), so stop, timeout and abort end the whole tree:
 *   SIGTERM, then SIGKILL after `KILL_GRACE_MS` on POSIX; `taskkill /T /F` plus the leader on Windows.
 * - Settles on `exit` plus the capped stdio grace (`waitForChildExit`), never on `close` alone.
 * - Output is sanitised and capped (`OutputBuffer`) and optionally spooled in full to `logPath`;
 *   `finished` resolves only once the spool is flushed, so a reader sent to the file never sees it short.
 * - A finished run's output is never empty (`EMPTY_OUTPUT_MARKER`): a blank reads as a failure to a model.
 */

import { type ChildProcess, spawn } from "child_process";
import { createWriteStream, existsSync } from "fs";
import { EMPTY_OUTPUT_MARKER, OutputBuffer } from "./output";
import { detachedSpawnOptions, KILL_GRACE_MS, stopProcessTree, waitForChildExit } from "./process-tree";

/** What to start: an executable and its arguments (`commandLaunch` / `shellLaunch` build these). */
export interface ProcessLaunch {
    command: string;
    args: string[];
    /** Set for a `cmd.exe` launch whose single command-line argument is already quoted. */
    windowsVerbatimArguments?: boolean;
}

/** Claude Code's cap on a shell call's `timeout` (milliseconds). */
export const MAX_TIMEOUT_MS = 600_000;

export interface SpawnLaunchOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Default `ignore` (EOF on read). `bal run` keeps `pipe`, as it has always had. */
    stdin?: "ignore" | "pipe";
}

export interface ProcessOptions extends SpawnLaunchOptions {
    /** Stop the tree after this many ms. Clamp model-supplied values with `clampTimeoutMs` first. */
    timeoutMs?: number;
    /** Stops the tree when aborted — the run's `AbortController.signal`, or a background task's own. */
    signal?: AbortSignal;
    /** Spool the full sanitised output here (appended). Best effort: the in-memory tail stays authoritative. */
    logPath?: string;
    outputCap?: number;
    /** Each sanitised chunk as it arrives (live UI, ready detection). */
    onOutput?: (text: string) => void;
}

export interface RunSummary {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    /** `stop()` or the abort signal ended it. */
    stopped: boolean;
    /** The timeout ended it. */
    timedOut: boolean;
    /** The capped, sanitised output; never empty. */
    output: string;
    truncated: boolean;
    /** Set when the process could not be started (missing cwd, ENOENT, EINVAL). */
    spawnError?: string;
}

export interface RunningProcess {
    /** Undefined only when the spawn itself failed. */
    readonly child: ChildProcess | undefined;
    /** Output so far (may be empty while running). */
    output(): string;
    stop(): void;
    readonly finished: Promise<RunSummary>;
    isDone(): boolean;
}

/** A model-supplied millisecond timeout: positive and finite, at most `MAX_TIMEOUT_MS`; else undefined. */
export function clampTimeoutMs(timeout: number | undefined, max: number = MAX_TIMEOUT_MS): number | undefined {
    if (timeout === undefined || timeout === null || !Number.isFinite(timeout) || timeout <= 0) { return undefined; }
    return Math.min(timeout, max);
}

/**
 * The one `spawn` call. Throws what `spawn` throws synchronously (Node's EINVAL for a batch file started
 * without a shell); asynchronous failures arrive as the child's `error` event. A permanent no-op `error`
 * listener is attached: waiters remove theirs when they settle, and a late `error` (a kill of a process
 * that is already gone) must not become an uncaught exception in the extension host.
 */
export function spawnLaunch(launch: ProcessLaunch, opts: SpawnLaunchOptions): ChildProcess {
    const child = spawn(launch.command, launch.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        ...detachedSpawnOptions(),
        stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    child.on("error", () => { /* reported through the waiter; see above */ });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    return child;
}

function failedToStart(message: string): RunningProcess {
    const summary: RunSummary = { exitCode: null, signal: null, stopped: false, timedOut: false, output: message, truncated: false, spawnError: message };
    return { child: undefined, output: () => message, stop: () => { /* nothing runs */ }, finished: Promise.resolve(summary), isDone: () => true };
}

/** Start `launch`; `finished` resolves with its summary. Never rejects. */
export function startProcess(launch: ProcessLaunch, opts: ProcessOptions): RunningProcess {
    if (opts.signal?.aborted) {
        const summary: RunSummary = { exitCode: null, signal: null, stopped: true, timedOut: false, output: EMPTY_OUTPUT_MARKER, truncated: false };
        return { child: undefined, output: () => "", stop: () => { /* nothing runs */ }, finished: Promise.resolve(summary), isDone: () => true };
    }
    if (!existsSync(opts.cwd)) {
        return failedToStart(`Working directory does not exist: ${opts.cwd}`);
    }
    let child: ChildProcess;
    try {
        child = spawnLaunch(launch, opts);
    } catch (error) {
        return failedToStart(`Failed to start ${launch.command}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const buffer = new OutputBuffer(opts.outputCap);
    const log = opts.logPath ? createWriteStream(opts.logPath, { flags: "a" }) : undefined;
    log?.on("error", () => { /* spooling is best effort */ });

    const onData = (chunk: string) => {
        const clean = buffer.append(chunk);
        if (!clean) { return; }
        log?.write(clean);
        opts.onOutput?.(clean);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let done = false;
    let stopRequested = false;
    let timedOut = false;
    let spawnError: string | undefined;

    const stop = () => {
        if (done) { return; }
        stopRequested = true;
        stopProcessTree(child, KILL_GRACE_MS);
    };
    const onAbort = () => stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
            if (done) { return; }
            timedOut = true;
            stopProcessTree(child, KILL_GRACE_MS);
        }, opts.timeoutMs);
    }

    const finished = new Promise<RunSummary>((resolve) => {
        const end = (exitCode: number | null, signal: NodeJS.Signals | null) => {
            done = true;
            if (timer) { clearTimeout(timer); }
            opts.signal?.removeEventListener("abort", onAbort);
            const summary: RunSummary = {
                exitCode,
                signal,
                stopped: stopRequested,
                timedOut,
                output: buffer.toString() || EMPTY_OUTPUT_MARKER,
                truncated: buffer.truncated,
                spawnError,
            };
            if (log) { log.end(() => resolve(summary)); } else { resolve(summary); }
        };
        waitForChildExit(child).then(
            ({ code, signal }) => end(code, signal),
            (error: Error) => {
                spawnError = `Failed to start ${launch.command}: ${error.message}`;
                onData(`${buffer.toString() ? "\n" : ""}${spawnError}`);
                end(null, null);
            },
        );
    });

    return { child, output: () => buffer.toString(), stop, finished, isDone: () => done };
}

/** Run `launch` to completion (foreground). */
export function runProcess(launch: ProcessLaunch, opts: ProcessOptions): Promise<RunSummary> {
    return startProcess(launch, opts).finished;
}

/** How a run ended, as Claude Code's task status: a stop is `killed`, a timeout or non-zero exit `failed`. */
export type FinishStatus = "completed" | "failed" | "killed";

/** pincer `lib/shell-tool.ts shellFinish`: the status and, for a failure an exit code does not explain, the detail. */
export function shellFinish(summary: RunSummary, timeoutMs?: number): { status: FinishStatus; detail?: string } {
    if (summary.stopped) { return { status: "killed" }; }
    if (summary.timedOut) { return { status: "failed", detail: `timed out after ${formatDuration(timeoutMs ?? 0)}` }; }
    if (summary.spawnError) { return { status: "failed", detail: summary.spawnError }; }
    if (summary.exitCode === 0) { return { status: "completed" }; }
    return { status: "failed", detail: summary.exitCode === null ? `terminated by ${summary.signal ?? "unknown signal"}` : undefined };
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** One word or phrase for a finished run: `completed`, `stopped`, `failed (exit code 2)`. */
export function finishLine(summary: RunSummary, timeoutMs?: number): string {
    const { status, detail } = shellFinish(summary, timeoutMs);
    if (status === "killed") { return "stopped"; }
    if (status === "completed") { return "completed"; }
    return `failed (${detail ?? `exit code ${summary.exitCode}`})`;
}
