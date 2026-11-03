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
 * The classifier's cache breakpoints: one block per transcript entry with the
 * same text, a breakpoint after the last history entry and after the previous
 * call's history, never more than four in a request. The wire tests send the
 * request through the real Anthropic and Bedrock (InvokeModel) providers with
 * a stubbed fetch and read the body they build.
 */

import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel } from "ai";
import { classify, type ClassifierModelCall } from "../../features/ai/agent/auto-mode/classifier";
import { classifierMessages, classifierUserContent, MAX_CACHE_MARKERS, type ClassifierCacheState, type ClassifierUserText } from "../../features/ai/agent/auto-mode/classifier-cache";
import { defaultEnvironment } from "../../features/ai/agent/auto-mode/classifier-prompt";
import { parseAutoModeConfig } from "../../features/ai/agent/auto-mode/config";
import type { ClassifyRequest } from "../../features/ai/agent/auto-mode/prompt";
import type { TranscriptEntry } from "../../features/ai/agent/auto-mode/transcript";

/** `getProviderCacheControl('1h')`'s shape, spelled out: importing it would load the login machinery. */
const MARKER = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" as const } } };

const user = (parts: string[], historyEnd: number, previousHistoryEnd?: number): ClassifierUserText => ({ parts, historyEnd, previousHistoryEnd });
const marked = (content: { providerOptions?: unknown }[]) => content.flatMap((part, i) => (part.providerOptions ? [i] : []));

describe("classifierUserContent", () => {
    const parts = ["<transcript>", "\n{\"user\":\"a\"}", "\n{\"Bash\":\"b\"}", "\n{\"Bash\":\"c\"}\n</transcript>", "\n\nStage 1"];

    it("keeps the text and marks the last history entry, not the action or the stage instruction", () => {
        const content = classifierUserContent(user(parts, 2), MARKER, 1);
        expect(content.map((part) => part.text).join("")).toBe(parts.join(""));
        expect(marked(content)).toEqual([2]);
    });

    it("also marks the previous call's history end while it is earlier and a slot is free", () => {
        expect(marked(classifierUserContent(user(parts, 2, 1), MARKER, 1))).toEqual([1, 2]);
        expect(marked(classifierUserContent(user(parts, 2, 2), MARKER, 1))).toEqual([2]);
        expect(marked(classifierUserContent(user(parts, 1, 2), MARKER, 1))).toEqual([1]);
        expect(marked(classifierUserContent(user(parts, 2, 1), MARKER, 2))).toEqual([1, 2]);
    });

    it("drops the previous-call mark first, then every mark, rather than exceed four", () => {
        expect(marked(classifierUserContent(user(parts, 2, 1), MARKER, 3))).toEqual([2]);
        const none = classifierUserContent(user(parts, 2, 1), MARKER, MAX_CACHE_MARKERS);
        expect(none).toEqual([{ type: "text", text: parts.join("") }]);
    });

    it("sends one unmarked block when a block would be blank or the index is out of range", () => {
        expect(classifierUserContent(user(["<transcript>", "  ", "x"], 0), MARKER, 1)).toEqual([{ type: "text", text: "<transcript>  x" }]);
        expect(classifierUserContent(user(parts, 9), MARKER, 1)).toHaveLength(1);
    });
});

