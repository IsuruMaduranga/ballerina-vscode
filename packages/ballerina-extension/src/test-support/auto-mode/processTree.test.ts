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
 * shell/process-tree.ts against real shells, ported from pincer-agent
 * `test/unit/process-tree.test.ts` (the repo never mocks child_process). A
 * `bash -c` leader runs pipelines and `cmd; echo` in further processes;
 * signalling the leader alone left them as orphans holding the stdout pipe.
 * Detached spawn + group kill ends the whole tree, so `close` fires promptly.
 *
 * The Copilot's bash tool is `/bin/bash` on macOS and Linux only; Windows has
 * no bash tool here, so the suite is skipped there; the PowerShell path has its own
 * suites (pincer's Windows assertions time `waitForChildExit`,
 * because `close` can stay pending after a killed tree is gone).
 */
import { spawn } from "child_process";
import { detachedSpawnOptions, EXIT_STDIO_MAX_MS, killProcessTree, stopProcessTree, waitForChildExit } from "../../features/ai/agent/shell/process-tree";

const win32 = process.platform === "win32";
const describePosix = win32 ? describe.skip : describe;
const shell = "/bin/bash";

function spawnShell(command: string) {
    return spawn(shell, ["-c", command], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** Resolves with the wall time to `close`, or rejects after `limitMs`. */
function closeWithin(child: ReturnType<typeof spawn>, limitMs: number): Promise<number> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no close within ${limitMs} ms`)), limitMs);
        child.on("close", () => {
            clearTimeout(timer);
            resolve(Date.now() - started);
        });
    });
}

/** The wall time to `waitForChildExit` settling — the wait the tasks and hooks use. */
async function exitWithin(child: ReturnType<typeof spawn>): Promise<number> {
    const started = Date.now();
    await waitForChildExit(child);
    return Date.now() - started;
}

/** `close` on POSIX (the pipe closes with the tree); the exit-based wait on Windows. */
const settledWithin = (child: ReturnType<typeof spawn>, limitMs: number) => (win32 ? exitWithin(child) : closeWithin(child, limitMs));

describePosix("killProcessTree", () => {
    it("ends a pipeline's members, not just the shell, so the stdout pipe closes at once", async () => {
        const child = spawnShell("sleep 30 | cat");
        await new Promise((r) => setTimeout(r, 100)); // let the shell fork the pipeline
        const settled = settledWithin(child, 3000);
        killProcessTree(child);
        expect(await settled).toBeLessThan(3000);
    });

    it("ends a `cmd; more` sequence the same way", async () => {
        const child = spawnShell("sleep 30; echo done");
        await new Promise((r) => setTimeout(r, 100));
        const settled = settledWithin(child, 3000);
        killProcessTree(child);
        expect(await settled).toBeLessThan(3000);
    });

    it("waitForChildExit settles on exit plus the stdio grace, so a pipe a straggler holds cannot hang the wait", async () => {
        const child = spawnShell("sleep 30 | cat");
        await new Promise((r) => setTimeout(r, 100));
        const started = Date.now();
        const exited = waitForChildExit(child);
        killProcessTree(child);
        const { code, signal } = await exited;
        expect(Date.now() - started).toBeLessThan(3000);
        expect(code === null || code !== 0 || signal !== null).toBe(true);
    });

    it("waitForChildExit settles within the post-exit cap when a straggler keeps writing to the inherited pipe", async () => {
        // The leader exits at once; the backgrounded loop it left behind writes
        // every 50 ms, re-arming the stdio grace forever without the cap.
        const child = spawnShell("(while true; do echo x; sleep 0.05; done) & exit 0");
        const started = Date.now();
        await waitForChildExit(child);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(EXIT_STDIO_MAX_MS + 1500);
        killProcessTree(child, "SIGKILL"); // the loop is not the leader's group on Windows; best effort
    });
});

describePosix("stopProcessTree", () => {
    // Windows has no SIGTERM to ignore: taskkill /F is the first and only signal,
    // so the grace period does not exist there (lib/process-tree.ts).
    (win32 ? it.skip : it)("SIGKILLs after the grace period when the tree ignores SIGTERM", async () => {
        // The shell ignores TERM and the disposition is inherited by sleep.
        const child = spawnShell("trap '' TERM; sleep 30");
        await new Promise((r) => setTimeout(r, 150));
        const closed = closeWithin(child, 4000);
        stopProcessTree(child, 300);
        const elapsed = await closed;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(4000);
    });

    it("ends the tree at once where there is no gentler signal to grace (Windows)", async () => {
        const child = spawnShell("sleep 30");
        await new Promise((r) => setTimeout(r, 150));
        const settled = settledWithin(child, 4000);
        stopProcessTree(child, 300);
        expect(await settled).toBeLessThan(4000);
    });
});
