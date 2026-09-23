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
 * Output handling shared by every process the Copilot runs (pure): control-byte stripping and a rolling
 * tail cap.
 *
 * `stripAnsiAndControl` is MI's `utils/sanitize-text.ts` regex pair unchanged. `bal`, Maven and npm emit
 * ANSI colour codes, and raw 0x00–0x1F bytes in a tool-result string make the WSO2 LLM proxy reject the
 * request (`unexpected control character in string`). `\t`, `\n` and `\r` survive.
 *
 * The cap keeps the newest output: a build's failure is at its end. Once anything is dropped, the notice
 * says so at the top, so the model never mistakes a tail for the whole output.
 */

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const STRAY_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Rolling cap on the output kept in memory per process (design §9: ~256 KB). */
export const MAX_PROCESS_OUTPUT_CHARS = 256 * 1024;

export const EMPTY_OUTPUT_MARKER = "(no output — the command wrote nothing to stdout or stderr)";

export function stripAnsiAndControl(input: string): string {
    if (!input) { return input; }
    return input.replace(ANSI_ESCAPE_RE, "").replace(STRAY_CONTROL_RE, "");
}

export function truncationNotice(cap: number): string {
    return `[Output truncated. Showing the last ${Math.round(cap / 1024)}KB.]`;
}

/** The last `cap` characters of `text`, marked as a tail when anything was cut. */
export function tailCap(text: string, cap: number): string {
    return text.length <= cap ? text : `… (earlier output truncated)\n${text.slice(-cap)}`;
}

/**
 * Stdout and stderr interleaved in arrival order, sanitised per chunk and capped from the front. Per-chunk
 * stripping is safe: the regex only matches complete escape sequences, so one split across two chunks
 * leaves a harmless remnant rather than eating text.
 */
export class OutputBuffer {
    private text = "";
    private dropped = false;

    constructor(private readonly cap: number = MAX_PROCESS_OUTPUT_CHARS) {}

    /** Appends a chunk and returns its sanitised form (what a log file should receive). */
    append(chunk: string): string {
        const clean = stripAnsiAndControl(chunk);
        if (!clean) { return clean; }
        const combined = this.text + clean;
        if (combined.length > this.cap) {
            this.text = combined.slice(-this.cap);
            this.dropped = true;
        } else {
            this.text = combined;
        }
        return clean;
    }

    get truncated(): boolean {
        return this.dropped;
    }

    /** The kept output, with the truncation notice on top once anything was dropped. */
    toString(): string {
        return this.dropped ? `${truncationNotice(this.cap)}\n${this.text}` : this.text;
    }
}
