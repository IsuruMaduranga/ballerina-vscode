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
 * The background tasks the main agent can start and collect: subagents (`Subagent` with
 * `run_in_background`) and shell commands (`shell` / `powershell` with `run_in_background`). One registry
 * (`./registry`) holds both, so `task_output`, `kill_task`, run-end cleanup and the completion
 * `<system-reminder>` treat them alike. The `kind` discriminant is a string: boolean-literal unions do not
 * narrow under this package's `strictNullChecks: false`.
 */

import { randomUUID } from "crypto";
import type { FinishStatus } from "../shell/runner";
import type { SubagentType } from "../subagents/types";

interface BackgroundTaskBase {
    id: string;
    description: string;
    runKey: string;
    /** The tool call that started it; a completion `tool_result` reuses it. */
    toolCallId: string;
    startTime: Date;
    completedAt?: Date;
    /** The final result `task_output` returns; empty while running. */
    output: string;
    completed: boolean;
    success: boolean | null;
    aborted: boolean;
    /** Aborting it stops the work: the subagent's model loop, or the shell command's process tree. */
    abortController: AbortController;
    /** True once the completion has reached the main agent (drain reminder or task_output). */
    notified: boolean;
    /**
     * Set by run-end cleanup. The task's own completion/abort settles later, in a turn that may already
     * belong to another run, so the starter reports the abort synchronously through `onRunEnd` and
     * ignores the late settlement.
     */
    runEnded?: boolean;
    onRunEnd?: () => void;
}

export interface BackgroundSubagent extends BackgroundTaskBase {
    kind: "subagent";
    subagentType: SubagentType;
}

export interface BackgroundShell extends BackgroundTaskBase {
    kind: "shell";
    /** The tool that started it (`shell` or `powershell`). */
    toolName: string;
    /** The command as the model wrote it. */
    command: string;
    /** The full output, spooled; named in the completion notice. */
    logPath?: string;
    exitCode: number | null;
    /** How it ended (`runner.ts shellFinish`), set on completion. */
    finishStatus?: FinishStatus;
    /** The failure detail an exit code does not explain (a timeout, a signal). */
    finishDetail?: string;
    /** The output so far, for a `task_output` that finds it still running. */
    peek(): string;
}

export type BackgroundTask = BackgroundSubagent | BackgroundShell;
export type BackgroundTaskKind = BackgroundTask["kind"];

/** Task ids share one namespace, as in the MI Copilot: `task-subagent-xxxxxxxx`, `task-shell-xxxxxxxx`. */
export function generateTaskId(kind: BackgroundTaskKind): string {
    // Node's crypto rather than the `uuid` package: uuid@14 ships ESM only, which Jest cannot load.
    return `task-${kind}-${randomUUID().split("-")[0]}`;
}
