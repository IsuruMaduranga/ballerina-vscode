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
 * The shell tool's shared body (shell/shell-call.ts) against real children:
 * `node -e` stands in for the shell so the cases hold on every OS, and
 * `/bin/bash` runs where it exists.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    getBackgroundTask,
    listBackgroundTasks,
    resetBackgroundTasksForTests,
    stopAllBackgroundTasks,
} from "../../features/ai/agent/background/registry";
import type { BackgroundShell } from "../../features/ai/agent/background/types";
import { bashToolDescription } from "../../features/ai/agent/shell/bash-description";
import { bashGuardReason } from "../../features/ai/agent/shell/guards";
import { EMPTY_OUTPUT_MARKER, MAX_PROCESS_OUTPUT_CHARS } from "../../features/ai/agent/shell/output";
import { FOREGROUND_OUTPUT_CAP, foregroundTimeoutMs, runShellCall, type ShellCallContext } from "../../features/ai/agent/shell/shell-call";
import { bashSpawn } from "../../features/ai/agent/shell/shell-spawn";
import { expectLabeled } from "./labeled";

const posixOnly = process.platform === "win32" ? it.skip : it;

let root: string;
let scratchpad: string;
beforeEach(() => {
    resetBackgroundTasksForTests();
    root = mkdtempSync(join(tmpdir(), "bi-shell-call-"));
    scratchpad = join(root, "scratchpad");
});
afterEach(() => {
    stopAllBackgroundTasks();
    resetBackgroundTasksForTests();
    rmSync(root, { recursive: true, force: true });
});

/** A context whose "shell" is Node: the command is a script for `node -e`. */
const nodeCtx = (over: Partial<ShellCallContext> = {}): ShellCallContext => ({
    toolName: "shell",
    dialect: "bash",
    label: "Bash",
    spawn: { shell: process.execPath, args: ["-e"] },
    guard: () => undefined,
    cwd: root,
    runKey: "run-a",
    toolCallId: "call-1",
    scratchpadDir: scratchpad,
    ...over,
});

async function until(predicate: () => boolean, limitMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > limitMs) { throw new Error("condition not met in time"); }
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("runShellCall: before anything runs", () => {
    it("returns the guard's reason and starts nothing", async () => {
        const marker = join(root, "ran");
        const result = await runShellCall(
            { command: `require("fs").writeFileSync(${JSON.stringify(marker)}, "")` },
            nodeCtx({ guard: () => "Blocked: no." }),
        );
        expect(result).toEqual({ kind: "refused", text: "Blocked: no." });
        expect(existsSync(marker)).toBe(false);
    });

    it("tells the guard whether the call is a background one", async () => {
        const seen: boolean[] = [];
        const guard = (_: string, opts: { background: boolean }) => { seen.push(opts.background); return "no"; };
        await runShellCall({ command: "x" }, nodeCtx({ guard }));
        await runShellCall({ command: "x", run_in_background: true }, nodeCtx({ guard }));
        expect(seen).toEqual([false, true]);
    });

    it("refuses when no shell resolves", async () => {
        const result = await runShellCall({ command: "1" }, nodeCtx({ spawn: undefined, label: "PowerShell" }));
        expect(result.kind).toBe("refused");
        expect(result.text).toContain("No PowerShell executable");
    });
});

