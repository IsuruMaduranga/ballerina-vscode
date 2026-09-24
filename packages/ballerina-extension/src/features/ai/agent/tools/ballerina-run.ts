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
 * Starting a service with `bal run`: `startPackageService` for the Try It card's "run the required services"
 * (`runService` RPC), and `startShellService` for the shell tool's background `bal run`, which the agent now
 * uses to start a service (the `runBallerinaPackage` tool is gone; its webview renderers stay for saved
 * chats). Both land in the project-wide `RunningServicesManager`, so the running chip lists them and they
 * outlive the turn.
 */

import * as child_process from 'child_process';
import { extension } from '../../../../BalExtensionContext';
import { RunningServicesManager, spawnProcess, spawnLaunchedProcess, killProcessGroup } from './running-service-manager';
import { newServiceTaskId } from './service-task';
import { resolvePackageBasePath } from './path-utils';
import { getRunArgs } from '../../../project/cmds/cmd-runner';
import type { ProcessLaunch } from '../shell/runner';
import type { ServiceStartResult } from '../shell/shell-call';

const SERVICE_READY_TIMEOUT_MS = 60000;
const READY_POLL_INTERVAL_MS = 200;

/**
 * Starts the shell tool's background `bal run` as a service: `launch` is the shell running the model's
 * command, `packagePath` the directory `shell/bal-run.ts` read from it.
 */
export async function startShellService(
    start: { launch: ProcessLaunch; cwd: string; env?: NodeJS.ProcessEnv; packagePath: string },
    runningServices: RunningServicesManager,
): Promise<ServiceStartResult> {
    const logs: string[] = [];
    const { process: proc } = spawnLaunchedProcess(start.launch, start.cwd, logs, start.env);
    return awaitServiceStart(proc, logs, start.packagePath, runningServices);
}

/**
 * Starts the package at `packagePath` (relative to `tempProjectPath`) with the extension's own `bal` and the
 * run flags from the user's settings.
 */
export async function startPackageService(
    packagePath: string | undefined,
    tempProjectPath: string,
    runningServices: RunningServicesManager
): Promise<ServiceStartResult> {
    // The helper rejects directory traversal and absolute paths, and requires packagePath when running
    // inside a workspace project, so `bal run` never executes outside tempProjectPath.
    let cwd: string;
    try {
        cwd = resolvePackageBasePath(tempProjectPath, packagePath);
    } catch (e: any) {
        console.error("[BallerinaRun] Invalid packagePath:", e?.message);
        return { kind: "failed", exitCode: -1, output: e?.message ?? "Invalid packagePath", timedOut: false };
    }
    const logs: string[] = [];
    const { process: proc } = spawnProcess(extension.ballerinaExtInstance.getBallerinaCmd(), getRunArgs(), cwd, logs);
    return awaitServiceStart(proc, logs, cwd, runningServices);
}

/**
 * Registers a started `bal run` and resolves once it printed `Running executable`, or failed to; a failed
 * start is stopped and dropped.
 */
async function awaitServiceStart(
    proc: child_process.ChildProcess,
    logs: string[],
    packagePath: string,
    runningServices: RunningServicesManager,
): Promise<ServiceStartResult> {
    const service = {
        taskId: newServiceTaskId(),
        process: proc,
        logs,
        logCursor: 0,
        packagePath,
        startedAt: Date.now(),
        exited: false,
        exitCode: -1,
    };
    runningServices.register(service);
    const ready = await waitForServiceReady(service, SERVICE_READY_TIMEOUT_MS);
    if (!ready.ready) {
        await killProcessGroup(proc, 'SIGTERM');
        runningServices.remove(service.taskId);
        return { kind: "failed", exitCode: service.exitCode, output: ready.logs, timedOut: ready.timedOut };
    }
    // The startup output is returned here, so the next read starts after it.
    service.logCursor = service.logs.length;
    return { kind: "started", taskId: service.taskId, output: ready.logs };
}

function waitForServiceReady(
    service: { exited: boolean; logs: string[] },
    timeout: number
): Promise<{ ready: boolean; logs: string; timedOut: boolean }> {
    const startTime = Date.now();
    return new Promise((resolve) => {
        const check = () => {
            const logs = service.logs.join('');
            if (logs.includes('Running executable')) {
                resolve({ ready: true, logs, timedOut: false });
            } else if (service.exited) {
                resolve({ ready: false, logs, timedOut: false });
            } else if (Date.now() - startTime >= timeout) {
                resolve({ ready: false, logs, timedOut: true });
            } else {
                setTimeout(check, READY_POLL_INTERVAL_MS);
            }
        };
        check();
    });
}
