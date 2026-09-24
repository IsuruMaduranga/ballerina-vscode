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
 * What the composer's running chip lists: every service (project-wide) and every chat's background shell
 * command still running. Changing chats stops the old chat's commands, so in practice they are the
 * active chat's.
 */

import type { RunningServiceInfo } from "@wso2/ballerina-core";
import type { RunningServicesManager } from "../tools/running-service-manager";
import { isServiceTaskId, stopServiceTask } from "../tools/service-task";
import { getBackgroundTask, listBackgroundTasks, stopShellTask } from "./registry";
import type { BackgroundShell } from "./types";

export function runningProcessList(services: RunningServicesManager): RunningServiceInfo[] {
    const commands = listBackgroundTasks()
        .filter((t): t is BackgroundShell => t.kind === "shell" && !t.completed)
        .map((t): RunningServiceInfo => ({
            taskId: t.id,
            kind: "shell",
            description: t.description,
            packagePath: t.cwd,
            startedAt: t.startTime.getTime(),
            exited: false,
            exitCode: 0,
        }));
    return [...services.getAll(), ...commands];
}

/** The chip's stop button: a service, or a chat's command (its agent is told on the chat's next turn). */
export async function stopRunningProcess(services: RunningServicesManager, taskId: string): Promise<boolean> {
    if (isServiceTaskId(taskId)) {
        return (await stopServiceTask(services, taskId)) !== "not_found";
    }
    const task = getBackgroundTask(taskId);
    if (task?.kind !== "shell" || task.completed) {
        return false;
    }
    stopShellTask(task, "by the user");
    return true;
}
