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
 * `bal test` — goes through `spawnLaunch`, and every run the Copilot waits on through `startProcess`:
 *
 * - `shell: false`, an argv array, `windowsHide`. A `.bat`/`.cmd` (`bal.bat`) reaches here already wrapped
 *   by `commandLaunch`; a shell command already wrapped by `shellLaunch`.
 * - Its own process group (`detachedSpawnOptions`), so stop, timeout and abort end the whole tree:
 *   SIGTERM, then SIGKILL after `KILL_GRACE_MS` on POSIX; `taskkill /T /F` plus the leader on Windows.
 *   The group is remembered until it is empty (`rememberProcessGroup`), so whatever a finished command
 *   left running still ends when VS Code closes.
 * - Settles on `exit` plus the capped stdio grace (`waitForChildExit`), never on `close` alone.
 * - Output is sanitised and capped (`OutputBuffer`) and optionally spooled in full: from the start to
 *   `logPath`, or to `spill.path()` once it passes `spill.afterChars`. `finished` resolves only once the
 *   spool is flushed, so a reader sent to the file never sees it short; a spool that fails, or does not
 *   flush within `SPOOL_CLOSE_TIMEOUT_MS`, is dropped and never named as the full output.
 * - A finished run's output is never empty (`EMPTY_OUTPUT_MARKER`): a blank reads as a failure to a model.
 */

import { type ChildProcess, spawn } from "child_process";
import { createWriteStream, existsSync, type WriteStream } from "fs";
import { EMPTY_OUTPUT_MARKER, OutputBuffer } from "./output";
import { detachedSpawnOptions, KILL_GRACE_MS, rememberProcessGroup, stopProcessTree, waitForChildExit } from "./process-tree";

/** What to start: an executable and its arguments (`commandLaunch` / `shellLaunch` build these). */
export interface ProcessLaunch {
    command: string;
    args: string[];
    /** Set for a `cmd.exe` launch whose single command-line argument is already quoted. */
    windowsVerbatimArguments?: boolean;
}

/** Claude Code's cap on a shell call's `timeout` (milliseconds). */
export const MAX_TIMEOUT_MS = 600_000;

/** How long a finished run waits for its spool to flush before it drops the file and settles anyway. */
export const SPOOL_CLOSE_TIMEOUT_MS = 1_000;

export interface SpawnLaunchOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Default `ignore` (EOF on read). `bal run` keeps `pipe`, as it has always had. */
    stdin?: "ignore" | "pipe";
    /**
     * Default true: remember the tree until its group is empty (`rememberProcessGroup`), so a command
     * tree cannot outlive VS Code. False only for the PowerShell parse server, an internal helper that
     * starts no command tree and is shut down by `disposePowerShellParsers`; remembering it would keep
     * the reaper polling while it idles and signal it twice on deactivate.
     */
    remember?: boolean;
}

export interface ProcessOptions extends SpawnLaunchOptions {
    /** Stop the tree after this many ms. Clamp model-supplied values with `clampTimeoutMs` first. */
    timeoutMs?: number;
    /** Stops the tree when aborted — the run's `AbortController.signal`, or a background task's own. */
    signal?: AbortSignal;
    /** Spool the full sanitised output here (appended) from the start. Best effort: see `onSpoolFailed`. */
    logPath?: string;
    /**
     * Spool only an output that grows past `afterChars`: the file is named by `path()` at that moment and
     * receives everything so far, then the rest. `afterChars` must be below `outputCap`. Ignored with `logPath`.
     */
    spill?: { afterChars: number; path: () => string | undefined };
    /** Called once when the spool fails (it is then dropped, and the summary names no file). */
    onSpoolFailed?: () => void;
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
    /** How many sanitised characters the run printed in all, kept or not. */
    length: number;
    /** The output's first `PREVIEW_CHARS` characters, kept even when the cap dropped them. */
    head: string;
    /** The spool, flushed and complete: the whole output. Absent when nothing was spooled or the spool failed. */
    logPath?: string;
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
    if (opts.remember !== false) { rememberProcessGroup(child); }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    return child;
}

function failedToStart(message: string): RunningProcess {
    const summary: RunSummary = { exitCode: null, signal: null, stopped: false, timedOut: false, output: message, truncated: false, length: message.length, head: message, spawnError: message };
    return { child: undefined, output: () => message, stop: () => { /* nothing runs */ }, finished: Promise.resolve(summary), isDone: () => true };
}

/**
 * A run's spool file: opened from the start or once the output passes a threshold, written chunk by
 * chunk, and dropped for good on its first error.
 */
