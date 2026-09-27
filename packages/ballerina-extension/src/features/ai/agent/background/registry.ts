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
 * Background task tracking — the module state behind `run_in_background`, `task_output` and `kill_task`,
 * ported from the MI Copilot's `subagent_tool.ts` / `bash_tools.ts`. Holds subagents and shell commands
 * alike (`./types`).
 *
 * A task's `runKey` is its chat (project root + thread). A subagent still ends with the run that started
 * it (`cleanupRunningBackgroundTasks` at run end). A shell command outlives the turn: it stops when it
 * finishes, on `kill_task`, when the user stops it or changes chats (`stopChatShellTasks`), or when VS Code
 * closes (`stopAllBackgroundTasks`).
 *
 * Completion reaches the main agent three ways — a blocking `task_output`, the `<system-reminder>` that
 * `drainBackgroundTaskNotifications` appends to the chat's next tool result, or, when the chat is idle, a
 * turn of its own (`./wake.ts`, fed by `onBackgroundTaskFinished`). A completion `task_output` already
 * returned is not repeated.
 */

import type { Tool } from "ai";
import { tailCap } from "../shell/output";
import { shellSummary } from "./shell-summary";
import type { BackgroundShell, BackgroundSubagent, BackgroundTask } from "./types";

export const MAX_BACKGROUND_TASKS = 50;
export const BACKGROUND_TASK_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** The most output a completion notice carries when the output was not spooled to a file. */
export const NOTIFY_OUTPUT_CAP = 2_000;

const backgroundTasks = new Map<string, BackgroundTask>();
let cleanupTimer: NodeJS.Timeout | null = null;
const changeListeners = new Set<() => void>();
const finishListeners = new Set<(task: BackgroundTask) => void>();

/** Called whenever a task starts, ends or is dropped (the running-tasks chip). Returns the unsubscribe. */
export function onBackgroundTasksChanged(listener: () => void): () => void {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
}

/** Called when a task finishes on its own — not when something stopped it. Returns the unsubscribe. */
export function onBackgroundTaskFinished(listener: (task: BackgroundTask) => void): () => void {
    finishListeners.add(listener);
    return () => { finishListeners.delete(listener); };
}

export function notifyBackgroundTasksChanged(): void {
    for (const listener of changeListeners) {
        try { listener(); } catch (error) { console.error("[BackgroundTasks] change listener threw:", error); }
    }
}

/** The starter reports its task's own finish here, after it filled the result. */
export function backgroundTaskFinished(task: BackgroundTask): void {
    for (const listener of finishListeners) {
        try { listener(task); } catch (error) { console.error("[BackgroundTasks] finish listener threw:", error); }
    }
    notifyBackgroundTasksChanged();
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
    return backgroundTasks.get(id);
}

/** The background subagent with this id, or undefined (also when the id names a shell task). */
export function getBackgroundSubagent(id: string): BackgroundSubagent | undefined {
    const task = backgroundTasks.get(id);
    return task?.kind === "subagent" ? task : undefined;
}

export function listBackgroundTasks(runKey?: string): BackgroundTask[] {
    const all = [...backgroundTasks.values()];
    return runKey ? all.filter(t => t.runKey === runKey) : all;
}

export function registerBackgroundTask(entry: BackgroundTask): void {
    startCleanupTimer();
    backgroundTasks.set(entry.id, entry);
    notifyBackgroundTasksChanged();
}

export function removeBackgroundTask(id: string): boolean {
    const removed = backgroundTasks.delete(id);
    if (removed) { notifyBackgroundTasksChanged(); }
    return removed;
}

/** Drops completed entries older than the TTL. Exposed for tests via `now`. */
export function cleanupOldTasks(now: number = Date.now()): number {
    const threshold = now - BACKGROUND_TASK_TTL_MS;
    let removed = 0;
    for (const [id, t] of backgroundTasks) {
        const doneAt = t.completedAt?.getTime() ?? t.startTime.getTime();
        if (t.completed && doneAt < threshold) {
            backgroundTasks.delete(id);
            removed++;
        }
    }
    return removed;
}

