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
 * context. This keeps its own tool names except for the shell tools.
 *
 * The last entry is always the action under review — the gate appends the call
 * being judged before rendering. Results are never appended here; only
 * user messages and tool inputs enter, which is the isolation boundary.
 *
 * Every entry is rendered whole, so an earlier command's redirect or copy
 * destination stays visible. The transcript holds the active context
 * (transcript-source.ts); a transcript the provider cannot fit is not judged
 * (classifier.ts).
 */

import type { GitStatusMeta } from "./git-status-meta";
import { RESOLVED_PATHS_NOTE, type ResolvedPathFact } from "./resolved-paths-meta";

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
    /**
     * The summary a compaction restart continued from: model-written context
     * for the conversation before it, never the user's own words (intent
     * quotes are verified against the user's messages only).
     */
    | { kind: "summary"; text: string }
    | { kind: "tool"; tool: string; input: Record<string, unknown> }
    | { kind: "denied"; tool: string; subject: string; rule: string }
    /**
     * Harness ground truth, the Claude Code-compatible
     * `{"meta":{"gitStatus":…}}` line, directly above a shell command that can
     * destroy uncommitted work (auto-mode/git-status-meta.ts): the classifier
     * reads the tree's real state, not the model's account of it.
     */
    | { kind: "meta"; gitStatus: GitStatusMeta }
    /**
     * Harness ground truth, directly above a command that names a path inside
     * the working directory which a symlink takes outside it
     * (auto-mode/resolved-paths-meta.ts). Not a Claude Code line.
     */
    | { kind: "resolved-paths"; resolvedPaths: ResolvedPathFact[] };

/** The entry kinds that describe the action under review; they stay with it in the uncached tail. */
const ACTION_FACTS: ReadonlySet<TranscriptEntry["kind"]> = new Set(["meta", "resolved-paths"]);

/** Clip a diagnostic field (the classifier's own reply in the decision log); transcript entries are never clipped. */
export function clip(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}… [truncated, ${value.length} chars]`;
}

/**
 * Tool lines already rendered, by their input object. A stored call's input
 * is the same object on every gated command (`chatStateStorage` keeps the
 * thread's generations in memory and updates them in place), so its line,
 * file contents included, is serialized once rather than per command. Tool
 * inputs are never mutated; a fresh object (a reloaded thread, a wrapped
 * non-object input) renders again.
 */
const renderedToolLines = new WeakMap<object, { tool: string; line: string }>();

/**
 * Render one entry as its compact JSON line. The shell tools render as
 * `{"Bash":"<command>"}` / `{"PowerShell":"<command>"}` (the command string,
 * as Claude Code does); every other tool renders as `{"<Tool>":{…input…}}`,
 * file contents included.
 */
function renderEntry(entry: TranscriptEntry): string {
    if (entry.kind === "user") { return JSON.stringify({ user: entry.text }); }
    if (entry.kind === "summary") { return JSON.stringify({ summary: entry.text }); }
    if (entry.kind === "meta") { return JSON.stringify({ meta: { gitStatus: entry.gitStatus } }); }
    if (entry.kind === "resolved-paths") { return JSON.stringify({ meta: { resolvedPaths: entry.resolvedPaths, note: RESOLVED_PATHS_NOTE } }); }
    if (entry.kind === "denied") {
        return JSON.stringify({
            denied_by_permission_rule: { tool: transcriptToolName(entry.tool), attempted: entry.subject, rule: entry.rule },
        });
    }
    const cached = renderedToolLines.get(entry.input);
    if (cached?.tool === entry.tool) { return cached.line; }
    const name = transcriptToolName(entry.tool);
    const command = entry.input.command;
    const line = entry.tool in SHELL_TOOL_LABELS && typeof command === "string"
        ? JSON.stringify({ [name]: command })
        : JSON.stringify({ [name]: entry.input });
    renderedToolLines.set(entry.input, { tool: entry.tool, line });
    return line;
}

/** Refuse larger actions rather than asking the classifier to judge a clipped command. */
export const MAX_ACTION_CHARS = 100_000;

/** The rendered length of the action under review, the last entry. */
export function actionLength(entries: readonly TranscriptEntry[]): number {
    const action = entries[entries.length - 1];
    return action ? renderEntry(action).length : 0;
}

/**
 * Local reads and searches, left out of the earlier history as Claude Code
 * leaves them out: they change nothing, and a later command that uses what
 * they found names its own paths. The command under review is a shell call,
 * never one of these.
 */
const HISTORICAL_READ_TOOLS: ReadonlySet<string> = new Set([
    "file_read",
    "getCompilationErrors",
    "tool_search",
    "library_search",
    "library_docs",
    "docs_grep",
    "docs_read",
    "docs_list",
]);

export function isHistoricalRead(entry: TranscriptEntry): boolean {
    return entry.kind === "tool" && HISTORICAL_READ_TOOLS.has(entry.tool);
}

/**
 * The transcript as stable per-entry blocks: `history` is `<transcript>` and
 * then one block per earlier entry, `tail` is the action under review with the
 * harness lines directly above it (gitStatus, resolvedPaths) and the closing
 * tag. An earlier entry renders to the same block on every call, so a request
 * can cache the history and the next one read it (classifier-cache.ts); the
 * action's facts stay in the tail, so the action is never separated from them.
 */
export function transcriptBlocks(entries: readonly TranscriptEntry[]): { history: string[]; tail: string } {
    let historyEnd = Math.max(0, entries.length - 1);
    while (historyEnd > 0 && ACTION_FACTS.has(entries[historyEnd - 1].kind)) { historyEnd--; }
    return {
        history: ["<transcript>", ...entries.slice(0, historyEnd).map((entry) => `\n${renderEntry(entry)}`)],
        tail: `\n${entries.slice(historyEnd).map(renderEntry).join("\n")}\n</transcript>`,
    };
}

/** Render the ordered entries whole into a `<transcript>…</transcript>` block. */
export function renderTranscript(entries: readonly TranscriptEntry[]): string {
    const { history, tail } = transcriptBlocks(entries);
    return history.join("") + tail;
}
