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
 * When a chat's background task finishes while the chat is idle, the chat gets a turn of its own —
 * Claude Code's behaviour:
 *
 * - a turn is running: nothing to do here; the completion rides that turn's next tool result
 *   (`registry.ts drainBackgroundTaskNotifications`), and `runEnded` catches one it missed;
 * - the chat is idle: after a 250 ms window (completions inside it merge) the host is asked to start
 *   a turn with the completion lines (`WakeHost.requestWake`);
 * - the user stopped the last turn, or the host cannot start one now: the lines wait, and the next run
 *   of the chat takes them (`takePendingForRun`), so a notice never restarts work the user cancelled.
 *
 * A completion is marked delivered only when a run takes it, so a wake the webview never acted on is
 * not lost. Pure apart from timers: the host (`./wake-host.ts`) supplies the chat state and the delivery.
 */

import { markCompletionsNotified, onBackgroundTaskFinished, pendingCompletionNotes } from "./registry";

export const WAKE_COALESCE_MS = 250;
/** How long a requested wake counts as on its way; after that a new completion may ask again. */
export const WAKE_REQUEST_TIMEOUT_MS = 15_000;

export interface WakeHost {
    /** True while the chat is running a turn, or cannot take one (a checkpoint restore). */
    isChatBusy(runKey: string): boolean;
    /** Start a turn carrying these completion lines. False when nothing can start it now. */
    requestWake(runKey: string, notes: string[], taskIds: string[]): boolean;
}

export type RunOrigin = "user" | "task_notification";

interface ChatWakeState {
    timer?: ReturnType<typeof setTimeout>;
    /** The user stopped the chat's last turn: hold notices for the user's next message. */
    interrupted: boolean;
    /** When a wake was last requested, until the chat's next run starts. */
    requestedAt?: number;
}

export class BackgroundWake {
    private readonly chats = new Map<string, ChatWakeState>();
    private unsubscribe?: () => void;

    constructor(private readonly host: WakeHost, private readonly coalesceMs = WAKE_COALESCE_MS, private readonly now: () => number = Date.now) {}

    /** Listens for background tasks finishing on their own. */
    start(): void {
        this.unsubscribe ??= onBackgroundTaskFinished(task => this.taskFinished(task.runKey));
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const state of this.chats.values()) {
            if (state.timer) { clearTimeout(state.timer); }
        }
        this.chats.clear();
    }

    /** Drops a deleted chat's state. */
    forget(runKey: string): void {
        const state = this.chats.get(runKey);
        if (state?.timer) { clearTimeout(state.timer); }
        this.chats.delete(runKey);
    }

    taskFinished(runKey: string): void {
        this.schedule(runKey);
    }

    runStarted(runKey: string, origin: RunOrigin): void {
        const state = this.state(runKey);
        state.requestedAt = undefined;
        if (origin === "user") { state.interrupted = false; }
    }

    runEnded(runKey: string, aborted: boolean): void {
        const state = this.state(runKey);
        state.interrupted = aborted;
        if (!aborted) { this.schedule(runKey); }
    }

    /**
     * For a run of the chat that is starting now: the completion lines it has not been given yet, marked
     * delivered. `carried` are the tasks the run's own prompt already reports (a wake turn's notice).
     * `taskIds` is every task marked, carried ones included, for `returnUndelivered`.
     */
    takePendingForRun(runKey: string, carried: readonly string[] = []): { notes: string[]; taskIds: string[] } {
        markCompletionsNotified(carried);
        const pending = pendingCompletionNotes(runKey);
        markCompletionsNotified(pending.map(p => p.taskId));
        return { notes: pending.map(p => p.note), taskIds: [...carried, ...pending.map(p => p.taskId)] };
    }

    /** The run that took these completions never started: they are pending again, for the chat's next run. */
    returnUndelivered(taskIds: readonly string[]): void {
        markCompletionsNotified(taskIds, false);
    }

    private state(runKey: string): ChatWakeState {
        let state = this.chats.get(runKey);
        if (!state) {
            state = { interrupted: false };
            this.chats.set(runKey, state);
        }
        return state;
    }

    private schedule(runKey: string): void {
        const state = this.state(runKey);
        if (state.timer) { return; }
        state.timer = setTimeout(() => this.flush(runKey), this.coalesceMs);
    }

    private flush(runKey: string): void {
        const state = this.state(runKey);
        state.timer = undefined;
        if (state.interrupted || this.host.isChatBusy(runKey)) { return; }
        // A wake is on its way: the run it starts takes these lines too.
        if (state.requestedAt !== undefined && this.now() - state.requestedAt < WAKE_REQUEST_TIMEOUT_MS) { return; }
        const pending = pendingCompletionNotes(runKey);
        if (pending.length === 0) { return; }
        if (this.host.requestWake(runKey, pending.map(p => p.note), pending.map(p => p.taskId))) {
            state.requestedAt = this.now();
        }
    }
}
