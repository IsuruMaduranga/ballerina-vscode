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
 * Background shell commands on the shared registry (shell/background.ts, background/registry.ts,
 * tools/task-tools.ts) against real `node -e` children: completion notices, task_output delivery and
 * withdrawal, kill_task, surviving the run's end, and the stops from outside (the user, a chat change,
 * VS Code closing). Each of these fails silently in production (a command that never reports, a notice
 * repeated after task_output returned it, a service killed when the turn ends).
 */
import type { ToolExecutionOptions } from "ai";
import type { ChatNotify } from "@wso2/ballerina-core";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    cleanupRunningBackgroundTasks,
    drainBackgroundTaskNotifications,
    getBackgroundSubagent,
    getBackgroundTask,
    onBackgroundTaskFinished,
    onBackgroundTasksChanged,
    resetBackgroundTasksForTests,
    runningChatShellTasks,
    stopAllBackgroundTasks,
    stopChatShellTasks,
} from "../../features/ai/agent/background/registry";
import { startBackgroundShell, type StartBackgroundShellOptions } from "../../features/ai/agent/shell/background";
import type { BackgroundShell } from "../../features/ai/agent/background/types";
import { createKillTaskTool, createTaskOutputTool } from "../../features/ai/agent/tools/task-tools";

const RUN = "run-a";
const execOptions = (toolCallId: string): ToolExecutionOptions => ({ toolCallId, messages: [] });

function start(script: string, overrides: Partial<StartBackgroundShellOptions> = {}): BackgroundShell {
    const result = startBackgroundShell({
        runKey: RUN,
        toolCallId: "call-1",
        toolName: "shell",
        command: `node -e ${script}`,
        description: "probe",
        launch: { command: process.execPath, args: ["-e", script] },
        cwd: process.cwd(),
        ...overrides,
    });
    if (result.kind !== "started") { throw new Error(result.reason); }
    return result.task;
}

async function until(predicate: () => boolean, limitMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > limitMs) { throw new Error("condition not met in time"); }
        await new Promise((r) => setTimeout(r, 20));
    }
}

beforeEach(() => resetBackgroundTasksForTests());
afterEach(() => { stopAllBackgroundTasks(); resetBackgroundTasksForTests(); });

describe("startBackgroundShell", () => {
    it("registers a shell task in the shared id namespace, never as a subagent", () => {
        const task = start("setTimeout(() => {}, 30000)");
        expect(task.id).toMatch(/^task-shell-[0-9a-f]{8}$/);
        expect(getBackgroundTask(task.id)).toBe(task);
        expect(getBackgroundSubagent(task.id)).toBeUndefined();
    });

    it("reports a clean finish once, with the exit code and the output tail", async () => {
        const task = start("console.log('built ok')");
        await until(() => task.completed);
        expect(task.success).toBe(true);
        expect(task.finishStatus).toBe("completed");
        const notice = drainBackgroundTaskNotifications(RUN);
        expect(notice).toContain('Background command "probe" completed (exit code 0)');
        expect(notice).toContain(task.id);
        expect(notice).toContain("built ok");
        expect(drainBackgroundTaskNotifications(RUN)).toBe("");
    });

    it("names the output file instead of a tail when the output was spooled", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-shell-"));
        try {
            const logPath = join(dir, "output.log");
            const task = start("console.log('x'.repeat(10))", { logPath });
            await until(() => task.completed);
            const notice = drainBackgroundTaskNotifications(RUN);
            expect(notice).toContain(`Output file: ${logPath}`);
            expect(notice).not.toContain("xxxxxxxxxx");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports a non-zero exit and a timeout as failures with their detail", async () => {
        const failed = start("process.exit(2)");
        const slow = start("setTimeout(() => {}, 30000)", { timeoutMs: 200, description: "slow" });
        await until(() => failed.completed && slow.completed);
        expect(failed.success).toBe(false);
        expect(slow.finishDetail).toBe("timed out after 200ms");
        const notice = drainBackgroundTaskNotifications(RUN);
        expect(notice).toContain('Background command "probe" failed with exit code 2');
        expect(notice).toContain('Background command "slow" failed');
        expect(notice).toContain("(timed out after 200ms)");
    });

    it("tells finish listeners about a command that finished on its own, and change listeners about every step", async () => {
        const finished: string[] = [];
        let changes = 0;
        const offFinish = onBackgroundTaskFinished((t) => finished.push(t.id));
        const offChange = onBackgroundTasksChanged(() => { changes++; });
        try {
            const task = start("process.exit(0)");
            expect(changes).toBe(1);
            await until(() => task.completed);
            expect(finished).toEqual([task.id]);
            expect(changes).toBe(2);
        } finally {
            offFinish();
            offChange();
        }
    });
});

