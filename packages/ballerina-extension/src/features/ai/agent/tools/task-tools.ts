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
 * `task_output` and `kill_task` — the background-task half of the MI Copilot's task workflow, for
 * background subagents and background shell commands alike (one id namespace, one registry:
 * `background/registry.ts`). They also read and stop the services a background `bal run` starts, which
 * live outside that registry and outlive the turn (`./service-task.ts`).
 *
 * `task_output` with block=true is the wait-and-wake point: the main agent's step blocks inside this call,
 * the UI shows a waiting row, and the promise resolves the moment the task finishes. Without a task id it
 * lists this chat's background tasks and every running service instead.
 */

import { tool } from "ai";
import { z } from "zod";
import { CopilotEventHandler } from "../../utils/events";
import { KILL_TASK_TOOL_NAME, TASK_OUTPUT_TOOL_NAME } from "../subagents/types";
import { getBackgroundTask, listBackgroundTasks, NOTIFY_OUTPUT_CAP, removeBackgroundTask, terminatedOutput } from "../background/registry";
import type { BackgroundTask } from "../background/types";
import { tailCap } from "../shell/output";
import { finishedOutputText, FOREGROUND_OUTPUT_CAP } from "../shell/shell-call";
import { RunningServicesManager, runningServicesManager } from "./running-service-manager";
import { isServiceTaskId, readServiceOutput, runningServiceLines, serviceDescription, serviceNotFoundText, serviceReadText, stopServiceTask } from "./service-task";

export const TASK_OUTPUT_DEFAULT_BLOCK_MS = 120_000;
export const TASK_OUTPUT_MAX_BLOCK_MS = 600_000;
const POLL_INTERVAL_MS = 500;

/** The kind-specific fields of a task, for the UI's tool row. */
function taskLabel(task: BackgroundTask | undefined): Record<string, unknown> {
    if (!task) { return {}; }
    return task.kind === "subagent"
        ? { description: task.description, subagent_type: task.subagentType }
        : { description: task.description, command: task.command, kind: "shell" };
}

/** A failed shell task names why (`exit code 2`, `timed out after 120s`); a subagent's report says it. */
function failureDetail(task: BackgroundTask): string {
    if (task.kind !== "shell") { return ""; }
    const detail = task.finishDetail ?? (task.exitCode !== null && task.exitCode !== undefined ? `exit code ${task.exitCode}` : undefined);
    return detail ? ` (${detail})` : "";
}

/**
 * `runKey` is the chat that owns the tools. A background task belongs to its chat, so a task id from another
 * chat reads as not found. A service (`task-service-…`) belongs to the project and is reachable from any chat.
 */
