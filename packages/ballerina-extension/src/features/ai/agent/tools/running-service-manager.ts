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

import * as child_process from 'child_process';
import { system32Path } from '../auto-mode/shared-paths';
import { commandLaunch } from '../shell/command-launch';
import { stripAnsiAndControl } from '../shell/output';
import { waitForChildExit } from '../shell/process-tree';
import { spawnLaunch } from '../shell/runner';

const isWindows = process.platform === 'win32';

export interface RunningService {
    taskId: string;
    process: child_process.ChildProcess;
    logs: string[];
    logCursor: number;
    packagePath: string;
    startedAt: number;
    exited: boolean;
    exitCode: number;
    /**
     * Timer that auto-removes the entry after EXITED_SERVICE_TTL_MS once
     * the process has closed. Tracked here so it can be cleared when the
     * entry is removed earlier (e.g. via stopOne) — otherwise the timer
     * keeps the closure (and the logs buffer) alive for the full TTL.
     */
    exitTimer?: NodeJS.Timeout;
}

/**
 * Serializable view of a running service for cross-process boundaries (RPC).
 * Excludes the process handle and log buffer, which cannot cross to the webview.
 */
export interface RunningServiceInfo {
    taskId: string;
    packagePath: string;
    startedAt: number;
    exited: boolean;
    exitCode: number;
}

/** Auto-remove an exited service from the manager after this many ms. */
const EXITED_SERVICE_TTL_MS = 30_000;

/** Hard ceiling on dispose() so extension deactivation can't be blocked by a stuck child. */
const DISPOSE_TIMEOUT_MS = 2_000;

/**
 * Spawns a child process, capturing stdout/stderr into `logs`.
 * No VS Code terminal is created — output is consumed by the inline UI card.
 *
 * Goes through the shell runner's one spawn (`shell: false`, argv array, own
 * process group): an executable path with spaces
 * (`/Applications/WSO2 Integrator.app/.../bin/bal`) is one argv element, so it
 * needs no quoting. On Windows `bal` is `bal.bat`, which Node refuses to spawn
 * without a shell; `commandLaunch` starts it through `cmd.exe /d /s /c` with
 * the line quoted once.
 */
export function spawnProcess(
    command: string,
    args: string[],
    cwd: string,
    logs: string[]
): { process: child_process.ChildProcess } {
    const launch = commandLaunch(stripSurroundingQuotes(command), args, process.env);
    // stdin stays a pipe, as it always has for `bal run` (a program reading stdin blocks rather than seeing EOF).
    const proc = spawnLaunch(launch, { cwd, stdin: 'pipe' });

    const handleData = (data: string | Buffer) => {
        logs.push(stripAnsiAndControl(data.toString()));
    };

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);

    proc.on('error', (err) => {
        logs.push(`Failed to start process: ${err.message}`);
    });

    return { process: proc };
}

/**
 * Portable "is this PID still alive?" check.
 * Uses signal 0 which is a no-op that throws if the process doesn't exist —
 * supported on both Unix and Windows by Node's `process.kill`.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ESRCH = dead. EPERM = alive-but-unsignalable (shouldn't happen for our own child).
        return code === 'EPERM';
    }
}

/**
 * Kills the entire process group (shell + child processes).
 *
 * Returns a promise that resolves once the kill command completes. Note:
 * completion of the kill command does NOT guarantee the process tree is
 * actually gone — callers should use `waitForExit` which verifies and
 * escalates if the root PID is still alive.
 *
 * stderr from `taskkill` / failures of `process.kill` are logged (not
 * silently swallowed) so orphan-process issues can be diagnosed from
 * extension host logs in the field.
 */