function evictOldestCompleted(): boolean {
    let oldestId: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, t] of backgroundTasks) {
        if (!t.completed) { continue; }
        const doneAt = t.completedAt?.getTime() ?? t.startTime.getTime();
        if (doneAt < oldest) { oldest = doneAt; oldestId = id; }
    }
    if (!oldestId) { return false; }
    backgroundTasks.delete(oldestId);
    return true;
}

export type CapacityCheck = { kind: "ok" } | { kind: "full"; reason: string };

export function ensureBackgroundCapacity(): CapacityCheck {
    if (backgroundTasks.size < MAX_BACKGROUND_TASKS) { return { kind: "ok" }; }
    if (cleanupOldTasks() > 0 && backgroundTasks.size < MAX_BACKGROUND_TASKS) { return { kind: "ok" }; }
    if (evictOldestCompleted()) { return { kind: "ok" }; }
    return {
        kind: "full",
        reason: `Background task limit reached (${MAX_BACKGROUND_TASKS}). Wait for a task to complete with task_output or terminate one with kill_task before starting another.`,
    };
}

/** Why a task was ended from outside before it finished; the words follow "was stopped". */
export type StopReason =
    | "by request"
    | "because the main agent run ended"
    | "by the user"
    | "because the user changed chats"
    | "because VS Code closed";

/** The output a task gets when it is ended from outside (`kill_task`, run end, the user) before it finished. */
export function terminatedOutput(task: BackgroundTask, why: StopReason): string {
    return task.kind === "subagent"
        ? `Subagent ${task.id} was terminated ${why}.`
        : `Background command ${task.id} was stopped ${why}.`;
}

/**
 * Aborts and forgets every still-running subagent of `runKey` (or of every chat when omitted). Called at
 * run end: a subagent's report has nowhere to go once its turn is over. Shell commands are left running
 * (`stopChatShellTasks`, `stopAllBackgroundTasks` end them).
 */
export function cleanupRunningBackgroundTasks(runKey?: string): number {
    let cleaned = 0;
    for (const [id, t] of [...backgroundTasks.entries()]) {
        if (t.completed || t.kind !== "subagent") { continue; }
        if (runKey && t.runKey !== runKey) { continue; }
        t.aborted = true;
        t.completed = true;
        t.success = false;
        t.completedAt = new Date();
        if (!t.output) { t.output = terminatedOutput(t, "because the main agent run ended"); }
        // Report the abort now, inside the run that owns the row; the task's own settlement lands later and
        // would otherwise be delivered into whatever turn is active by then.
        t.runEnded = true;
        t.onRunEnd?.();
        t.abortController.abort();
        backgroundTasks.delete(id);
        cleaned++;
    }
    if (cleaned > 0) { notifyBackgroundTasksChanged(); }
    return cleaned;
}

/**
 * Ends a running shell task from outside. The entry stays, completed and unreported, so its chat's agent
 * is told on its next turn (drain) and a later `task_output` still finds it. The process's own finish,
 * which lands afterwards, is ignored (`completed` is already set).
 */
export function stopShellTask(task: BackgroundShell, why: StopReason): void {
    if (task.completed) { return; }
    task.aborted = true;
    task.completed = true;
    task.success = false;
    task.finishStatus = "killed";
    task.completedAt = new Date();
    task.output = terminatedOutput(task, why);
    task.abortController.abort();
    notifyBackgroundTasksChanged();
}

/** The chat's shell commands still running. */
export function runningChatShellTasks(runKey: string): BackgroundShell[] {
    return [...backgroundTasks.values()].filter((t): t is BackgroundShell => t.kind === "shell" && !t.completed && t.runKey === runKey);
}

/** Stops the chat's running shell commands (New Chat, a chat switch or delete). Returns how many. */
export function stopChatShellTasks(runKey: string, why: StopReason): number {
    const running = runningChatShellTasks(runKey);
    for (const task of running) { stopShellTask(task, why); }
    return running.length;
}

