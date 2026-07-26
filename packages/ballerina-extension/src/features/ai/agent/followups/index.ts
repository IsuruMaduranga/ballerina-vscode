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

import { generateObject } from "ai";
import { ANTHROPIC_HAIKU, getAnthropicClient } from "../../utils/ai-client";
import { buildFollowupMessages, FollowupPromptInput } from "./prompt";
import { followupSuggestionsSchema, GeneratedFollowupSuggestion } from "./schema";

const MAX_SUGGESTIONS = 3;

export interface GenerateFollowupsOptions extends FollowupPromptInput {
    /** Aborts the call when the turn is superseded or the panel closes. */
    abortSignal?: AbortSignal;
}

/**
 * Generates a small set of follow-up suggestions for a completed turn.
 *
 * Best-effort: any failure (model error, timeout, abort, or output that fails schema
 * validation) resolves to an empty array so the caller can simply show no chips.
 */
export async function generateFollowupSuggestions(
    options: GenerateFollowupsOptions
): Promise<GeneratedFollowupSuggestion[]> {
    const { abortSignal, ...promptInput } = options;

    // Nothing to build suggestions from.
    if (!promptInput.assistantResponse?.trim()) {
        return [];
    }

    try {
        const { object } = await generateObject({
            model: await getAnthropicClient(ANTHROPIC_HAIKU),
            maxOutputTokens: 1024,
            temperature: 0.3,
            messages: buildFollowupMessages(promptInput),
            schema: followupSuggestionsSchema,
            abortSignal: abortSignal ?? new AbortController().signal,
        });
        return sanitize(object.suggestions);
    } catch (error) {
        console.warn("[Followups] Suggestion generation failed:", error);
        return [];
    }
}

/** Trims, drops blanks/duplicates, and caps the list. */
function sanitize(raw: GeneratedFollowupSuggestion[]): GeneratedFollowupSuggestion[] {
    const seen = new Set<string>();
    const out: GeneratedFollowupSuggestion[] = [];
    for (const s of raw ?? []) {
        const label = s?.label?.trim();
        const prompt = s?.prompt?.trim();
        if (!label || !prompt) {
            continue;
        }
        const key = label.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ label, prompt });
        if (out.length >= MAX_SUGGESTIONS) {
            break;
        }
    }
    return out;
}
