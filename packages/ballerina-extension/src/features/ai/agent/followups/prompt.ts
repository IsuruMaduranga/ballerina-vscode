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

import { ModelMessage } from "ai";
import { ANCHOR_ACTIONS } from "./anchors";

export interface FollowupPromptInput {
    /** The user's last message that produced the response. */
    userQuery: string;
    /** The assistant's final response text for the completed turn. */
    assistantResponse: string;
    /** The generation mode the turn ran in. */
    mode?: string;
}

const anchorGuidance = ANCHOR_ACTIONS.map((a) => `- ${a.label}: ${a.description}`).join("\n");

const SYSTEM_PROMPT = `You suggest the next things a Ballerina developer is most likely to want to do, based on their last exchange with the WSO2 Integrator Copilot.

Given the user's last message and the assistant's response, propose 2-3 short, specific follow-up actions the developer would realistically take next. These are shown as clickable chips; clicking one sends its prompt to Copilot as the user's next message.

Prefer these high-value actions when one is relevant to what just happened, and phrase it for the current context:
${anchorGuidance}

If none of the above fit, generate a contextual suggestion that clearly follows from the last exchange.

Rules:
- Each suggestion has a "label" (imperative chip text, at most ~4 words, e.g. "Add tests") and a "prompt" (a natural first-person message the user would send, e.g. "Add unit tests for the order service").
- Make suggestions specific to the code and context of this exchange, not generic filler.
- No duplicates; each should offer a distinct next step.
- Only suggest actions that genuinely make sense. Fewer good suggestions is better than padding to three.
- Do not suggest actions the assistant already completed in its response.`;

export function buildFollowupMessages(input: FollowupPromptInput): ModelMessage[] {
    const { userQuery, assistantResponse, mode } = input;
    const userContent = `${mode ? `Mode: ${mode}\n\n` : ""}<user_message>
${userQuery}
</user_message>

<assistant_response>
${assistantResponse}
</assistant_response>

Suggest the developer's likely next actions.`;

    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
    ];
}