describe("task_output and kill_task on a shell task", () => {
    it("returns a running command's output so far without blocking", async () => {
        const events: ChatNotify[] = [];
        const task = start("console.log('step 1'); setTimeout(() => {}, 30000)");
        await until(() => task.peek().includes("step 1"));
        const out = await createTaskOutputTool(e => events.push(e), RUN).execute!({ task_id: task.id, block: false }, execOptions("c1"));
        expect(String(out)).toContain("is still running");
        expect(String(out)).toContain("Output so far:\nstep 1");
        expect(events[0]).toMatchObject({ type: "tool_call", toolInput: { task_id: task.id, command: task.command, kind: "shell" } });
    });

    it("blocks until the command finishes, returns its output, and withdraws the completion notice", async () => {
        const task = start("setTimeout(() => { console.log('done'); process.exit(1) }, 200)");
        const out = String(await createTaskOutputTool(() => {}, RUN).execute!({ task_id: task.id, timeout: 5000 }, execOptions("c2")));
        expect(out).toContain(`Task ${task.id} ("probe") failed (exit code 1).`);
        expect(out).toContain("done");
        expect(drainBackgroundTaskNotifications(RUN)).toBe("");
    });

    it("kill_task stops the process tree and the late finish is not reported", async () => {
        const task = start("setTimeout(() => {}, 30000)");
        const child = () => task.abortController.signal.aborted;
        const out = String(await createKillTaskTool(() => {}, RUN).execute!({ task_id: task.id }, execOptions("c3")));
        expect(out).toContain("terminated");
        expect(child()).toBe(true);
        expect(task.output).toBe(`Background command ${task.id} was stopped by request.`);
        expect(getBackgroundTask(task.id)).toBeUndefined();
        await new Promise((r) => setTimeout(r, 300));
        expect(task.finishStatus).toBeUndefined();
        expect(drainBackgroundTaskNotifications(RUN)).toBe("");
    });

    it("outlives the run: run-end cleanup leaves a shell command running", () => {
        const task = start("setTimeout(() => {}, 30000)");
        expect(cleanupRunningBackgroundTasks(RUN)).toBe(0);
        expect(task.completed).toBe(false);
        expect(task.abortController.signal.aborted).toBe(false);
    });

    it("a chat change stops the chat's commands and keeps them unreported, so its agent is told next turn", async () => {
        const finished: string[] = [];
        const off = onBackgroundTaskFinished((t) => finished.push(t.id));
        try {
            const mine = start("setTimeout(() => {}, 30000)", { description: "watch" });
            const other = start("setTimeout(() => {}, 30000)", { runKey: "run-b" });
            expect(runningChatShellTasks(RUN).map(t => t.id)).toEqual([mine.id]);
            expect(stopChatShellTasks(RUN, "because the user changed chats")).toBe(1);
            expect(mine.abortController.signal.aborted).toBe(true);
            expect(mine.output).toBe(`Background command ${mine.id} was stopped because the user changed chats.`);
            expect(other.completed).toBe(false);
            expect(getBackgroundTask(mine.id)).toBe(mine);
            expect(drainBackgroundTaskNotifications(RUN)).toContain('Background command "watch" was stopped');
            await new Promise((r) => setTimeout(r, 300));
            expect(finished).toEqual([]);
        } finally {
            off();
        }
    });

    it("VS Code closing stops every chat's commands", () => {
        const a = start("setTimeout(() => {}, 30000)");
        const b = start("setTimeout(() => {}, 30000)", { runKey: "run-b" });
        expect(stopAllBackgroundTasks()).toBe(2);
        expect(a.output).toContain("because VS Code closed");
        expect(b.abortController.signal.aborted).toBe(true);
    });

    it("keeps another run's shell task invisible", async () => {
        const task = start("setTimeout(() => {}, 30000)", { runKey: "run-b" });
        const out = String(await createTaskOutputTool(() => {}, RUN).execute!({ task_id: task.id, block: false }, execOptions("c4")));
        expect(out).toContain("Task not found");
    });
});