class Spool {
    private stream: WriteStream | undefined;
    private path: string | undefined;
    private failed = false;

    constructor(private readonly onFailed?: () => void) {}

    get opened(): boolean {
        return this.stream !== undefined || this.failed;
    }

    open(path: string | undefined, initial = ""): void {
        if (this.opened) { return; }
        if (!path) {
            this.fail();
            return;
        }
        this.path = path;
        this.stream = createWriteStream(path, { flags: "a" });
        this.stream.on("error", () => this.fail());
        if (initial) { this.write(initial); }
    }

    write(text: string): void {
        if (!this.failed) { this.stream?.write(text); }
    }

    private fail(): void {
        if (this.failed) { return; }
        this.failed = true;
        this.onFailed?.();
    }

    /**
     * Flush and close; resolves with the path when the file holds the whole output, else undefined. A
     * stream that never calls back (a blocked open, a hung filesystem) must not hold the run: after
     * `SPOOL_CLOSE_TIMEOUT_MS` it is destroyed and its partial file is not named.
     */
    close(): Promise<string | undefined> {
        const stream = this.stream;
        if (!stream) { return Promise.resolve(undefined); }
        const result = () => (this.failed ? undefined : this.path);
        if (stream.closed) { return Promise.resolve(result()); }
        return new Promise((resolve) => {
            const fallback = setTimeout(() => {
                this.fail();
                stream.destroy();
                resolve(undefined);
            }, SPOOL_CLOSE_TIMEOUT_MS);
            stream.once("close", () => {
                clearTimeout(fallback);
                resolve(result());
            });
            stream.end();
        });
    }
}

/** Start `launch`; `finished` resolves with its summary. Never rejects. */
export function startProcess(launch: ProcessLaunch, opts: ProcessOptions): RunningProcess {
    if (opts.signal?.aborted) {
        const summary: RunSummary = { exitCode: null, signal: null, stopped: true, timedOut: false, output: EMPTY_OUTPUT_MARKER, truncated: false, length: 0, head: "" };
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
    const spool = opts.logPath || opts.spill ? new Spool(opts.onSpoolFailed) : undefined;
    if (opts.logPath) { spool.open(opts.logPath); }
    const spill = opts.logPath ? undefined : opts.spill;

    const onData = (chunk: string) => {
        // What was kept before this chunk: the whole output so far until the spill opens, since
        // `afterChars` is below the cap and nothing is dropped before the output passes it.
        const before = buffer.kept;
        const clean = buffer.append(chunk);
        if (!clean) { return; }
        if (spill && !spool.opened) {
            // Everything so far starts the file: what was kept, then this chunk.
            if (buffer.length > spill.afterChars) { spool.open(spill.path(), before + clean); }
        } else {
            spool?.write(clean);
        }
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
                length: buffer.length,
                head: buffer.head,
                spawnError,
            };
            if (!spool) {
                resolve(summary);
                return;
            }
            void spool.close().then((logPath) => resolve(logPath ? { ...summary, logPath } : summary));
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

/**
 * Whether a nonzero exit code is a success for this command (grep's "no match"; `shell/exit-semantics.ts
 * exitJudgeFor`). `output` is the run's output.
 */
export type ExitJudge = (exitCode: number, output: string) => boolean;

/**
 * The status and, for a failure an exit code does not explain, the detail. `exitOk` turns a nonzero exit
 * the command's semantics call success into `completed`.
 */
export function shellFinish(summary: RunSummary, timeoutMs?: number, exitOk?: ExitJudge): { status: FinishStatus; detail?: string } {
    if (summary.stopped) { return { status: "killed" }; }
    if (summary.timedOut) { return { status: "failed", detail: `timed out after ${formatDuration(timeoutMs ?? 0)}` }; }
    if (summary.spawnError) { return { status: "failed", detail: summary.spawnError }; }
    if (summary.exitCode === 0) { return { status: "completed" }; }
    if (summary.exitCode !== null && exitOk?.(summary.exitCode, summary.output)) { return { status: "completed" }; }
    return { status: "failed", detail: summary.exitCode === null ? `terminated by ${summary.signal ?? "unknown signal"}` : undefined };
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** One word or phrase for a finished run: `completed`, `stopped`, `failed (exit code 2)`. */
export function finishLine(summary: RunSummary, timeoutMs?: number, exitOk?: ExitJudge): string {
    const { status, detail } = shellFinish(summary, timeoutMs, exitOk);
    if (status === "killed") { return "stopped"; }
    if (status === "completed") { return "completed"; }
    return `failed (${detail ?? `exit code ${summary.exitCode}`})`;
}