/** Stops every running task of every chat: VS Code is closing. */
export function stopAllBackgroundTasks(): number {
    let stopped = 0;
    for (const t of [...backgroundTasks.values()]) {
        if (t.completed) { continue; }
        if (t.kind === "shell") {
            stopShellTask(t, "because VS Code closed");
        } else {
            t.aborted = true;
            t.completed = true;
            t.success = false;
            t.completedAt = new Date();
            t.abortController.abort();
        }
        stopped++;
    }
    return stopped;
}

function escapeForTag(text: string): string {
    return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One completion line: the subagent's, or `shellSummary`'s, with the output file or a short tail. */
function completionNote(t: BackgroundTask): string {
    if (t.kind === "subagent") {
        const status = t.success ? "completed successfully" : (t.aborted ? "was aborted" : "failed");
        return `Background ${t.subagentType} subagent "${escapeForTag(t.description)}" (${t.id}) ${status}. Use task_output to retrieve the result.`;
    }
    const summary = shellSummary(escapeForTag(t.description), t.finishStatus ?? (t.aborted ? "killed" : t.success ? "completed" : "failed"), t.exitCode, t.finishDetail);
    if (t.logPath) {
        return `${summary} (${t.id}). Output file: ${t.logPath}. Use task_output to retrieve the output.`;
    }
    return `${summary} (${t.id}). Output tail:\n${escapeForTag(tailCap(t.output, NOTIFY_OUTPUT_CAP).trim())}`;
}

/** The chat's finished-but-unreported tasks with their completion lines, oldest first; marks nothing. */
export function pendingCompletionNotes(runKey: string): { taskId: string; note: string }[] {
    const pending: { taskId: string; note: string }[] = [];
    for (const t of backgroundTasks.values()) {
        if (t.runKey !== runKey || !t.completed || t.notified) { continue; }
        pending.push({ taskId: t.id, note: completionNote(t) });
    }
    return pending;
}

/** Marks these tasks' completions as delivered, so no later drain or wake repeats them; `false` undoes it. */
export function markCompletionsNotified(taskIds: readonly string[], notified = true): void {
    for (const id of taskIds) {
        const task = backgroundTasks.get(id);
        if (task) { task.notified = notified; }
    }
}

/**
 * Text to append to a tool result: one entry per finished-but-unreported task of this chat, wrapped in a
 * `<system-reminder>`. Marks them notified so each completion is reported once. Empty string when there
 * is nothing to report.
 */
export function drainBackgroundTaskNotifications(runKey: string): string {
    const pending = pendingCompletionNotes(runKey);
    if (pending.length === 0) { return ""; }
    markCompletionsNotified(pending.map(p => p.taskId));
    return `\n\n<system-reminder>\n${pending.map(p => p.note).join("\n")}\n</system-reminder>`;
}

/**
 * Appends pending completion notices to a tool's result. String results get the reminder appended; plain
 * object results carry it as `system_reminder`; anything else (arrays, undefined) is left alone. The
 * wrapped tool keeps every other property, so schemas and `toModelOutput` are untouched.
 */
export function withBackgroundNotifications<T extends Tool<any, any>>(toolDef: T, runKey: string): T {
    const original = toolDef.execute;
    if (typeof original !== "function") { return toolDef; }
    return {
        ...toolDef,
        execute: async (input: any, options: any) => {
            const result = await (original as any)(input, options);
            const reminder = drainBackgroundTaskNotifications(runKey);
            if (!reminder) { return result; }
            if (typeof result === "string") { return result + reminder; }
            if (result && typeof result === "object" && !Array.isArray(result)) {
                return { ...result, system_reminder: reminder.trim() };
            }
            return result;
        },
    } as T;
}

function startCleanupTimer(): void {
    if (cleanupTimer) { return; }
    cleanupTimer = setInterval(() => { cleanupOldTasks(); }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
}

/** Test hook: forget every entry and stop the sweep. */
export function resetBackgroundTasksForTests(): void {
    backgroundTasks.clear();
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}
