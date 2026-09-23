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
 * The one-line completion summary for a background shell command (pure), pincer-agent
 * `extensions/lib/notifications.ts shellSummary` (tip `5059966`) unchanged.
 */

import type { FinishStatus } from "../shell/runner";

export function shellSummary(description: string, status: FinishStatus, exitCode: number | null, detail?: string): string {
    const suffix = detail ? ` (${detail})` : "";
    switch (status) {
        case "completed":
            return `Background command "${description}" completed (exit code ${exitCode ?? 0})${suffix}`;
        case "failed":
            return `Background command "${description}" failed${exitCode !== null ? ` with exit code ${exitCode}` : ""}${suffix}`;
        default:
            return `Background command "${description}" was stopped${suffix}`;
    }
}
