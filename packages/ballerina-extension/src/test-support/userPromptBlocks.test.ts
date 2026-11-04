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

/**
 * The user's message reaches the model as a text block of its own, with no wrapping tags (as MI
 * Copilot sends it), last in the turn; context the UI attaches comes just before it (agent/user-message.ts).
 */

import { userMessageBlocks } from "../features/ai/agent/user-message";

it("sends the user's message as its own untagged block", () => {
    expect(userMessageBlocks("add a get endpoint to get tickets")).toEqual([{ type: "text", text: "add a get endpoint to get tickets" }]);
});

it("puts the context the UI attaches in a reminder just before the message", () => {
    expect(userMessageBlocks("map these records", "Mode: inline")).toEqual([
        { type: "text", text: "<system-reminder>\nContext attached to the user's message below:\nMode: inline\n</system-reminder>" },
        { type: "text", text: "map these records" },
    ]);
});

it("sends no empty block", () => {
    expect(userMessageBlocks("  ", "")).toEqual([]);
    expect(userMessageBlocks(undefined)).toEqual([]);
});