export function killProcessGroup(proc: child_process.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (proc.pid == null) {
        return Promise.resolve();
    }
    const pid = proc.pid;

    if (isWindows) {
        return new Promise((resolve) => {
            // /T kills the process tree, /F forces termination. taskkill.exe is
            // addressed in System32 so a PATH entry cannot stand in for it; async
            // so the extension host isn't blocked by antivirus-slow taskkill.
            child_process.execFile(system32Path('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err, _stdout, stderr) => {
                if (err) {
                    const msg = (stderr || err.message || '').trim();
                    // Exit code 128 / "not found" just means the process already died.
                    const alreadyGone = /not found|not running|could not be found|no tasks/i.test(msg);
                    if (!alreadyGone) {
                        console.warn(
                            `[RunningServicesManager] taskkill /T /F /PID ${pid} failed: ${msg || '(no stderr)'}`
                        );
                    }
                }
                // Whatever taskkill reported, end the leader directly too: the
                // waiters key on its exit (pincer lib/process-tree.ts).
                try {
                    proc.kill();
                } catch {
                    // Already gone.
                }
                resolve();
            });
        });
    }

    // Unix: kill the entire process group via negative PID.
    return new Promise((resolve) => {
        try {
            process.kill(-pid, signal);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ESRCH') {
                // Process group gone is fine; anything else is worth logging.
                console.warn(
                    `[RunningServicesManager] process.kill(-${pid}, ${signal}) failed: ${(err as Error).message}`
                );
            }
            // Fall back to killing just the direct child.
            try {
                proc.kill(signal);
            } catch (err2) {
                const code2 = (err2 as NodeJS.ErrnoException).code;
                if (code2 !== 'ESRCH') {
                    console.warn(
                        `[RunningServicesManager] proc.kill(${signal}) fallback failed: ${(err2 as Error).message}`
                    );
                }
            }
        }
        resolve();
    });
}

const STOP_TIMEOUT_MS = 5000;
/**
 * After the exit (or the timeout), we verify the PID is actually
 * gone. On Windows, `taskkill /T` can fail to walk the full tree (e.g. when
 * the shell exits before grandchildren are registered), leaving orphans.
 * This constant controls how long we wait for each post-kill verification
 * pass before giving up.
 */
const VERIFY_POLL_INTERVAL_MS = 100;
const VERIFY_MAX_WAIT_MS = 1_000;

/**
 * Waits for a process to exit, with escalation if the root PID is still
 * alive afterwards. Resolves when either (a) the PID is confirmed dead or
 * (b) we've exhausted our escalation attempts.
 */
export async function waitForExit(proc: child_process.ChildProcess, timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
    // A signal-killed process has `exitCode === null` and `signalCode` set; the
    // exit event already fired, so waiting for it would sit out the timeout.
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return;
    }

    // Settle on `exit` plus the capped stdio grace, never on `close` alone: on
    // Windows a dead tree's inherited pipe can stay open for seconds.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        waitForChildExit(proc).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) {
        clearTimeout(timer);
    }

    await verifyPidGone(proc);
}

/**
 * Verifies the root PID is actually gone. If not, escalates with a second
 * kill pass and briefly polls. Logs loudly if the PID is still alive
 * after escalation — that's the orphan-process smell.
 */
async function verifyPidGone(proc: child_process.ChildProcess): Promise<void> {
    if (proc.pid == null) {
        return;
    }
    const pid = proc.pid;
    if (!isProcessAlive(pid)) {
        return;
    }

    console.warn(
        `[RunningServicesManager] PID ${pid} still alive after close/timeout; escalating kill`
    );
    await killProcessGroup(proc, 'SIGKILL');

    // Poll briefly for the PID to disappear after the escalation.
    const deadline = Date.now() + VERIFY_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return;
        }
        await new Promise((r) => setTimeout(r, VERIFY_POLL_INTERVAL_MS));
    }

    if (isProcessAlive(pid)) {
        console.error(
            `[RunningServicesManager] PID ${pid} is still alive after escalation — ` +
            `child process (or descendants) may be orphaned. This can happen on ` +
            `Windows when taskkill /T cannot walk the process tree.`
        );
    }
}

