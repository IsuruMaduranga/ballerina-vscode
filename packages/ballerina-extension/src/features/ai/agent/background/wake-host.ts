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
 * The extension side of `./wake.ts`: whether a chat is busy, and how a wake reaches it. The AI panel's
 * webview starts the turn (`backgroundTaskWake`), because the composer holds what a run needs — the
 * plan/edit mode and the Auto / Ask shell mode. Only the project's active chat is woken: changing chats
 * stops the old chat's background commands.
 *
 * The AI panel's RPC handler sets the sender (`setBackgroundWakeSender`), so this module does not load
 * the RPC layer and the webview host.
 */

import { BackgroundTaskWake, frameTaskNotification } from "@wso2/ballerina-core";
import { chatStateStorage } from "../../../../views/ai-panel/chatStateStorage";
import { isRestoreInProgress } from "../../../../views/ai-panel/checkpoint/restore-state";
import { runEventStore } from "../../utils/run-event-store";
import { BackgroundWake } from "./wake";

/** Sends a wake to the AI panel; false when no panel is open to take it. */
let sendWake: ((wake: BackgroundTaskWake) => boolean) | undefined;

export function setBackgroundWakeSender(sender: (wake: BackgroundTaskWake) => boolean): void {
    sendWake = sender;
}

/** `subagents/types.ts buildRunKey` in reverse; a project path may itself contain `|`, a thread id never does. */
export function splitRunKey(runKey: string): { projectRootPath: string; threadId: string } {
    const at = runKey.lastIndexOf("|");
    return { projectRootPath: runKey.slice(0, at), threadId: runKey.slice(at + 1) };
}

export const backgroundWake = new BackgroundWake({
    isChatBusy(runKey) {
        const { projectRootPath, threadId } = splitRunKey(runKey);
        return !!chatStateStorage.getActiveExecution(projectRootPath, threadId)
            || runEventStore.getRunStatus(projectRootPath, threadId).isRunning
            || isRestoreInProgress(projectRootPath);
    },
    requestWake(runKey, notes, taskIds) {
        const { projectRootPath, threadId } = splitRunKey(runKey);
        if (!sendWake || chatStateStorage.getActiveThreadId(projectRootPath) !== threadId) {
            return false;
        }
        return sendWake({ projectRootPath, threadId, text: frameTaskNotification(notes, "opens-turn"), taskIds });
    },
});