export function createTaskOutputTool(eventHandler: CopilotEventHandler, runKey: string, services: RunningServicesManager = runningServicesManager) {
    return tool({
        description: `Get the result of a background task (a subagent or a shell command started with run_in_background) by task id. block=true (default) waits until it completes — use this when you have no other work to do; you are woken as soon as it finishes. block=false returns the current status immediately, with a running shell command's output so far. Not for foreground runs (their result was returned inline).

For a service (a task-service-… id, from a background \`bal run\`), this returns the log output printed since the last read. block=true waits until the service prints something new or exits; block=false reads at once.

Without task_id, this lists this chat's background tasks and every running service, with their ids. Services keep running across the user's chats, so use this to find one started elsewhere.`,
        inputSchema: z.object({
            task_id: z.string().optional().describe("The task id returned by the tool that started the background task. Omit it to list the tasks and services."),
            block: z.boolean().optional().describe("Wait for completion (default true)."),
            timeout: z.number().int().optional().describe(`Maximum wait in milliseconds when block=true (default ${TASK_OUTPUT_DEFAULT_BLOCK_MS}, max ${TASK_OUTPUT_MAX_BLOCK_MS}).`),
        }),
        execute: async ({ task_id, block = true, timeout = TASK_OUTPUT_DEFAULT_BLOCK_MS }, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => {
            const toolCallId = options?.toolCallId ?? `fallback-${Date.now()}`;
            if (!task_id) {
                return listTasks(eventHandler, services, runKey, toolCallId);
            }
            if (isServiceTaskId(task_id)) {
                return readService(eventHandler, services, { task_id, block, timeout }, toolCallId, options?.abortSignal);
            }
            const found = getBackgroundTask(task_id);
            const task = found && found.runKey === runKey ? found : undefined;
            eventHandler({
                type: "tool_call",
                toolName: TASK_OUTPUT_TOOL_NAME,
                toolInput: { task_id, block, ...taskLabel(task) },
                toolCallId,
            });

            if (!task) {
                eventHandler({ type: "tool_result", toolName: TASK_OUTPUT_TOOL_NAME, toolOutput: { task_id, status: "not_found" }, toolCallId, failed: true });
                return `Task not found: ${task_id}. No background task with that id exists — it may have completed and been cleaned up, or it was a foreground run whose result was already returned. Call ${TASK_OUTPUT_TOOL_NAME} with no task_id to list the tasks and services.`;
            }

            const finish = (status: "completed" | "running" | "aborted" | "failed", waitedMs = 0): string => {
                eventHandler({ type: "tool_result", toolName: TASK_OUTPUT_TOOL_NAME, toolOutput: { task_id, status, description: task.description }, toolCallId, failed: status === "failed" });
                if (status === "running") {
                    const waited = waitedMs > 0 ? ` after ${Math.round(waitedMs / 1000)}s` : "";
                    const soFar = task.kind === "shell" ? task.peek() : "";
                    const interim = soFar
                        ? `\n\nOutput so far:\n${tailCap(soFar, NOTIFY_OUTPUT_CAP)}`
                        : "";
                    return `Task ${task_id} ("${task.description}") is still running${waited}. Call ${TASK_OUTPUT_TOOL_NAME} again to keep waiting, or ${KILL_TASK_TOOL_NAME} to stop it.${interim}`;
                }
                // The model now has the result: the completion reminder for it is withdrawn.
                task.notified = true;
                const header = status === "completed"
                    ? `Task ${task_id} ("${task.description}") completed.`
                    : `Task ${task_id} ("${task.description}") ${status === "aborted" ? "was aborted" : `failed${failureDetail(task)}`}.`;
                // A finished command's output is cut as a foreground result's is, start first; past the cap
                // the block names the file, so the line naming it is only for an output shown whole.
                const summary = task.kind === "shell" ? task.summary : undefined;
                const output = summary ? finishedOutputText(summary) : task.output;
                const logLine = task.kind === "shell" && task.logPath && (!summary || summary.length <= FOREGROUND_OUTPUT_CAP) ? `\nFull output: ${task.logPath}` : "";
                return `${header}${logLine}\n\n${output}`;
            };

            const effectiveTimeout = Math.min(Math.max(timeout, 1000), TASK_OUTPUT_MAX_BLOCK_MS);

            if (task.completed) { return finish(taskStatus(task)); }
            if (!block) { return finish("running"); }

            return new Promise<string>((resolve) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (task.completed) {
                        clearInterval(timer);
                        resolve(finish(taskStatus(task)));
                    } else if (options?.abortSignal?.aborted) {
                        clearInterval(timer);
                        resolve(finish("running", Date.now() - started));
                    } else if (Date.now() - started >= effectiveTimeout) {
                        clearInterval(timer);
                        resolve(finish("running", Date.now() - started));
                    }
                }, POLL_INTERVAL_MS);
            });
        },
    });
}

export function createKillTaskTool(eventHandler: CopilotEventHandler, runKey: string, services: RunningServicesManager = runningServicesManager) {
    return tool({
        description: "Terminate a running background task (a subagent or a shell command) by task id. Also stops a service (a task-service-… id, from a background `bal run`), for example to restart it after a code change.",
        inputSchema: z.object({
            task_id: z.string().describe("The task id to terminate."),
        }),
        execute: async ({ task_id }, options?: { toolCallId?: string }) => {
            const toolCallId = options?.toolCallId ?? `fallback-${Date.now()}`;
            if (isServiceTaskId(task_id)) {
                return stopService(eventHandler, services, task_id, toolCallId);
            }
            const found = getBackgroundTask(task_id);
            const task = found && found.runKey === runKey ? found : undefined;
            eventHandler({ type: "tool_call", toolName: KILL_TASK_TOOL_NAME, toolInput: { task_id, ...taskLabel(task) }, toolCallId });
            if (!task) {
                eventHandler({ type: "tool_result", toolName: KILL_TASK_TOOL_NAME, toolOutput: { task_id, status: "not_found" }, toolCallId, failed: true });
                return `Task not found: ${task_id}. Call ${TASK_OUTPUT_TOOL_NAME} with no task_id to list the tasks and services.`;
            }
            if (task.completed) {
                task.notified = true;
                removeBackgroundTask(task_id);
                eventHandler({ type: "tool_result", toolName: KILL_TASK_TOOL_NAME, toolOutput: { task_id, status: "already_completed" }, toolCallId });
                return `Task ${task_id} had already completed; its result is discarded.`;
            }
            task.aborted = true;
            task.completed = true;
            task.success = false;
            task.completedAt = new Date();
            task.notified = true;
            task.output = terminatedOutput(task, "by request");
            task.abortController.abort();
            removeBackgroundTask(task_id);
            eventHandler({ type: "tool_result", toolName: KILL_TASK_TOOL_NAME, toolOutput: { task_id, status: "killed" }, toolCallId });
            return `Task ${task_id} ("${task.description}") terminated.`;
        },
    });
}

