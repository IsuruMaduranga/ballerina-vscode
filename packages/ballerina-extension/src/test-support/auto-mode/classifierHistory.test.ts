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
 * The classifier sees the thread's whole active context, from the latest
 * compaction restart on, and a failed call is "not judged", never a clipped
 * or invented verdict: retries for network failures, provider advice cut
 * from the reason, an over-window transcript not judged, stage 2's budgets.
 */

import { buildCompactionContinuation } from "../../features/ai/agent/compaction-restart";
import {
    classifierNotJudgedText,
    classify,
    isTransportFailure,
    isTranscriptTooLong,
    providerErrorSummary,
    type ClassifierModelCall,
} from "../../features/ai/agent/auto-mode/classifier";
import { defaultEnvironment } from "../../features/ai/agent/auto-mode/classifier-prompt";
import { parseAutoModeConfig } from "../../features/ai/agent/auto-mode/config";
import type { ClassifyRequest } from "../../features/ai/agent/auto-mode/prompt";
import { classifyShellCommand } from "../../features/ai/agent/auto-mode/shell-classify";
import { restartSummary, transcriptFromGenerations, unstoredToolCalls, type TranscriptGeneration } from "../../features/ai/agent/auto-mode/transcript-source";

const config = parseAutoModeConfig(undefined, defaultEnvironment({ kind: "bash" }));

const call = (id: string, tool: string, input: Record<string, unknown>) => ({ type: "tool-call", toolCallId: id, toolName: tool, input });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });

describe("the active context", () => {
    const summary = "The user asked for a scratch build. The agent created build/tmp and wrote build/tmp/a.txt.";
    const restart = buildCompactionContinuation(summary, [
        { type: "text", text: "<codebase>record Order { string id; } // <summary>\nnot this\n</summary></codebase>" },
        { type: "text", text: "<User Query>clean it all up</User Query>" },
    ]);
    const generations: TranscriptGeneration[] = [
        { userPrompt: "make a scratch build", modelMessages: [assistant(call("a1", "shell", { command: "mkdir -p build/tmp" }))] },
        { userPrompt: "write a file there", modelMessages: [assistant(call("b1", "file_write", { file_path: "build/tmp/a.txt", content: "x" }))] },
        {
            userPrompt: "clean it all up",
            restartedFromSummary: true,
            modelMessages: [
                restart,
                assistant(call("c1", "file_read", { file_path: "build/tmp/a.txt" })),
                { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: "SECRET RESULT" }] },
                assistant(call("c2", "file_write", { file_path: "build/tmp/b.txt", content: "y" })),
            ],
        },
    ];

    it("starts at the latest restart, puts the summary after the request, and leaves reads and results out", () => {
        const { entries, userMessages, toolCallIds } = transcriptFromGenerations(generations);
        expect(entries).toEqual([
            { kind: "user", text: "clean it all up" },
            { kind: "summary", text: summary },
            { kind: "tool", tool: "file_write", input: { file_path: "build/tmp/b.txt", content: "y" } },
        ]);
        // Intent is verified against every message the user typed in the thread.
        expect(userMessages).toEqual(["make a scratch build", "write a file there", "clean it all up"]);
        expect(toolCallIds).toEqual(new Set(["c1", "c2"]));
        expect(JSON.stringify(entries)).not.toContain("SECRET RESULT");
    });

    it("reads the summary from the restart message's own block, not a tag in the project source", () => {
        expect(restartSummary(generations[2])).toBe(summary);
        expect(restartSummary({ modelMessages: [{ role: "user", content: [{ type: "text", text: "no summary here" }] }] })).toBeUndefined();
    });

    it("is the whole thread when nothing restarted, with no entry cap", () => {
        const long: TranscriptGeneration[] = Array.from({ length: 3000 }, (_v, i) => ({
            userPrompt: `turn ${i}`,
            modelMessages: [assistant(call(`t${i}`, "shell", { command: `echo ${i}` }))],
        }));
        const { entries } = transcriptFromGenerations(long);
        expect(entries).toHaveLength(6000);
        expect(entries[0]).toEqual({ kind: "user", text: "turn 0" });
    });

    it("drops the run's calls a restart replaced once a later step is stored", () => {
        const runCalls = [
            { toolCallId: "p1", tool: "file_write", input: { file_path: "old.txt" } },
            { toolCallId: "c2", tool: "file_write", input: { file_path: "build/tmp/b.txt" } },
            { toolCallId: "n1", tool: "file_write", input: { file_path: "same-step.txt" } },
            { toolCallId: "n2", tool: "file_read", input: { file_path: "README.md" } },
            { toolCallId: "now", tool: "shell", input: { command: "rm -rf build" } },
        ];
        const { toolCallIds } = transcriptFromGenerations(generations);
        expect(unstoredToolCalls(runCalls, toolCallIds, "now")).toEqual([
            { kind: "tool", tool: "file_write", input: { file_path: "same-step.txt" } },
        ]);
    });

    it("sends the summary and the post-restart calls to the classifier, not the turns the summary replaced", async () => {
        const users: string[] = [];
        const model: ClassifierModelCall = async ({ userParts }) => {
            users.push(userParts.parts.join(""));
            return { text: "<severity>10</severity>", finishReason: "stop" };
        };
        await classifyShellCommand({ command: "rm -rf build/tmp", tool: "shell", cwd: "/w", home: "/home/tester", generations, denials: [], username: "tester", config }, { call: model });
        const transcript = users[0].slice(users[0].indexOf("<transcript>"), users[0].indexOf("</transcript>"));
        expect(transcript).toContain(JSON.stringify({ summary }));
        expect(transcript).toContain("build/tmp/b.txt");
        expect(transcript).not.toContain("mkdir -p build/tmp");
        expect(transcript).not.toContain("record Order");
    });
});

