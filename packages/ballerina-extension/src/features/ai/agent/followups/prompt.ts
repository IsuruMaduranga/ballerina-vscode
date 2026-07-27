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

const SYSTEM_PROMPT = `You help users of the WSO2 Integrator Copilot decide what to do next.

The Copilot builds integrations for the user. Given the user's last message and the Copilot's response, propose 2-3 short, specific follow-up actions the user is most likely to want next. Each is shown as a clickable chip; clicking one sends its prompt to the Copilot as the user's next message.

Prefer these high-value actions when one fits what just happened, and phrase it for the current context:
${anchorGuidance}

If none fit, suggest a next step that clearly follows from the last exchange.

Scope — only suggest things the Copilot can actually do: build, change, explain, run, or test the user's integration, or connect it to other systems or services. Never suggest anything else, because it will be refused — in particular, no deploying to a container or cloud platform, and no infrastructure, CI/CD, or cloud-provider setup.

Audience — the user builds integrations in a friendly, low-code product and may not be a programmer. Write every label and prompt in plain, outcome-focused language: say what the user gets, not how it is built. Never expose implementation details — no programming-language or Ballerina specifics, no command-line commands, no code, annotation, or configuration syntax, no file, module, or library names, and no technical keywords or type names.

Output:
- Each suggestion has a "label" (imperative chip text, max ~4 words, e.g. "Add tests") and a "prompt" (a natural first-person message the user would send, e.g. "Add tests for the order service").
- Base every suggestion on what actually happened in this exchange — be specific, never generic filler.
- No duplicates; each must offer a distinct next step.
- Only include actions that genuinely make sense; one or two strong suggestions beat three padded ones.
- Never suggest something the Copilot already did in its response.`;

export function buildFollowupMessages(input: FollowupPromptInput): ModelMessage[] {
    const { userQuery, assistantResponse, mode } = input;
    const userContent = `${mode ? `Mode: ${mode}\n\n` : ""}<user_message>
${userQuery}
</user_message>

<assistant_response>
${assistantResponse}
</assistant_response>

Suggest the user's likely next actions.`;

    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
    ];
}
