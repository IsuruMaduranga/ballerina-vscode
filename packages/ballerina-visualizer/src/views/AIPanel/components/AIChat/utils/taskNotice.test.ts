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
 * @jest-environment node
 *
 * How a background-task notice turn reads: the host's frame (ballerina-core) round-trips through the
 * webview's parser, and the user sees what finished without the model-facing ids, paths and hints.
 */

// The source file, not the package: this suite cannot load @wso2/ballerina-core, and the frame module has no imports.
import { frameTaskNotification, parseTaskNotification } from "../../../../../../../ballerina-core/src/rpc-types/ai-panel/task-notification";
import { taskNoticeDisplayLine, taskNoticeHeading, taskNoticeSummaries } from "./taskNotice";

const SPOOLED = 'Background command "Build the project" completed (exit code 0) (task-shell-1a2b3c4d). Output file: /tmp/x/output.log. Use task_output to retrieve the output.';
const WITH_TAIL = 'Background command "Run tests" failed with exit code 1 (task-shell-00ff00ff). Output tail:\nerror: 2 tests failed\n  at foo';

describe("task notice frame", () => {
    it("round-trips the completion lines of a wake turn", () => {
        const text = frameTaskNotification([SPOOLED], "opens-turn");
        expect(text.startsWith("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n")).toBe(true);
        expect(parseTaskNotification(text)).toEqual([SPOOLED]);
    });

    it("is not a notice for the user's own words, even when they quote the marker", () => {
        expect(parseTaskNotification("[SYSTEM NOTIFICATION - NOT USER INPUT] hello")).toBeUndefined();
        expect(parseTaskNotification("create a service")).toBeUndefined();
        expect(parseTaskNotification(undefined)).toBeUndefined();
    });
});

describe("task notice display", () => {
    it("keeps what finished and how, and drops the id, path and tool hint", () => {
        expect(taskNoticeDisplayLine(SPOOLED)).toBe('Background command "Build the project" completed (exit code 0)');
    });

    it("shows one line per task, not the output tail that spills after it", () => {
        const lines = parseTaskNotification(frameTaskNotification([WITH_TAIL, SPOOLED], "opens-turn"))!;
        expect(taskNoticeSummaries(lines)).toEqual([
            'Background command "Run tests" failed with exit code 1',
            'Background command "Build the project" completed (exit code 0)',
        ]);
    });

    it("heads the lines by count", () => {
        expect(taskNoticeHeading(1)).toBe("A background task finished");
        expect(taskNoticeHeading(3)).toBe("3 background tasks finished");
    });
});
