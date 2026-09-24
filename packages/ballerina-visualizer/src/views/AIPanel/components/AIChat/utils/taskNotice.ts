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
 * How a background-task notice turn reads in the transcript. The host frames completions for the model
 * (`frameTaskNotification` in ballerina-core); the user sees only what finished, without the model-facing
 * task id, output-file path and tool hints.
 */

/** One completion line, cut to what finished and how: `Background command "Build" completed with exit code 0`. */
export function taskNoticeDisplayLine(line: string): string {
    const cut = line.search(/ \(task-[a-z]+-[0-9a-f]+\)|\. Output file:|\. Use task_output|Output tail:/);
    return (cut >= 0 ? line.slice(0, cut) : line).trim().replace(/\.$/, "");
}

/**
 * The notice's completion lines, one per task. A line carrying an output tail spills the tail onto the lines
 * after it; only the summary lines (each starts with "Background") are shown.
 */
export function taskNoticeSummaries(lines: readonly string[]): string[] {
    return lines.filter(line => line.startsWith("Background ")).map(taskNoticeDisplayLine);
}

/** The heading over the lines. */
export function taskNoticeHeading(count: number): string {
    return count === 1 ? "A background task finished" : `${count} background tasks finished`;
}