describe("runShellCall: foreground", () => {
    it("returns the output alone when the command succeeds", async () => {
        const result = await runShellCall({ command: 'console.log("hello")' }, nodeCtx());
        expect(result.kind).toBe("foreground");
        expect(result.text.trim()).toBe("hello");
    });

    it("heads the output with the exit code when the command fails", async () => {
        const result = await runShellCall({ command: 'console.error("bad"); process.exit(3)' }, nodeCtx());
        expect(result.text).toMatch(/^Command failed \(exit code 3\)\.\n\nbad/);
    });

    it("stops the command at a clamped timeout", async () => {
        const result = await runShellCall({ command: "setTimeout(() => {}, 30000)", timeout: 300 }, nodeCtx());
        expect(result.kind === "foreground" && result.summary.timedOut).toBe(true);
        expect(result.text).toContain("Command failed (timed out after 300ms).");
    });

    it("applies the default timeout when none or a nonsense one is given", async () => {
        for (const timeout of [undefined, 0, -5, Number.NaN]) {
            expect(foregroundTimeoutMs(timeout)).toBe(120_000);
        }
        expect(foregroundTimeoutMs(10_000_000)).toBe(600_000);
    });

    it("stops the command when the run aborts", async () => {
        const controller = new AbortController();
        const pending = runShellCall({ command: "setTimeout(() => {}, 30000)" }, nodeCtx({ signal: controller.signal }));
        setTimeout(() => controller.abort(), 200);
        const result = await pending;
        expect(result.text).toMatch(/^Command stopped: the run was aborted\./);
    });

    it("returns an output up to the cap whole, with no file", async () => {
        const result = await runShellCall({ command: `process.stdout.write("c".repeat(${FOREGROUND_OUTPUT_CAP}))` }, nodeCtx());
        if (result.kind !== "foreground") { throw new Error(result.kind); }
        expect(result.text).toBe("c".repeat(FOREGROUND_OUTPUT_CAP));
        expect(result.summary.logPath).toBeUndefined();
        expect(existsSync(join(scratchpad, "tasks"))).toBe(false);
    });

    it("spills a long output to the scratchpad and previews its start", async () => {
        const length = FOREGROUND_OUTPUT_CAP + 5_000;
        const result = await runShellCall({ command: `process.stdout.write("BEGIN" + "a".repeat(${length - 8}) + "END")` }, nodeCtx());
        if (result.kind !== "foreground") { throw new Error(result.kind); }
        expect(result.summary.logPath?.startsWith(join(scratchpad, "tasks"))).toBe(true);
        expect(readFileSync(result.summary.logPath, "utf8")).toHaveLength(length);
        expect(result.text.startsWith(`<persisted-output>\nOutput too large (34.2KB). Full output saved to: ${result.summary.logPath}\n`)).toBe(true);
        expect(result.text).toContain("Preview (first 2KB):\nBEGINaaa");
        expect(result.text).not.toContain("END");
        expect(result.text.length).toBeLessThan(3_000);
    });

    it("keeps the whole output in the file even past what the run holds in memory", async () => {
        const length = MAX_PROCESS_OUTPUT_CHARS + 50_000;
        const script = `process.stdout.write("BEGIN"); for (let i = 0; i < ${length - 8}; i += 1000) process.stdout.write("d".repeat(Math.min(1000, ${length - 8} - i))); process.stdout.write("END")`;
        const result = await runShellCall({ command: script }, nodeCtx());
        if (result.kind !== "foreground") { throw new Error(result.kind); }
        const saved = readFileSync(result.summary.logPath, "utf8");
        expect(saved).toHaveLength(length);
        expect(saved.startsWith("BEGIN") && saved.endsWith("END")).toBe(true);
        expect(result.text).toContain("Preview (first 2KB):\nBEGINddd");
    });

    it("previews the start without a scratchpad, and says nothing else survives", async () => {
        const length = FOREGROUND_OUTPUT_CAP + 10;
        const result = await runShellCall({ command: `process.stdout.write("b".repeat(${length}))` }, nodeCtx({ scratchpadDir: undefined }));
        expect(result.kind === "foreground" && result.summary.logPath).toBeUndefined();
        expect(result.text).toContain("could not be saved to a file. Only this preview survives");
        expect(result.text).toContain("Preview (first 2KB):\nbbb");
    });

    it("keeps a failure's status line above the persisted output", async () => {
        const result = await runShellCall({ command: `process.stdout.write("e".repeat(${FOREGROUND_OUTPUT_CAP + 1})); process.exit(3)` }, nodeCtx());
        expect(result.text.startsWith("Command failed (exit code 3).\n\n<persisted-output>\n")).toBe(true);
        expect(result.kind === "foreground" && result.finish).toBe("failed (exit code 3)");
    });

    it("runs the wrapped command", async () => {
        const result = await runShellCall({ command: "ignored" }, nodeCtx({ wrapCommand: () => 'console.log("wrapped")' }));
        expect(result.text.trim()).toBe("wrapped");
    });
});

