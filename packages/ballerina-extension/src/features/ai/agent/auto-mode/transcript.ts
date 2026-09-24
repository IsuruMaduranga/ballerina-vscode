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
 * The `<transcript>` block the classifier reads (pure).
 *
 * Claude Code hands its classifier a compact JSONL transcript of the session —
 * user messages and tool-call *inputs only*, with tool RESULTS stripped so
 * hostile content the agent read cannot reach the classifier as if it were
 * context. Ported from pincer-agent `extensions/auto-mode/transcript.ts`
 * (`3b290c8`); BI keeps its own tool names except for the shell tools.
 *
 * The last entry is always the action under review — the gate appends the call
 * being judged before rendering. Results are never appended here; only
 * user messages and tool inputs enter, which is the isolation boundary.
 */

import type { GitStatusMeta } from "./git-status-meta";

/**
 * How a tool is named in the transcript. The shell tools take Claude Code's
 * names (`Bash`, `PowerShell`), which the ruleset's examples use; every other
 * tool keeps its own name.
 */
const SHELL_TOOL_LABELS: Record<string, string> = { shell: "Bash", powershell: "PowerShell" };

export function transcriptToolName(tool: string): string {
    return SHELL_TOOL_LABELS[tool] ?? tool;
}

/**
 * One line of the transcript: a user message, a tool call's input, or a call the
 * permission rules refused. A `denied` line is harness-generated, never tool
 * output, so it does not weaken the results-stripped isolation boundary — and
 * without it the classifier could not see that the rules had already refused
 * this class of action, so it cleared an equivalent-effect retry on the user's
 * original intent.
 */
export type TranscriptEntry =
    | { kind: "user"; text: string }
    | { kind: "tool"; tool: string; input: Record<string, unknown> }
    | { kind: "denied"; tool: string; subject: string; rule: string }
    /**
     * Harness ground truth, the Claude Code-compatible
     * `{"meta":{"gitStatus":…}}` line, directly above a shell command that can
     * destroy uncommitted work (auto-mode/git-status-meta.ts): the classifier
     * reads the tree's real state, not the model's account of it.
     */
    | { kind: "meta"; gitStatus: GitStatusMeta };

/** Truncate one field so a single huge argument cannot dominate the transcript. */
export function clip(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}… [truncated, ${value.length} chars]`;
}

/** Clip every string leaf of a tool input, leaving structure intact. */
function clipInput(input: Record<string, unknown>, max: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        out[key] = typeof value === "string" ? clip(value, max) : value;
    }
    return out;
}

/**
 * Render one entry as its compact JSON line. The shell tools render as
 * `{"Bash":"<command>"}` / `{"PowerShell":"<command>"}` (the command string,
 * as Claude Code does); every other tool renders as `{"<Tool>":{…input…}}`
 * with string fields clipped.
 */
function renderEntry(entry: TranscriptEntry, maxField: number): string {
    if (entry.kind === "user") { return JSON.stringify({ user: clip(entry.text, maxField) }); }
    if (entry.kind === "meta") { return JSON.stringify({ meta: { gitStatus: entry.gitStatus } }); }
    if (entry.kind === "denied") {
        return JSON.stringify({
            denied_by_permission_rule: { tool: transcriptToolName(entry.tool), attempted: clip(entry.subject, maxField), rule: entry.rule },
        });
    }
    const name = transcriptToolName(entry.tool);
    const command = entry.input.command;
    if (entry.tool in SHELL_TOOL_LABELS && typeof command === "string") {
        return JSON.stringify({ [name]: clip(command, maxField) });
    }
    return JSON.stringify({ [name]: clipInput(entry.input, maxField) });
}

export interface RenderOptions {
    /** Max chars per string field. */
    maxField?: number;
    /** Max chars for the whole rendered transcript; oldest entries drop first. */
    maxChars?: number;
}

/**
 * Render the ordered entries into a `<transcript>…</transcript>` block. When the
 * rendered lines exceed `maxChars`, the oldest are dropped and a marker records
 * it — the action under review (the last entry) is always kept. The full user
 * messages are carried separately for intent verification, so dropping old lines
 * here never weakens that check.
 */
export function renderTranscript(entries: TranscriptEntry[], options: RenderOptions = {}): string {
    const maxField = options.maxField ?? 2000;
    const maxChars = options.maxChars ?? 60_000;
    const lines = entries.map((entry) => renderEntry(entry, maxField));

    // Keep the newest lines that fit the budget, walking from the end in one pass
    // (the last line — the action under review — is always kept). +1 per line for
    // the joining "\n".
    let firstKept = lines.length;
    let running = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        running += lines[i].length + 1;
        if (i < lines.length - 1 && running > maxChars) { break; }
        firstKept = i;
    }
    const kept = lines.slice(firstKept);
    const dropped = firstKept;
    const body = dropped > 0 ? [`{"note":"${dropped} earlier transcript entr${dropped === 1 ? "y" : "ies"} omitted for length"}`, ...kept] : kept;
    return `<transcript>\n${body.join("\n")}\n</transcript>`;
}
