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
 * Where the classifier's transcript comes from: the thread's
 * stored generations. Each contributes its `userPrompt`, which is the text the
 * user typed (the RPC `usecase`), never the assembled user message that
 * carries the whole codebase dump, and then the tool calls in its model
 * messages, inputs only. Tool results never enter: that is the isolation
 * boundary that keeps text the agent read from reaching the classifier as
 * context. The current generation's steps are persisted as they finish, so a
 * rebuild at classification time sees the run so far; the calls of the step
 * still running come from the run's own log (`unstoredToolCalls`).
 *
 * Pure: it reads only what it is handed.
 */

import type { TranscriptEntry } from "./transcript";

/** The part of a stored generation the transcript reads. */
export interface TranscriptGeneration {
    userPrompt?: string;
    modelMessages?: unknown[];
}

/** Keeps a very long thread from growing the rebuild without bound; the renderer clips by size anyway. */
const MAX_ENTRIES = 2_000;

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
 * The transcript entries and the full list of user messages (for intent-quote
 * verification) of a thread's generations, oldest first, and the ids of the
 * tool calls they hold.
 */
export function transcriptFromGenerations(generations: readonly TranscriptGeneration[]): { entries: TranscriptEntry[]; userMessages: string[]; toolCallIds: Set<string> } {
    const entries: TranscriptEntry[] = [];
    const userMessages: string[] = [];
    const toolCallIds = new Set<string>();
    for (const generation of generations) {
        const text = typeof generation.userPrompt === "string" ? generation.userPrompt.trim() : "";
        if (text) {
            entries.push({ kind: "user", text });
            userMessages.push(text);
        }
        for (const message of generation.modelMessages ?? []) {
            for (const call of toolCallsOf(message)) {
                entries.push({ kind: "tool", tool: call.tool, input: call.input });
                if (call.toolCallId) { toolCallIds.add(call.toolCallId); }
            }
        }
    }
    return { entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries, userMessages, toolCallIds };
}

/**
 * The run's tool calls that are not stored yet and came before the call under
 * review, oldest first. A step's messages are stored only when the whole step
 * finishes, so these are the earlier calls of the step the command belongs
 * to. The log is cut at the call under review: a later call of the same step
 * can stream in while this one is judged, and it is left out, so the verdict
 * does not depend on timing. A call already stored (by id) is skipped so
 * nothing appears twice.
 */
export function unstoredToolCalls(
    runCalls: readonly TranscriptToolCall[],
    storedIds: ReadonlySet<string>,
    currentToolCallId: string | undefined,
): TranscriptEntry[] {
    const at = currentToolCallId === undefined ? -1 : runCalls.findIndex(call => call.toolCallId === currentToolCallId);
    const earlier = at >= 0 ? runCalls.slice(0, at) : runCalls;
    return earlier
        .filter(call => !(call.toolCallId && storedIds.has(call.toolCallId)))
        .map(call => ({ kind: "tool", tool: call.tool, input: call.input }));
}