describe("runShellCall: background", () => {
    it("starts a task on the registry, spooled to the scratchpad", async () => {
        const result = await runShellCall(
            { command: 'console.log("done")', run_in_background: true, description: "probe" },
            nodeCtx(),
        );
        if (result.kind !== "background") { throw new Error(result.kind); }
        expect(result.logPath).toBe(join(scratchpad, "tasks", result.taskId, "output.log"));
        expect(result.text).toContain(`Bash task ${result.taskId} is running in the background (probe).`);
        expect(result.text).toContain("kill_task");
        const task = getBackgroundTask(result.taskId) as BackgroundShell;
        expect(task.kind).toBe("shell");
        expect(task.command).toBe('console.log("done")');
        await until(() => task.completed);
        expect(task.finishStatus).toBe("completed");
        await until(() => readFileSync(result.logPath, "utf8").includes("done"));
    });

    it("has no default timeout, and honours an explicit one", async () => {
        const result = await runShellCall({ command: "setTimeout(() => {}, 30000)", run_in_background: true, timeout: 200 }, nodeCtx());
        if (result.kind !== "background") { throw new Error(result.kind); }
        const task = getBackgroundTask(result.taskId) as BackgroundShell;
        await until(() => task.completed);
        expect(task.finishStatus).toBe("failed");
        expect(task.finishDetail).toContain("timed out");
    });

    it("keeps the task running when the run aborts: it outlives the turn", async () => {
        const controller = new AbortController();
        const result = await runShellCall(
            { command: "setTimeout(() => {}, 30000)", run_in_background: true },
            nodeCtx({ signal: controller.signal }),
        );
        if (result.kind !== "background") { throw new Error(result.kind); }
        const task = getBackgroundTask(result.taskId) as BackgroundShell;
        controller.abort();
        await new Promise((r) => setTimeout(r, 300));
        expect(task.completed).toBe(false);
    });

    it("starts a background `bal run` as a service through startService, not as a chat task", async () => {
        const starts: { cwd: string; packagePath: string }[] = [];
        const result = await runShellCall(
            { command: "cd pkg && bal run", run_in_background: true, description: "Start the service" },
            nodeCtx({
                startService: async ({ cwd, packagePath }) => {
                    starts.push({ cwd, packagePath });
                    return { kind: "started", taskId: "task-service-0000aaaa", output: "Running executable\n" };
                },
            }),
        );
        expect(result.kind).toBe("service");
        expect(starts).toEqual([{ cwd: root, packagePath: join(root, "pkg") }]);
        expect(result.text).toContain("Service task-service-0000aaaa is running (Start the service)");
        expect(result.text).toContain("Startup output:\nRunning executable");
        expect(listBackgroundTasks()).toHaveLength(0);
    });

    it("reports a service that exited before it was ready", async () => {
        const result = await runShellCall(
            { command: "bal run", run_in_background: true },
            nodeCtx({ startService: async () => ({ kind: "failed", exitCode: 1, output: "error: compilation failed", timedOut: false }) }),
        );
        expect(result.text).toBe("The service exited with code 1 before it was ready.\n\nerror: compilation failed");
    });
});

describe("runShellCall: bash", () => {
    posixOnly("reads a search's or a diff's exit 1 as plain output, and a real exit 1 as a failure", async () => {
        const ctx = nodeCtx({ spawn: bashSpawn(), guard: bashGuardReason });
        writeFileSync(join(root, "a.txt"), "hello\n");
        writeFileSync(join(root, "b.txt"), "hellO\n");
        const noMatch = await runShellCall({ command: "grep absent a.txt" }, ctx);
        if (noMatch.kind !== "foreground") { throw new Error(noMatch.kind); }
        expect(noMatch.summary.exitCode).toBe(1);
        expect(noMatch.finish).toBe("completed");
        expect(noMatch.text).toBe(EMPTY_OUTPUT_MARKER);
        const differ = await runShellCall({ command: "diff a.txt b.txt" }, ctx);
        expect(differ.text).toBe("1c1\n< hello\n---\n> hellO\n");
        const gated = await runShellCall({ command: "test -e a.txt && grep absent a.txt" }, ctx);
        expect(gated.text).toBe("Command failed (exit code 1).\n\n" + EMPTY_OUTPUT_MARKER);
        const missing = await runShellCall({ command: "diff a.txt missing.txt" }, ctx);
        expect(missing.text).toMatch(/^Command failed \(exit code 2\)\./);
    });

    posixOnly("finishes a background search with no match as completed", async () => {
        const ctx = nodeCtx({ spawn: bashSpawn(), guard: bashGuardReason });
        writeFileSync(join(root, "a.txt"), "hello\n");
        const result = await runShellCall({ command: "grep absent a.txt", run_in_background: true }, ctx);
        if (result.kind !== "background") { throw new Error(result.kind); }
        const task = getBackgroundTask(result.taskId) as BackgroundShell;
        await until(() => task.completed);
        expect(task.exitCode).toBe(1);
        expect(task.finishStatus).toBe("completed");
        expect(task.success).toBe(true);
    });

    posixOnly("runs /bin/bash with the bash guards", async () => {
        const ctx = nodeCtx({ spawn: bashSpawn(), guard: bashGuardReason });
        const failed = await runShellCall({ command: "echo one && echo two && exit 2" }, ctx);
        expect(failed.text).toBe("Command failed (exit code 2).\n\none\ntwo\n");
        // stderr is merged into the output (its order against stdout is not guaranteed across pipes).
        expect((await runShellCall({ command: "echo err >&2" }, ctx)).text).toBe("err\n");
        const refused = await runShellCall({ command: "sleep 30" }, ctx);
        expect(refused.kind).toBe("refused");
    });
});

describe("bash tool description", () => {
    it("covers what the design asks of it, in BI's names", () => {
        const text = bashToolDescription();
        for (const part of ["/bin/bash", "workspace root", "one plain command per call", "scratchpad", "600000", "run_in_background: true", "task_output", "kill_task", "task-service-", "getCompilationErrors", "--no-verify"]) {
            expectLabeled(text.includes(part), part).toBe(true);
        }
        expect(text).not.toMatch(/Claude|monitor|task_stop|pi\b/);
    });
});
