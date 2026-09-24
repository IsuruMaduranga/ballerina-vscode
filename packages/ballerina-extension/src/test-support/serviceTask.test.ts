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
 * Services (a background `bal run`) read and stopped through task_output / kill_task
 * (tools/service-task.ts, tools/task-tools.ts): the new-output cursor, the blocking read, the stop
 * outcomes, and the events the UI renders as service cards.
 */
import type { ToolExecutionOptions } from "ai";
import type { RunningService, RunningServicesManager } from "../features/ai/agent/tools/running-service-manager";
import {
    isServiceTaskId,
    newServiceTaskId,
    readServiceOutput,
    runningServicesReminder,
    serviceReadText,
    stopServiceTask,
} from "../features/ai/agent/tools/service-task";
import { createKillTaskTool, createTaskOutputTool } from "../features/ai/agent/tools/task-tools";
import { registerBackgroundTask, resetBackgroundTasksForTests } from "../features/ai/agent/background/registry";
import type { BackgroundShell } from "../features/ai/agent/background/types";

function fakeService(logs: string[] = []): RunningService {
    return {
        taskId: newServiceTaskId(),
        process: {} as RunningService["process"],
        logs,
        logCursor: 0,
        packagePath: "/work/orders",
        startedAt: Date.now(),
        exited: false,
        exitCode: -1,
    };
}

/** The manager surface the task tools use, over a plain map. */
function fakeManager(...services: RunningService[]) {
    const map = new Map(services.map((s) => [s.taskId, s]));
    const stopped: string[] = [];
    const manager = {
        get: (id: string) => map.get(id),
        getAll: () => [...map.values()].map(({ taskId, packagePath, startedAt, exited, exitCode }) => ({ taskId, packagePath, startedAt, exited, exitCode })),
        remove: (id: string) => map.delete(id),
        stopOne: async (id: string) => {
            stopped.push(id);
            const service = map.get(id);
            if (service) { service.exited = true; service.exitCode = 143; }
            return map.delete(id);
        },
    };
    return { manager: manager as unknown as RunningServicesManager, map, stopped };
}

const execOptions = (toolCallId: string) => ({ toolCallId, messages: [] }) as ToolExecutionOptions;

describe("service task ids", () => {
    it("share the task- namespace and are recognised by prefix", () => {
        const id = newServiceTaskId();
        expect(id).toMatch(/^task-service-[0-9a-f]{8}$/);
        expect(isServiceTaskId(id)).toBe(true);
        expect(isServiceTaskId("task-shell-0123abcd")).toBe(false);
    });
});

