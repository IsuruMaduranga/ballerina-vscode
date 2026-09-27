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
 * The tool calls of one agent run, in stream order, for the classifier's
 * transcript. The AI SDK hands each call to its tool's `onInputAvailable` as
 * soon as the call has streamed, one call at a time and before any tool runs,
 * so when a shell command is judged every earlier call of the same step is
 * already here, although the step is stored only once all of its calls
 * finish.
 *
 * Pure apart from the wrapped tool's own hook.
 */

import type { Tool } from "ai";
import { toolInputRecord, type TranscriptToolCall } from "./transcript-source";

/** Bounds the log over a very long run; only its unstored tail is ever read. */
const MAX_CALLS = 200;

export class RunToolCallLog {
    private readonly calls: TranscriptToolCall[] = [];

    record(call: TranscriptToolCall): void {
        this.calls.push(call);
        if (this.calls.length > MAX_CALLS) { this.calls.splice(0, this.calls.length - MAX_CALLS); }
    }

    list(): readonly TranscriptToolCall[] {
        return this.calls;
    }
}

/**
 * Records each call of `toolDef` in `log` from `onInputAvailable`, which the
 * SDK awaits per call in stream order, then runs the tool's own hook, if any.
 * Inputs only, as the rest of the transcript; every other property is kept.
 */
export function withToolCallLog<T extends Tool<any, any>>(toolDef: T, toolName: string, log: RunToolCallLog): T {
    const original = toolDef.onInputAvailable;
    return {
        ...toolDef,
        onInputAvailable: async (options: any) => {
            const toolCallId = typeof options?.toolCallId === "string" ? options.toolCallId : undefined;
            log.record({ toolCallId, tool: toolName, input: toolInputRecord(options?.input) });
            if (typeof original === "function") { await (original as any)(options); }
        },
    } as T;
}
