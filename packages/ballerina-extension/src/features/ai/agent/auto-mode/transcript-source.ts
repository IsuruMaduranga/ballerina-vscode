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
 * Where the classifier's transcript comes from: the thread's stored
 * generations, from the latest compaction restart on. That is the agent's own
 * active context (`compaction-restart.ts generationsSinceLastRestart`, the
 * same cut `chatStateStorage.getChatHistoryForLLM` makes): the summary the
 * restart continued from, then each generation's `userPrompt` (the text the
 * user typed, the RPC `usecase`, never the assembled user message that
 * carries the whole codebase dump) and the tool calls in its model messages,
 * inputs only. Earlier local reads and searches are left out
 * (`isHistoricalRead`). Tool results never enter: that is the isolation
 * boundary that keeps text the agent read from reaching the classifier as
 * context. The current generation's steps are persisted as they finish, so a
 * rebuild at classification time sees the run so far; the calls of the step
 * still running come from the run's own log (`unstoredToolCalls`).
 *
 * Pure: it reads only what it is handed.
 */

import { generationsSinceLastRestart, RESTART_SUMMARY_CLOSE, RESTART_SUMMARY_OPEN } from "../compaction-restart";
import { isHistoricalRead, type TranscriptEntry } from "./transcript";

/** The part of a stored generation the transcript reads. */
export interface TranscriptGeneration {
    userPrompt?: string;
    modelMessages?: unknown[];
    /** Set on the generation a compaction restart continued from its summary. */
    restartedFromSummary?: boolean;
}

/** A tool call as the transcript records it: its inputs only. */
export interface TranscriptToolCall {
    toolCallId?: string;
    tool: string;
    input: Record<string, unknown>;
}

/** A call's input as a record; a non-object input is wrapped so it still renders. */
export function toolInputRecord(input: unknown): Record<string, unknown> {
    return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { input };
}

function toolCallsOf(message: unknown): TranscriptToolCall[] {
    if (!message || typeof message !== "object") { return []; }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) { return []; }
    const calls: TranscriptToolCall[] = [];
    for (const part of content) {
        if (!part || typeof part !== "object") { continue; }
        const { type, toolName, toolCallId, input } = part as { type?: unknown; toolName?: unknown; toolCallId?: unknown; input?: unknown };
        if (type !== "tool-call" || typeof toolName !== "string") { continue; }
        calls.push({ toolCallId: typeof toolCallId === "string" ? toolCallId : undefined, tool: toolName, input: toolInputRecord(input) });
    }
    return calls;
}

/**
 * The summary a restarted generation continued from: the `<summary>` block of
 * the user message the restart sent (`compaction-restart.ts
 * buildCompactionContinuation`), read from that message's last text part
 * that holds one, so a `<summary>` tag in the project source before it is
 * never taken for it.
 */
export function restartSummary(generation: TranscriptGeneration): string | undefined {
    for (const message of generation.modelMessages ?? []) {
        if (!message || typeof message !== "object") { continue; }
        const { role, content } = message as { role?: unknown; content?: unknown };
        if (role !== "user" || !Array.isArray(content)) { continue; }
        for (let i = content.length - 1; i >= 0; i--) {
            const text = (content[i] as { type?: unknown; text?: unknown } | undefined)?.text;
            if (typeof text !== "string") { continue; }
            const open = text.indexOf(RESTART_SUMMARY_OPEN);
            const close = text.lastIndexOf(RESTART_SUMMARY_CLOSE);
            if (open >= 0 && close >= open + RESTART_SUMMARY_OPEN.length - 1) {
                const summary = text.slice(open + RESTART_SUMMARY_OPEN.length, close).trim();
                return summary || undefined;
            }
        }
        return undefined;
    }
    return undefined;
}

/**
 * The classifier's history of a thread: the transcript entries of its active
 * context (from the latest compaction restart on, oldest first), every user
 * message of the whole thread (for intent-quote verification, decision 2),
 * and the ids of the tool calls the active context holds.
 */
export function transcriptFromGenerations(generations: readonly TranscriptGeneration[]): { entries: TranscriptEntry[]; userMessages: string[]; toolCallIds: Set<string> } {
    const entries: TranscriptEntry[] = [];
    const userMessages: string[] = [];
    const toolCallIds = new Set<string>();
    for (const generation of generations) {
        const text = typeof generation.userPrompt === "string" ? generation.userPrompt.trim() : "";
        if (text) { userMessages.push(text); }
    }
    for (const generation of generationsSinceLastRestart(generations)) {
        const text = typeof generation.userPrompt === "string" ? generation.userPrompt.trim() : "";
        if (text) { entries.push({ kind: "user", text }); }
        // The restart message holds the request first and the summary after it, as the agent reads it.
        const summary = generation.restartedFromSummary ? restartSummary(generation) : undefined;
        if (summary) { entries.push({ kind: "summary", text: summary }); }
        for (const message of generation.modelMessages ?? []) {
            for (const call of toolCallsOf(message)) {
                if (call.toolCallId) { toolCallIds.add(call.toolCallId); }
                const entry: TranscriptEntry = { kind: "tool", tool: call.tool, input: call.input };
                if (!isHistoricalRead(entry)) { entries.push(entry); }
            }
        }
    }
    return { entries, userMessages, toolCallIds };
}

/**
 * The run's tool calls that are not stored yet and came before the call under
 * review, oldest first. A step's messages are stored only when the whole step
 * finishes, so these are the earlier calls of the step the command belongs
 * to: the log is read from after the last call the store holds. That also
 * leaves out the calls a compaction restart in this run replaced with its
 * summary, once a step after the restart is stored. The log is cut at the
 * call under review: a later call of the same step can stream in while this
 * one is judged, and it is left out, so the verdict does not depend on
 * timing. Local reads are left out as in the stored history.
 */
export function unstoredToolCalls(
    runCalls: readonly TranscriptToolCall[],
    storedIds: ReadonlySet<string>,
    currentToolCallId: string | undefined,
): TranscriptEntry[] {
    const at = currentToolCallId === undefined ? -1 : runCalls.findIndex(call => call.toolCallId === currentToolCallId);
    const earlier = at >= 0 ? runCalls.slice(0, at) : runCalls;
    let lastStored = -1;
    earlier.forEach((call, i) => {
        if (call.toolCallId && storedIds.has(call.toolCallId)) { lastStored = i; }
    });
    return earlier
        .slice(lastStored + 1)
        .map((call): TranscriptEntry => ({ kind: "tool", tool: call.tool, input: call.input }))
        .filter(entry => !isHistoricalRead(entry));
}
