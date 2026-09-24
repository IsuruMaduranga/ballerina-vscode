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
 * A service started by `runBallerinaPackage`, read and stopped through `task_output` and `kill_task`.
 *
 * Services are not background tasks: they live in the extension-wide `RunningServicesManager`, outlive
 * the turn that started them (the user tries them, and stops them from the panel), and are never stopped
 * by run-end cleanup. They only share the task tools and the `task-` id namespace, so the model learns
 * one way to read and stop anything it started.
 */

import { randomUUID } from "crypto";
import * as path from "path";
import type { RunningService, RunningServicesManager } from "./running-service-manager";

export const SERVICE_TASK_PREFIX = "task-service-";
/** Output past this many characters is cut to its tail, as the shell tool does. */
export const SERVICE_OUTPUT_CAP = 30_000;
const POLL_INTERVAL_MS = 200;

export function newServiceTaskId(): string {
    return `${SERVICE_TASK_PREFIX}${randomUUID().split("-")[0]}`;
}

export function isServiceTaskId(id: string): boolean {
    return id.startsWith(SERVICE_TASK_PREFIX);
}

/** The label a task row shows for a service: `bal run (<package>)`. */
export function serviceDescription(service: RunningService): string {
    return `bal run (${path.basename(service.packagePath)})`;
}

export interface ServiceRead {
    status: "running" | "exited";
    exitCode?: number;
    /** The output printed since the previous read. */
    logs: string;
}

/** Everything printed since the last read; advances the read cursor. */
function takeNewLogs(service: RunningService): string {
    const logs = service.logs.slice(service.logCursor).join("");
    service.logCursor = service.logs.length;
    return logs;
}

function readResult(service: RunningService): ServiceRead {
    const logs = takeNewLogs(service);
    return service.exited ? { status: "exited", exitCode: service.exitCode, logs } : { status: "running", logs };
}

/**
 * Reads a service's new output. With `block`, waits until it prints something new or exits (at most
 * `timeoutMs`), then lets one more poll interval pass so a burst of lines arrives whole.
 */
export async function readServiceOutput(
    service: RunningService,
    options: { block: boolean; timeoutMs: number; signal?: AbortSignal; pollMs?: number },
): Promise<ServiceRead> {
    const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
    const hasNews = () => service.exited || service.logs.length > service.logCursor;
    if (!options.block || hasNews()) {
        return readResult(service);
    }
    const started = Date.now();
    while (!hasNews() && !options.signal?.aborted && Date.now() - started < options.timeoutMs) {
        await delay(pollMs);
    }
    if (hasNews() && !service.exited) {
        await delay(pollMs);
    }
    return readResult(service);
}

/** The text `task_output` returns for a service read. */
export function serviceReadText(taskId: string, service: RunningService, read: ServiceRead): string {
    const header = read.status === "exited"
        ? `Service ${taskId} ("${serviceDescription(service)}") has exited with code ${read.exitCode}.`
        : `Service ${taskId} ("${serviceDescription(service)}") is running.`;
    if (!read.logs) {
        return `${header} No new output since the last read.`;
    }
    const logs = read.logs.length <= SERVICE_OUTPUT_CAP
        ? read.logs
        : `… (earlier output truncated)\n${read.logs.slice(-SERVICE_OUTPUT_CAP)}`;
    return `${header} New output since the last read:\n\n${logs}`;
}

export function serviceNotFoundText(taskId: string): string {
    return `No service with id ${taskId}. It may have been stopped, or it exited more than 30 seconds ago. Start it again with runBallerinaPackage.`;
}

/** Stops a service and forgets it. An already exited service is forgotten without a kill. */
export async function stopServiceTask(
    services: RunningServicesManager,
    taskId: string,
): Promise<"stopped" | "already_exited" | "not_found"> {
    const service = services.get(taskId);
    if (!service) {
        return "not_found";
    }
    if (service.exited) {
        services.remove(taskId);
        return "already_exited";
    }
    await services.stopOne(taskId);
    return "stopped";
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
