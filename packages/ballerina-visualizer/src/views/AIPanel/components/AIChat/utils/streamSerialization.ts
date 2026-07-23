/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { StreamEntry, StreamItem } from "../../AgentStreamView/types";

/**
 * Agent-stream (de)serialization for the persisted assistant transcript.
 *
 * An assistant turn's `uiResponse`/`content` embeds its timeline as a single
 * `<agentstream>{ entries: StreamEntry[] }</agentstream>` blob. This is the
 * on-disk shape the store round-trips (`thread.json`), so both the full AI
 * panel and the floating-orb mini chat read/write through these helpers to
 * stay byte-compatible — the mini persisting a turn must produce content the
 * panel can parse back, and vice versa.
 */

export function serializeStream(entries: StreamEntry[], existingContent: string): string {
    // Escape `</` as `<\/` (a valid JSON string escape for `/`) so a `</agentstream>`
    // substring inside the payload — e.g. assistant text or tool output that quotes
    // the tag literally — can't terminate the blob early and make parseStream truncate.
    const json = JSON.stringify({ entries }).replace(/<\//g, "<\\/");
    const blob = `<agentstream>${json}</agentstream>`;
    if (existingContent.includes("<agentstream>")) {
        return existingContent.replace(/<agentstream>[\s\S]*?<\/agentstream>/, blob);
    }
    return existingContent + blob;
}

export function parseStream(content: string): StreamEntry[] {
    const match = content.match(/<agentstream>([\s\S]*?)<\/agentstream>/);
    if (!match) return [];
    try {
        // Guard the shape: only an actual array is safe to hand to the entry
        // reducers (a malformed `{ "entries": {} }` would crash `appendToLastEntry`).
        const parsed = JSON.parse(match[1]);
        return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
        return [];
    }
}

export function appendToLastEntry(entries: StreamEntry[], item: StreamItem): StreamEntry[] {
    if (entries.length === 0) return [{ description: "", items: [item] }];
    const last = entries[entries.length - 1];
    return [...entries.slice(0, -1), { ...last, items: [...last.items, item] }];
}