describe("classifier robustness", () => {
    const request = (command = "bal build"): ClassifyRequest => ({
        toolName: "shell",
        transcript: [{ kind: "user", text: "build it" }, { kind: "tool", tool: "shell", input: { command } }],
        userMessages: ["build it"],
        username: "tester",
        environment: config.environment,
    });
    function fakeModel(replies: Array<string | { text: string; finishReason: string } | Error>) {
        const calls: { maxOutputTokens: number; at: number }[] = [];
        const call: ClassifierModelCall = async ({ maxOutputTokens }) => {
            calls.push({ maxOutputTokens, at: Date.now() });
            const next = replies.shift();
            if (next === undefined) { throw new Error("no reply scripted"); }
            if (next instanceof Error) { throw next; }
            return typeof next === "string" ? { text: next, finishReason: "stop" } : next;
        };
        return { call, calls };
    }

    it("gives stage 2 4,096 tokens and one retry at 8,192", async () => {
        const model = fakeModel(["<severity>80</severity>", { text: "<thinking>", finishReason: "length" }, "<severity>10</severity>"]);
        await classify(request(), { call: model.call });
        expect(model.calls.map((c) => c.maxOutputTokens)).toEqual([64, 4096, 8192]);
    });

    it("retries a network failure once after a pause, and judges the retry", async () => {
        const model = fakeModel([new Error("Cannot connect to API: fetch failed"), "<severity>5</severity>"]);
        const verdict = await classify(request(), { call: model.call, transportRetryDelayMs: 40 });
        expect(verdict.decision).toBe("allow");
        expect(model.calls).toHaveLength(2);
        expect(model.calls[1].at - model.calls[0].at).toBeGreaterThanOrEqual(35);
    });

    it("reports a network failure that persists as not judged, naming the network error", async () => {
        const model = fakeModel([new Error("read ECONNRESET"), new Error("read ECONNRESET")]);
        const verdict = await classify(request(), { call: model.call, transportRetryDelayMs: 1 });
        expect(verdict).toMatchObject({ decision: "block", tier: "timeout", noVerdict: true });
        expect(verdict.reason).toContain("network error: read ECONNRESET");
        expect(verdict.reason).toContain("not judged either way");
    });

    it("stops waiting to retry when the user stops the run", async () => {
        const controller = new AbortController();
        const model = fakeModel([new Error("fetch failed")]);
        const pending = classify(request(), { call: model.call, signal: controller.signal, transportRetryDelayMs: 60_000 });
        setTimeout(() => controller.abort(), 10);
        const verdict = await pending;
        expect(verdict.reason).toContain("cancelled");
        expect(model.calls).toHaveLength(1);
    });

    it("does not judge a transcript the provider cannot fit, and does not retry or clip it", async () => {
        const model = fakeModel([new Error("prompt is too long: 1050000 tokens > 1000000 maximum")]);
        const verdict = await classify(request(), { call: model.call });
        expect(verdict).toMatchObject({ decision: "block", tier: "transcript_too_long", noVerdict: true });
        expect(verdict.reason).toContain("longer than the approval classifier's context window");
        expect(verdict.reason).toContain("not judged");
        expect(model.calls).toHaveLength(1);
    });

    it("cuts the provider's advice and links out of the reason", async () => {
        const model = fakeModel([new Error("Invalid prompt: your prompt was flagged. Please try again with a different prompt: https://example.com/policy")]);
        const verdict = await classify(request(), { call: model.call });
        expect(verdict.noVerdict).toBe(true);
        expect(verdict.reason).toBe("The auto-mode classifier returned no verdict (Invalid prompt: your prompt was flagged.).");
    });

    it("tells the agent a call it never judged was not judged, and not to route around it", () => {
        const text = classifierNotJudgedText({ decision: "block", reason: "The auto-mode classifier returned no verdict (overloaded).", tier: "unmatched", noVerdict: true });
        expect(text).toContain("returned no verdict (overloaded)");
        expect(text).toContain("not a judgement that the command is unsafe");
        expect(text).toContain("Do not rephrase it or route around the check");
    });
});

describe("failure classification", () => {
    it.each([
        ["fetch failed", true],
        ["Cannot connect to API: other side closed", true],
        ["getaddrinfo ENOTFOUND api.anthropic.com", true],
        ["connect ECONNREFUSED 127.0.0.1:443", true],
        ["socket hang up", true],
        ["Too Many Requests", false],
        ["Internal Server Error", false],
    ])("transport failure: %s → %s", (message, expected) => {
        expect(isTransportFailure(message)).toBe(expected);
    });

    it.each([
        ["prompt is too long: 250000 tokens > 200000 maximum", true],
        ["Input is too long for requested model.", true],
        ["input length and `max_tokens` exceed context limit: 190000 + 8192 > 200000", true],
        ["max_tokens: 100000 > 64000, which is the maximum allowed", false],
        ["Overloaded", false],
        ["ThrottlingException: Too many tokens, please wait before trying again.", false],
        ["Too many tokens per minute: rate limit reached", false],
    ])("transcript too long: %s → %s", (message, expected) => {
        expect(isTranscriptTooLong(message)).toBe(expected);
    });

    it.each([
        ["Overloaded", "Overloaded"],
        ["Request blocked; try rephrasing your request", "Request blocked"],
        ["Bad request.\nPlease contact support", "Bad request."],
        ["Rate limited: see https://docs.example.com/limits", "Rate limited"],
    ])("provider advice: %s", (message, expected) => {
        expect(providerErrorSummary(message)).toBe(expected);
    });
});
