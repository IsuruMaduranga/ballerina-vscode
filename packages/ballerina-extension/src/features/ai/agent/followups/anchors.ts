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
 * High-value follow-up actions a Ballerina developer commonly wants next.
 *
 * These are NOT rigid templates. They steer the model (hybrid strategy): when one of
 * these is relevant to the last exchange, the model is told to prefer it and phrase it
 * for the current context; otherwise it generates a contextual suggestion of its own.
 */
export interface AnchorAction {
    /** Short chip text, imperative (what the user sees). */
    label: string;
    /** When this action is worth suggesting — guidance for the model, not shown to the user. */
    description: string;
}

export const ANCHOR_ACTIONS: AnchorAction[] = [
    { label: "Add tests", description: "generate unit or integration tests for the code just written" },
    { label: "Try it out", description: "run or invoke the service/function to see it working" },
    { label: "Add error handling", description: "handle errors, timeouts, and edge cases in the code" },
    { label: "Add authentication", description: "secure the service (auth/authz, API keys, OAuth2)" },
    { label: "Add logging", description: "add logging or observability for debugging and monitoring" },
    { label: "Validate input", description: "validate and sanitize incoming request payloads or parameters" },
    { label: "Explain the code", description: "walk through how the generated code works" },
    { label: "Add a connector", description: "integrate an external service using a Ballerina connector" },
    { label: "Deploy", description: "deploy or containerize the integration" },
];
