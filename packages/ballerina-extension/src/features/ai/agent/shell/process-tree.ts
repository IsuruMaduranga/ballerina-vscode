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
 * Process-tree termination for the shells the Copilot spawns, and the one way
 * to wait for such a child to finish.
 *
 * A `$SHELL -c "cmd"` child is only the leader: with zsh (macOS default) a
 * `cmd; echo` or a pipeline runs the command in further processes, and
 * `child.kill()` signals the shell alone — the command lives on as an orphan
 * holding the inherited stdout pipe, so `close` never fires (the task cannot
 * finish, a `task_output block:true` waits its full timeout) and in a one-shot
 * run the open pipe keeps node alive until the orphan exits (measured at
 * 3 min 21 s on a `tail -f | cat`).
 *
 * The producer spawns `detached` (own process group; `detachedSpawnOptions`)
 * and stops it with `killProcessTree`, which signals the negative pid — the
 * whole group — falling back to the child alone when the group is already gone.
 * `stopProcessTree` adds the grace period: SIGTERM now, SIGKILL if the leader
 * has not exited by then (a command that ignores SIGTERM still closes late,
 * which is exactly the late callback the shutdown paths guard against).
 *
 * `rememberProcessGroup` keeps every spawned tree from spawn until its group
 * is empty, including what a leader that already exited left behind (a
 * `npm run dev &` inside a finished background command). Chat changes and
 * turn ends leave those alone; `terminateRememberedProcessGroups` sends them
 * SIGTERM when the extension deactivates, so nothing the Copilot started
 * outlives VS Code.
 *
 * `waitForChildExit` is the counterpart on the waiting side: it settles on
 * `exit` plus a short stdio grace, never on `close` alone — a descendant the
 * kill missed (Windows: a process the `taskkill /T` snapshot did not see) can
 * hold the inherited pipes open for as long as it lives, and the task must not
 * wait for it.
 */

import { type ChildProcess, execFile } from "child_process";
import { system32Path } from "../auto-mode/shared-paths";

/** SIGTERM → SIGKILL grace for a stopped background tree (bash tasks, monitors). */
export const KILL_GRACE_MS = 2_000;

/** After `exit`, how long buffered stdio may keep arriving before the wait settles. */
export const EXIT_STDIO_GRACE_MS = 200;

/** ...and the most it may keep arriving in total: a straggler writing continuously must not keep re-arming the grace. */
export const EXIT_STDIO_MAX_MS = 2_000;

/**
 * `detached` everywhere but Windows, where process groups do not exist — except
 * for a child that must outlive an exiting parent (a fire-and-forget hook),
 * which is what `detached: true` means on Windows (Node's documented use); the
 * leader is still killed by pid there.
 */
export function detachedSpawnOptions(opts: { outlivesParent?: boolean } = {}): { detached: boolean } {
    return { detached: process.platform !== "win32" || Boolean(opts.outlivesParent) };
}

/**
 * Windows has no process groups and no SIGTERM: `taskkill /T /F` ends the
 * tree by pid, from System32 so a PATH entry cannot substitute the binary. Whatever taskkill reports, the
 * leader itself is then terminated directly too — taskkill can fail to kill
 * (or to find) a member, and the leader's exit is what the waiting side keys
 * on. `WSO2_INTEGRATOR_COPILOT_DEBUG_KILL=1` logs taskkill's output to stderr.
 */
function taskkillTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid == null) { return; }
    const direct = () => {
        try {
            child.kill();
        } catch {
            // Already gone.
        }
    };
    try {
        const proc = execFile(system32Path("taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, (error, stdout, stderr) => {
            if (process.env.WSO2_INTEGRATOR_COPILOT_DEBUG_KILL) {
                process.stderr.write(`[process-tree] taskkill /T /F /PID ${pid}: ${error ? `error ${error.message}` : "ok"}\n${stdout}${stderr}`);
            }
            direct();
        });
        proc.unref();
    } catch {
        direct();
    }
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (child.pid == null) { return; }
    if (process.platform === "win32") {
        // Once the leader has exited, Windows may give its pid to an unrelated process, and
        // `taskkill /T` by that pid would end a stranger's tree. Nothing of ours is reachable by it then.
        if (!rememberedGroupAlive(child)) { return; }
        taskkillTree(child);
        return;
    }
    try {
        process.kill(-child.pid, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // Already gone.
        }
    }
}

/** Trees spawned and not yet known to be empty. */
const rememberedGroups = new Set<ChildProcess>();
let groupReaper: NodeJS.Timeout | undefined;

