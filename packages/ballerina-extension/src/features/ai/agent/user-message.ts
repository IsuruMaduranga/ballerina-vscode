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
 * The user's message as the turn sends it: the turn's last block, a text block of its own with no
 * wrapping tags, as MI Copilot sends it, since every other block of the turn is context in its own
 * tags. What the UI attaches without the user typing it (a selected snippet, a skill's mode) comes
 * just before it, as a reminder.
 *
 * Pure.
 */

export type TextBlock = { type: "text"; text: string };

export function userMessageBlocks(usecase: string | undefined, hiddenContext?: string): TextBlock[] {
    const blocks: TextBlock[] = [];
    if (hiddenContext?.trim()) {
        blocks.push({ type: "text", text: `<system-reminder>\nContext attached to the user's message below:\n${hiddenContext}\n</system-reminder>` });
    }
    // The API rejects an empty text block.
    if (usecase?.trim()) {
        blocks.push({ type: "text", text: usecase });
    }
    return blocks;
}