/** A task's state: running until it completes, then how it ended. */
function taskStatus(task: BackgroundTask): "running" | "completed" | "aborted" | "failed" {
    if (!task.completed) { return "running"; }
    if (task.aborted) { return "aborted"; }
    return task.success ? "completed" : "failed";
}

/** `task_output` with no id: this chat's background tasks and every running service. */
function listTasks(eventHandler: CopilotEventHandler, services: RunningServicesManager, runKey: string, toolCallId: string): string {
    eventHandler({ type: "tool_call", toolName: TASK_OUTPUT_TOOL_NAME, toolInput: { list: true }, toolCallId });
    const chatTasks = listBackgroundTasks(runKey);
    const tasks = chatTasks.map((t) => {
        const what = t.kind === "subagent" ? `${t.subagentType} subagent` : "shell command";
        return `- ${t.id} (${what}, ${taskStatus(t)}): ${t.description}`;
    });
    const serviceLines = runningServiceLines(services.getAll());
    const running = chatTasks.filter((t) => !t.completed).length + serviceLines.length;
    eventHandler({ type: "tool_result", toolName: TASK_OUTPUT_TOOL_NAME, toolOutput: { list: true, status: "listed", running }, toolCallId });
    const sections = [
        tasks.length > 0 ? `Background tasks of this chat:\n${tasks.join("\n")}` : "This chat has no background tasks.",
        serviceLines.length > 0 ? `Running services (any chat):\n${serviceLines.join("\n")}` : "No services are running.",
    ];
    return sections.join("\n\n");
}

/** `task_output` for a service: its new log output, shown in the UI as a service-logs card. */
async function readService(
    eventHandler: CopilotEventHandler,
    services: RunningServicesManager,
    input: { task_id: string; block: boolean; timeout: number },
    toolCallId: string,
    abortSignal?: AbortSignal,
): Promise<string> {
    const service = services.get(input.task_id);
    const description = service ? serviceDescription(service) : undefined;
    eventHandler({ type: "tool_call", toolName: TASK_OUTPUT_TOOL_NAME, toolInput: { task_id: input.task_id, block: input.block, kind: "service", description }, toolCallId });
    if (!service) {
        eventHandler({ type: "tool_result", toolName: TASK_OUTPUT_TOOL_NAME, toolOutput: { task_id: input.task_id, kind: "service", status: "not_found" }, toolCallId, failed: true });
        return serviceNotFoundText(input.task_id);
    }
    const timeoutMs = Math.min(Math.max(input.timeout, 1000), TASK_OUTPUT_MAX_BLOCK_MS);
    const read = await readServiceOutput(service, { block: input.block, timeoutMs, signal: abortSignal });
    eventHandler({
        type: "tool_result",
        toolName: TASK_OUTPUT_TOOL_NAME,
        toolOutput: { task_id: input.task_id, kind: "service", description, status: read.status, exitCode: read.exitCode, logs: read.logs },
        toolCallId,
    });
    return serviceReadText(input.task_id, service, read);
}

/** `kill_task` for a service: stop it and drop it from the running-services list. */
async function stopService(eventHandler: CopilotEventHandler, services: RunningServicesManager, taskId: string, toolCallId: string): Promise<string> {
    const service = services.get(taskId);
    const description = service ? serviceDescription(service) : undefined;
    eventHandler({ type: "tool_call", toolName: KILL_TASK_TOOL_NAME, toolInput: { task_id: taskId, kind: "service", description }, toolCallId });
    const exitCode = service?.exitCode;
    const status = await stopServiceTask(services, taskId);
    eventHandler({ type: "tool_result", toolName: KILL_TASK_TOOL_NAME, toolOutput: { task_id: taskId, kind: "service", description, status }, toolCallId, failed: status === "not_found" });
    switch (status) {
        case "not_found": return serviceNotFoundText(taskId);
        case "already_exited": return `Service ${taskId} had already exited with code ${exitCode}.`;
        default: return `Service ${taskId} ("${description}") stopped.`;
    }
}