describe("readServiceOutput", () => {
    it("returns only the output printed since the last read", async () => {
        const service = fakeService(["started\n"]);
        expect((await readServiceOutput(service, { block: false, timeoutMs: 1000 })).logs).toBe("started\n");
        service.logs.push("GET /orders 200\n");
        const second = await readServiceOutput(service, { block: false, timeoutMs: 1000 });
        expect(second).toEqual({ status: "running", logs: "GET /orders 200\n" });
        expect((await readServiceOutput(service, { block: false, timeoutMs: 1000 })).logs).toBe("");
    });

    it("blocks until new output arrives", async () => {
        const service = fakeService();
        setTimeout(() => service.logs.push("late line\n"), 30);
        const read = await readServiceOutput(service, { block: true, timeoutMs: 2000, pollMs: 10 });
        expect(read.logs).toBe("late line\n");
    });

    it("stops blocking at the timeout with nothing new", async () => {
        const started = Date.now();
        const read = await readServiceOutput(fakeService(), { block: true, timeoutMs: 1000, pollMs: 10 });
        expect(read).toEqual({ status: "running", logs: "" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it("reports an exited service with its exit code", async () => {
        const service = fakeService(["boom\n"]);
        service.exited = true;
        service.exitCode = 1;
        expect(await readServiceOutput(service, { block: true, timeoutMs: 1000 })).toEqual({ status: "exited", exitCode: 1, logs: "boom\n" });
    });
});

describe("serviceReadText", () => {
    it("names the package and says when nothing is new", () => {
        const service = fakeService();
        expect(serviceReadText(service.taskId, service, { status: "running", logs: "" }))
            .toBe(`Service ${service.taskId} ("bal run (orders)") is running. No new output since the last read.`);
    });
});

describe("stopServiceTask", () => {
    it("stops a running service", async () => {
        const service = fakeService();
        const { manager, stopped } = fakeManager(service);
        expect(await stopServiceTask(manager, service.taskId)).toBe("stopped");
        expect(stopped).toEqual([service.taskId]);
    });

    it("forgets an exited service without killing it", async () => {
        const service = fakeService();
        service.exited = true;
        const { manager, map, stopped } = fakeManager(service);
        expect(await stopServiceTask(manager, service.taskId)).toBe("already_exited");
        expect(stopped).toEqual([]);
        expect(map.size).toBe(0);
    });

    it("reports an unknown id", async () => {
        expect(await stopServiceTask(fakeManager().manager, "task-service-00000000")).toBe("not_found");
    });
});

describe("task_output and kill_task on a service id", () => {
    it("task_output reads the service and tags its events as a service", async () => {
        const service = fakeService(["ready\n"]);
        const { manager } = fakeManager(service);
        const events: any[] = [];
        const out = String(await createTaskOutputTool((e) => events.push(e), "run-a", manager)
            .execute!({ task_id: service.taskId, block: false }, execOptions("c1")));
        expect(out).toContain("is running. New output since the last read:\n\nready\n");
        expect(events.map((e) => [e.type, e.toolInput?.kind ?? e.toolOutput?.kind])).toEqual([["tool_call", "service"], ["tool_result", "service"]]);
        expect(events[1].toolOutput).toMatchObject({ status: "running", logs: "ready\n", description: "bal run (orders)" });
    });

    it("a service is reachable from any run key", async () => {
        const service = fakeService();
        const { manager } = fakeManager(service);
        const out = String(await createTaskOutputTool(() => {}, "some-other-run", manager)
            .execute!({ task_id: service.taskId, block: false }, execOptions("c2")));
        expect(out).toContain("is running.");
    });

    it("kill_task stops the service", async () => {
        const service = fakeService();
        const { manager, stopped } = fakeManager(service);
        const events: any[] = [];
        const out = String(await createKillTaskTool((e) => events.push(e), "run-a", manager).execute!({ task_id: service.taskId }, execOptions("c3")));
        expect(out).toBe(`Service ${service.taskId} ("bal run (orders)") stopped.`);
        expect(stopped).toEqual([service.taskId]);
        expect(events[1]).toMatchObject({ type: "tool_result", toolOutput: { kind: "service", status: "stopped" } });
    });

    it("an unknown service id fails with a restart hint", async () => {
        const events: any[] = [];
        const out = String(await createTaskOutputTool((e) => events.push(e), "run-a", fakeManager().manager)
            .execute!({ task_id: "task-service-00000000" }, execOptions("c4")));
        expect(out).toContain("start it again with `bal run` and run_in_background: true.");
        expect(out).toContain("Call task_output with no task_id to list the running services");
        expect(events[1]).toMatchObject({ failed: true, toolOutput: { status: "not_found", kind: "service" } });
    });
});

describe("runningServicesReminder", () => {
    it("is empty when no service is running", () => {
        const exited = { ...fakeService(), exited: true };
        expect(runningServicesReminder([])).toBe("");
        expect(runningServicesReminder([exited])).toBe("");
    });

    it("names each running service's id, package and uptime", () => {
        const now = 1_000_000_000;
        const service = { ...fakeService(), startedAt: now - 12 * 60_000 };
        const fresh = { ...fakeService(), packagePath: "/work/billing", startedAt: now - 5_000 };
        const reminder = runningServicesReminder([service, fresh], now);
        expect(reminder).toMatch(/^<system-reminder>\n[\s\S]*\n<\/system-reminder>$/);
        expect(reminder).toContain(`- ${service.taskId}: bal run (orders) at /work/orders, running for 12 minutes`);
        expect(reminder).toContain(`- ${fresh.taskId}: bal run (billing) at /work/billing, running for less than a minute`);
        expect(reminder).toContain(`Services running as of ${new Date(now).toUTCString()}, when this message was sent`);
        expect(reminder).toContain("may be out of date by a later turn");
    });
});

describe("task_output with no task id", () => {
    afterEach(() => resetBackgroundTasksForTests());

    function fakeShell(runKey: string, completed = false): BackgroundShell {
        return {
            kind: "shell", id: `task-shell-${runKey}`, description: "Watch the build", runKey, toolCallId: "t",
            startTime: new Date(), output: "", completed, success: completed ? true : null, aborted: false,
            abortController: new AbortController(), notified: false, toolName: "shell", command: "bal build --watch",
            cwd: "/work", exitCode: null, peek: () => "",
        };
    }

    it("lists this chat's tasks and every running service, not another chat's tasks", async () => {
        registerBackgroundTask(fakeShell("run-a"));
        registerBackgroundTask(fakeShell("run-b"));
        const service = fakeService();
        const events: any[] = [];
        const out = String(await createTaskOutputTool((e) => events.push(e), "run-a", fakeManager(service).manager).execute!({}, execOptions("c5")));
        expect(out).toContain("- task-shell-run-a (shell command, running): Watch the build");
        expect(out).not.toContain("task-shell-run-b");
        expect(out).toContain(`Running services (any chat):\n- ${service.taskId}: bal run (orders) at /work/orders`);
        expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
        expect(events[1].toolOutput).toEqual({ list: true, status: "listed", running: 2 });
    });

    it("says so when nothing exists", async () => {
        const out = String(await createTaskOutputTool(() => {}, "run-a", fakeManager().manager).execute!({}, execOptions("c6")));
        expect(out).toBe("This chat has no background tasks.\n\nNo services are running.");
    });
});