export class RunningServicesManager {
    private services = new Map<string, RunningService>();

    /**
     * Optional callback invoked whenever the service list changes
     * (registered, removed, or process exited). Used to push updates
     * to the webview UI.
     */
    onChange?: (services: RunningServiceInfo[]) => void;

    get(taskId: string): RunningService | undefined {
        return this.services.get(taskId);
    }

    /** Returns a serializable snapshot of all tracked services. */
    getAll(): RunningServiceInfo[] {
        return Array.from(this.services.values()).map((s) => ({
            taskId: s.taskId,
            packagePath: s.packagePath,
            startedAt: s.startedAt,
            exited: s.exited,
            exitCode: s.exitCode,
        }));
    }

    register(service: RunningService): void {
        this.services.set(service.taskId, service);

        // Exit-based (runner.ts): a descendant holding the inherited pipe must
        // not keep a finished service listed as running.
        const onExited = (code: number | null) => {
            service.exited = true;
            service.exitCode = code ?? -1;
            // Already removed (stopOne, remove, dispose): nothing to show or expire.
            if (this.services.get(service.taskId) !== service) {
                return;
            }
            this.notifyChange();
            // Hold the exited entry briefly so the UI can show the final state
            // before it disappears from the list.
            service.exitTimer = setTimeout(() => {
                if (this.services.get(service.taskId) === service) {
                    this.services.delete(service.taskId);
                    this.notifyChange();
                }
            }, EXITED_SERVICE_TTL_MS);
        };
        waitForChildExit(service.process).then(({ code }) => onExited(code), () => onExited(null));

        this.notifyChange();
    }

    remove(taskId: string): boolean {
        const service = this.services.get(taskId);
        if (!service) {
            return false;
        }
        this.dropService(service);
        this.notifyChange();
        return true;
    }

    async stopOne(taskId: string): Promise<boolean> {
        const service = this.services.get(taskId);
        if (!service) {
            return false;
        }
        if (!service.exited && !service.process.killed) {
            await killProcessGroup(service.process, 'SIGTERM');
            await waitForExit(service.process);
        }
        // The exit listener may have already removed the entry and fired
        // notifyChange. Only fire again if we're the ones doing the removal.
        if (this.dropService(service)) {
            this.notifyChange();
        }
        return true;
    }

    /**
     * Awaitable teardown of all services. Capped at DISPOSE_TIMEOUT_MS so
     * extension deactivation never blocks indefinitely on a stuck process.
     */
    async dispose(): Promise<void> {
        const services = Array.from(this.services.values());
        for (const service of services) {
            this.dropService(service);
        }
        this.notifyChange();

        const killAll = Promise.all(
            services.map(async (service) => {
                if (service.process.killed) {
                    return;
                }
                await killProcessGroup(service.process, 'SIGTERM');
                await waitForExit(service.process);
            })
        );

        // Race against a timeout so a stuck child can't hold up VS Code shutdown.
        await Promise.race([
            killAll,
            new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
        ]);
    }

    /**
     * Removes a service entry and clears its TTL timer if one is pending.
     * Without clearing, the timer's closure pins the logs buffer for the
     * full TTL even after the entry is gone. Returns whether the entry
     * was actually present in the map.
     */
    private dropService(service: RunningService): boolean {
        if (service.exitTimer) {
            clearTimeout(service.exitTimer);
            service.exitTimer = undefined;
        }
        return this.services.delete(service.taskId);
    }

    private notifyChange(): void {
        try {
            this.onChange?.(this.getAll());
        } catch (err) {
            console.error('[RunningServicesManager] onChange handler threw:', err);
        }
    }
}

/** `getBallerinaCmd()` may arrive quoted (the old `quoteShellPath` normalised that); argv needs the bare path. */
function stripSurroundingQuotes(command: string): string {
    return command.length >= 2 && command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command;
}

export const runningServicesManager = new RunningServicesManager();
