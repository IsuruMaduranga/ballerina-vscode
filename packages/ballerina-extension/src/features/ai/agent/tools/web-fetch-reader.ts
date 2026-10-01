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
 * Pure helpers for web_fetch's reader call, kept apart from web-tools.ts so Jest can load them:
 * web-tools pulls in vscode through the AI client.
 */

export const READER_FETCH_FAILED_PREFIX = 'Fetch failed:';

export const WEB_FETCH_READER_SYSTEM_PROMPT = `You read one web page for another agent. Call web_fetch on the URL, then answer the question using only the fetched content.
Rules:
- Always fetch the URL first. Never answer from memory or prior knowledge.
- Output only the answer. Do not narrate the fetch ("I'll fetch...", "The page says...").
- Quote code, configuration, API signatures, and version numbers exactly as the page shows them.
- If the page does not answer the question, say so, then summarize what the page does cover.
- If the fetch fails, reply with "${READER_FETCH_FAILED_PREFIX}" followed by the reason.`;

interface StepLike {
    toolCalls?: unknown[];
    content?: Array<{ type?: string }>;
}

/**
 * Whether the reader called a tool in any step. With dynamic filtering the fetch can run inside
 * code execution rather than as a direct web_fetch call, so any tool call or result counts; a run
 * with none answered from memory.
 */
export function readerCalledATool(steps: StepLike[] | undefined): boolean {
    return (steps ?? []).some(step =>
        (step.toolCalls?.length ?? 0) > 0
        || (step.content ?? []).some(part => part?.type === 'tool-result' || part?.type === 'tool-error'));
}

/**
 * The tool output for a reader run that fetched. A failed fetch (the system prompt makes the
 * reader start with "Fetch failed:") and an empty answer are failures; an answer cut off at the
 * output cap says so, so the caller does not take it as complete.
 */
export function formatReaderAnswer(url: string, text: string, finishReason: string): { output: string; failed: boolean } {
    const answer = text.trim();
    if (!answer) {
        return { output: `Web fetch failed: the reader returned no answer for ${url}.`, failed: true };
    }
    if (answer.startsWith(READER_FETCH_FAILED_PREFIX)) {
        return { output: `Web fetch failed for ${url}: ${answer.slice(READER_FETCH_FAILED_PREFIX.length).trim()}`, failed: true };
    }
    const truncated = finishReason === 'length' ? '\n\n(The answer was cut off at the reader\'s output limit.)' : '';
    return { output: `Source: ${url}\n\n${answer}${truncated}`, failed: false };
}
