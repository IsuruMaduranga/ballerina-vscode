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
 * When a finished background command wakes its idle chat (background/wake.ts). A wrong call either
 * leaves the agent claiming a service is up after its command died unnoticed, or restarts work the user
 * just stopped, or reports one completion twice.
 */
import { getBackgroundTask, registerBackgroundTask, resetBackgroundTasksForTests } from "../features/ai/agent/background/registry";
import type { BackgroundShell } from "../features/ai/agent/background/types";
import { BackgroundWake, type WakeHost } from "../features/ai/agent/background/wake";

const CHAT = "/work/proj|thread-a";
const COALESCE_MS = 10;

function finishedShell(id: string, runKey = CHAT): BackgroundShell {
    const task: BackgroundShell = {
        kind: "shell", id, runKey, toolCallId: "c", toolName: "shell", command: "bal build", cwd: "/work/proj",
        description: `build ${id}`, startTime: new Date(), completedAt: new Date(), output: "done", completed: true,
        success: true, aborted: false, abortController: new AbortController(), notified: false, exitCode: 0,
        finishStatus: "completed", peek: () => "",
    };
    registerBackgroundTask(task);
    return task;
}

function fakeHost(state: { busy?: boolean; accept?: boolean } = {}) {
    const wakes: { runKey: string; notes: string[]; taskIds: string[] }[] = [];
    const host: WakeHost = {
        isChatBusy: () => state.busy === true,
        requestWake: (runKey, notes, taskIds) => {
            if (state.accept === false) { return false; }
            wakes.push({ runKey, notes, taskIds });
            return true;
        },
    };
    return { host, wakes, state };
}

const settle = () => new Promise((r) => setTimeout(r, COALESCE_MS * 5));

beforeEach(() => resetBackgroundTasksForTests());

describe("BackgroundWake", () => {
    it("wakes an idle chat once, and marks the completion delivered only when the run takes it", async () => {
        const { host, wakes } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        const task = finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(1);
        expect(wakes[0].taskIds).toEqual([task.id]);
        expect(wakes[0].notes[0]).toContain('Background command "build task-shell-00000001" completed');
        expect(getBackgroundTask(task.id)!.notified).toBe(false);

        wake.runStarted(CHAT, "task_notification");
        expect(wake.takePendingForRun(CHAT, [task.id])).toEqual({ notes: [], taskIds: [task.id] });
        expect(getBackgroundTask(task.id)!.notified).toBe(true);
    });

    it("merges completions that land inside the window into one wake", async () => {
        const { host, wakes } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        finishedShell("task-shell-00000002");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(1);
        expect(wakes[0].taskIds).toEqual(["task-shell-00000001", "task-shell-00000002"]);
    });

    it("leaves a busy chat to its running turn, then wakes it when the turn ends", async () => {
        const { host, wakes, state } = fakeHost({ busy: true });
        const wake = new BackgroundWake(host, COALESCE_MS);
        finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(0);

        state.busy = false;
        wake.runEnded(CHAT, false);
        await settle();
        expect(wakes).toHaveLength(1);
    });

    it("never wakes after the user stopped the turn; the user's next message carries the notice", async () => {
        const { host, wakes } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        wake.runEnded(CHAT, true);
        const task = finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(0);

        wake.runStarted(CHAT, "user");
        const { notes } = wake.takePendingForRun(CHAT);
        expect(notes).toHaveLength(1);
        expect(getBackgroundTask(task.id)!.notified).toBe(true);
    });

    it("asks once while a wake is on its way; the run it starts takes the later completions", async () => {
        const { host, wakes } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        await settle();
        finishedShell("task-shell-00000002");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(1);

        wake.runStarted(CHAT, "task_notification");
        expect(wake.takePendingForRun(CHAT, ["task-shell-00000001"]).notes).toHaveLength(1);
    });

    it("keeps the completion pending when no panel can take the wake", async () => {
        const { host, wakes } = fakeHost({ accept: false });
        const wake = new BackgroundWake(host, COALESCE_MS);
        const task = finishedShell("task-shell-00000001");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes).toHaveLength(0);
        expect(getBackgroundTask(task.id)!.notified).toBe(false);
        expect(wake.takePendingForRun(CHAT).notes).toHaveLength(1);
    });

    it("gives the completions back when the run that took them never started", () => {
        const { host } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        const carried = finishedShell("task-shell-00000001");
        const held = finishedShell("task-shell-00000002");
        const { taskIds } = wake.takePendingForRun(CHAT, [carried.id]);
        expect(taskIds).toEqual([carried.id, held.id]);
        wake.returnUndelivered(taskIds);
        expect(wake.takePendingForRun(CHAT).notes).toHaveLength(2);
    });

    it("wakes a chat with its own completions only", async () => {
        const { host, wakes } = fakeHost();
        const wake = new BackgroundWake(host, COALESCE_MS);
        finishedShell("task-shell-00000001", "/work/proj|thread-b");
        finishedShell("task-shell-00000002");
        wake.taskFinished(CHAT);
        await settle();
        expect(wakes[0].taskIds).toEqual(["task-shell-00000002"]);
    });
});