describe("the parts the classifier hands its model call", () => {
    const config = parseAutoModeConfig(undefined, defaultEnvironment({ kind: "bash" }));
    const request = (transcript: TranscriptEntry[]): ClassifyRequest => ({
        toolName: "shell",
        transcript,
        userMessages: ["tidy the build"],
        agentsMd: "Never delete docs/.",
        username: "tester",
        environment: config.environment,
    });
    const history: TranscriptEntry[] = [
        { kind: "user", text: "tidy the build" },
        { kind: "tool", tool: "file_write", input: { file_path: "build/tmp.txt", content: "x" } },
    ];

    it("joins to the user text, ends history before the action's facts, and passes the hint on", async () => {
        const seen: Parameters<ClassifierModelCall>[0][] = [];
        const call: ClassifierModelCall = async (args) => {
            seen.push(args);
            return { text: seen.length === 1 ? "<severity>70</severity>" : "<severity>10</severity>", finishReason: "stop" };
        };
        const cache: ClassifierCacheState = {};
        await classify(request([...history, { kind: "meta", gitStatus: { clean: true } }, { kind: "tool", tool: "shell", input: { command: "rm build/tmp.txt" } }]), { call, cache });
        expect(seen).toHaveLength(2);
        for (const args of seen) {
            const { parts, historyEnd } = args.userParts;
            expect(parts.join("")).toBe(args.user);
            expect(parts[0]).toContain("<user_agents_md>");
            expect(parts[historyEnd]).toContain("build/tmp.txt");
            expect(parts[historyEnd + 1].startsWith('\n{"meta":{"gitStatus"')).toBe(true);
        }
        // Stage 1 and stage 2 share every block but the stage instruction.
        expect(seen[1].userParts.parts.slice(0, -1)).toEqual(seen[0].userParts.parts.slice(0, -1));
        expect(seen[0].userParts.previousHistoryEnd).toBeUndefined();
        expect(seen[1].userParts.previousHistoryEnd).toBe(seen[0].userParts.historyEnd);
        expect(cache.historyEnd).toBe(seen[0].userParts.historyEnd);

        // The next command in the thread sees the earlier history end as its hint.
        const next: Parameters<ClassifierModelCall>[0][] = [];
        await classify(request([...history, { kind: "tool", tool: "shell", input: { command: "rm build/tmp.txt" } }, { kind: "tool", tool: "shell", input: { command: "ls" } }]), {
            call: async (args) => { next.push(args); return { text: "<severity>5</severity>", finishReason: "stop" }; },
            cache,
        });
        expect(next[0].userParts.previousHistoryEnd).toBe(seen[0].userParts.historyEnd);
        expect(next[0].userParts.historyEnd).toBe(seen[0].userParts.historyEnd + 1);
        expect(next[0].userParts.parts.slice(0, seen[0].userParts.historyEnd + 1)).toEqual(seen[0].userParts.parts.slice(0, seen[0].userParts.historyEnd + 1));
    });
});

describe("the request on the wire", () => {
    const reply = {
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "<severity>5</severity>" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
    };
    const capture = () => {
        const bodies: any[] = [];
        const fetch = jest.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
        });
        return { bodies, fetch: fetch as any };
    };
    const parts = ["<transcript>", ...Array.from({ length: 30 }, (_v, i) => `\n{"Bash":"step ${i}"}`), '\n{"Bash":"rm x"}\n</transcript>', "\n\nStage 1"];
    const send = async (model: LanguageModel) => {
        const result = await generateText({ model, maxOutputTokens: 100, messages: classifierMessages("RULESET", user(parts, 30, 5), MARKER) });
        return result;
    };
    const breakpoints = (body: any) => [
        ...body.system.filter((block: any) => block.cache_control),
        ...body.messages.flatMap((message: any) => message.content.filter((block: any) => block.cache_control)),
    ];

    it.each([
        ["Anthropic", (fetch: any) => createAnthropic({ apiKey: "test-key", fetch })("claude-sonnet-5-5")],
        ["Bedrock InvokeModel", (fetch: any) => createBedrockAnthropic({ region: "us-east-1", apiKey: "test-key", fetch })("us.anthropic.claude-sonnet-5-5")],
    ])("%s: one block per part, 1h breakpoints on the system prompt and the two history ends, three in all", async (_name, make) => {
        const { bodies, fetch } = capture();
        const result = await send(make(fetch));
        const body = bodies[0];
        expect(body.messages).toHaveLength(1);
        const content = body.messages[0].content;
        expect(content.map((block: any) => block.text)).toEqual(parts);
        expect(content.flatMap((block: any, i: number) => (block.cache_control ? [i] : []))).toEqual([5, 30]);
        expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
        const all = breakpoints(body);
        expect(all.length).toBeLessThanOrEqual(MAX_CACHE_MARKERS);
        expect(all).toHaveLength(3);
        for (const block of all) { expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" }); }
        expect(result.warnings ?? []).toEqual([]);
    });
});
