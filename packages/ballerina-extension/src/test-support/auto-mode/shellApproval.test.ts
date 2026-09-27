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

jest.mock("@wso2/ballerina-core", () => ({ SkillEnableStage: {} }));
jest.mock("@wso2/ballerina-core/lib/state-machine-types", () => ({ MACHINE_VIEW: {} }));
jest.mock("../../stateMachine", () => ({ StateMachine: {} }));
jest.mock("../../features/ai/state/ApprovalViewManager", () => ({ approvalViewManager: { cleanupAllViews: jest.fn() } }));

import { approvalManager, type ShellApprovalContent } from "../../features/ai/state/ApprovalManager";
import { UNATTENDED_PROMPT_TIMEOUT_MS } from "../../features/ai/agent/auto-mode/pause";

const content: ShellApprovalContent = { toolName: "shell", command: "bal build", reasons: ["Auto mode is paused."] };

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    approvalManager.cancelAllPending("test cleanup");
    jest.useRealTimers();
});

it("denies the unattended resume prompt after two minutes and removes it from pending requests", async () => {
    const event = jest.fn();
    const answer = approvalManager.requestShellApproval("timed", content, event, UNATTENDED_PROMPT_TIMEOUT_MS);
    expect(event).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(UNATTENDED_PROMPT_TIMEOUT_MS - 1);
    expect(approvalManager.getPendingRequestIds()).toContain("timed");
    jest.advanceTimersByTime(1);
    await expect(answer).resolves.toBe("timeout");
    expect(approvalManager.getPendingRequestIds()).not.toContain("timed");
});

it("starts the timeout when its queued banner is displayed", async () => {
    const first = approvalManager.requestShellApproval("first", content, jest.fn());
    const event = jest.fn();
    const second = approvalManager.requestShellApproval("second", content, event, UNATTENDED_PROMPT_TIMEOUT_MS);
    jest.advanceTimersByTime(UNATTENDED_PROMPT_TIMEOUT_MS);
    expect(event).not.toHaveBeenCalled();
    expect(approvalManager.getPendingRequestIds()).toContain("second");
    approvalManager.resolveShellApproval("first", "allow");
    await expect(first).resolves.toBe("allow");
    jest.advanceTimersByTime(0);
    expect(event).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(UNATTENDED_PROMPT_TIMEOUT_MS - 1);
    expect(approvalManager.getPendingRequestIds()).toContain("second");
    jest.advanceTimersByTime(1);
    await expect(second).resolves.toBe("timeout");
});

it("clears the timeout on an answer or a cancelled run", async () => {
    const answer = approvalManager.requestShellApproval("answered", content, jest.fn(), UNATTENDED_PROMPT_TIMEOUT_MS);
    approvalManager.resolveShellApproval("answered", "allow");
    await expect(answer).resolves.toBe("allow");
    jest.advanceTimersByTime(0);
    expect(jest.getTimerCount()).toBe(0);
    const cancelled = approvalManager.requestShellApproval("cancelled", content, jest.fn(), UNATTENDED_PROMPT_TIMEOUT_MS);
    approvalManager.cancelAllPending("user stopped");
    await expect(cancelled).resolves.toBe("deny");
    expect(jest.getTimerCount()).toBe(0);
});