/** How often the reaper forgets emptied groups. */
const REAP_INTERVAL_MS = 1_000;

/**
 * Whether a remembered tree may still have members. POSIX probes the group
 * (signal 0 to the negative pid): a group id stays reserved while any member
 * lives, and the reaper forgets an emptied group within a second, far sooner
 * than pid allocation wraps around to it. Windows has no process groups, so
 * only a live leader is worth a `taskkill /T`, and it is judged by the child's
 * own exit state: once the leader exits, a pid probe can find an unrelated
 * process that was given the same pid.
 */
export function rememberedGroupAlive(child: ChildProcess): boolean {
    if (child.pid == null) { return false; }
    if (process.platform === "win32") { return child.exitCode === null && child.signalCode === null; }
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function stopReaper(): void {
    if (groupReaper) { clearInterval(groupReaper); }
    groupReaper = undefined;
}

/**
 * Remember a spawned tree until its group is empty. Call it right after the
 * spawn, before waiting on the leader, so even a leader that exits at once is
 * covered. The reaper is unref'd: it never keeps a process alive.
 */
export function rememberProcessGroup(child: ChildProcess): void {
    if (child.pid == null || rememberedGroups.has(child)) { return; }
    rememberedGroups.add(child);
    if (groupReaper) { return; }
    groupReaper = setInterval(() => {
        for (const remembered of rememberedGroups) {
            if (!rememberedGroupAlive(remembered)) { rememberedGroups.delete(remembered); }
        }
        if (rememberedGroups.size === 0) { stopReaper(); }
    }, REAP_INTERVAL_MS);
    groupReaper.unref?.();
}

/**
 * SIGTERM every remembered tree that may still have members, and forget them
 * all: the extension is deactivating. Synchronous, with no SIGKILL follow-up,
 * since nothing is left to wait for a grace period. Returns how many trees
 * were signalled.
 */
export function terminateRememberedProcessGroups(): number {
    let signalled = 0;
    for (const child of rememberedGroups) {
        if (rememberedGroupAlive(child)) {
            killProcessTree(child, "SIGTERM");
            signalled++;
        }
    }
    rememberedGroups.clear();
    stopReaper();
    return signalled;
}

/** Test hook: how many trees are remembered now. */
export function rememberedProcessGroupCount(): number {
    return rememberedGroups.size;
}

/**
 * SIGTERM the tree, then SIGKILL it after `graceMs` unless the leader exited.
 * The timer is unref'd: it must never be what keeps a one-shot process alive.
 */
export function stopProcessTree(child: ChildProcess, graceMs: number): void {
    killProcessTree(child, "SIGTERM");
    // taskkill /F is already forceful; there is no gentler first signal to grace.
    if (process.platform === "win32") { return; }
    if (child.exitCode !== null || child.signalCode !== null) { return; }
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { killProcessTree(child, "SIGKILL"); }
    }, graceMs);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
}

export interface ChildExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Resolve when the child has exited and its stdio has drained: on `close`
 * when that arrives promptly, else `EXIT_STDIO_GRACE_MS` after `exit` (the
 * grace re-arms while output is still arriving, so a burst written just before
 * exit is not cut) and `EXIT_STDIO_MAX_MS` after `exit` at the latest (a
 * descendant the kill missed that keeps writing must not hold the wait).
 * Rejects on a spawn `error`. Listeners the caller attached for `data` keep
 * working; the streams are destroyed once this settles so a straggler holding
 * the far end cannot keep them — or the process — alive.
 */
export function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let exited: ChildExit | undefined;
        let grace: NodeJS.Timeout | undefined;
        let deadline: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (grace) { clearTimeout(grace); }
            if (deadline) { clearTimeout(deadline); }
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.stdout?.removeListener("data", onData);
            child.stderr?.removeListener("data", onData);
        };
        const finish = () => {
            if (settled || !exited) { return; }
            settled = true;
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(exited);
        };
        const arm = () => {
            if (grace) { clearTimeout(grace); }
            // Ref'd on purpose: in a one-shot run this timer may be the only handle
            // left once the pipes have closed, and the promise must still settle.
            grace = setTimeout(finish, EXIT_STDIO_GRACE_MS);
        };
        const onError = (error: Error) => {
            if (settled) { return; }
            settled = true;
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            exited = { code, signal };
            arm();
            deadline = setTimeout(finish, EXIT_STDIO_MAX_MS);
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
            exited ??= { code, signal };
            finish();
        };
        const onData = () => {
            if (exited && !settled) { arm(); }
        };
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
    });
}
