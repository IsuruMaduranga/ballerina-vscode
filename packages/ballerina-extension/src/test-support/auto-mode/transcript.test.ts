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

/** The classifier transcript, ported from an earlier harness's transcript test suites (bash and PowerShell). */

import { RESOLVED_PATHS_NOTE } from "../../features/ai/agent/auto-mode/resolved-paths-meta";
import { isHistoricalRead, renderTranscript, transcriptBlocks, transcriptToolName, type TranscriptEntry } from "../../features/ai/agent/auto-mode/transcript";

describe("transcriptToolName", () => {
    it("names the shell tools as Claude Code does and keeps every other tool's own name", () => {
        expect(transcriptToolName("shell")).toBe("Bash");
        expect(transcriptToolName("powershell")).toBe("PowerShell");
        expect(transcriptToolName("file_edit")).toBe("file_edit");
        expect(transcriptToolName("mcp__server__tool")).toBe("mcp__server__tool");
    });
});

describe("renderTranscript", () => {
    const entries: TranscriptEntry[] = [
        { kind: "user", text: "clean up /tmp/x" },
        { kind: "tool", tool: "shell", input: { command: "rm -rf /tmp/x" } },
        { kind: "tool", tool: "edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" } },
    ];

    it("wraps the lines in a <transcript> block", () => {
        const out = renderTranscript(entries);
        expect(out.startsWith("<transcript>\n")).toBe(true);
        expect(out.endsWith("\n</transcript>")).toBe(true);
    });

    it("renders a user message as {\"user\":…}", () => {
        expect(renderTranscript([entries[0]])).toContain('{"user":"clean up /tmp/x"}');
    });

    it("renders bash as the command string, others as the input object", () => {
        const out = renderTranscript(entries);
        expect(out).toContain('{"Bash":"rm -rf /tmp/x"}');
        expect(out).toContain('{"edit":{"file_path":"/repo/a.ts"');
    });

    it("never carries tool results — only inputs are ever passed in", () => {
        // The type has no result channel; this asserts the contract stays that way.
        const out = renderTranscript([{ kind: "tool", tool: "read", input: { file_path: "/x" } }]);
        expect(out).not.toContain("result");
    });

    it("renders every entry whole, earlier ones included, with no window", () => {
        const old = `${"old".repeat(30_000)} REDIRECT > ~/.ssh/authorized_keys`;
        const many: TranscriptEntry[] = Array.from({ length: 400 }, (_v, i) => ({
            kind: "tool",
            tool: "shell",
            input: { command: `echo step-${i} ${"x".repeat(200)}` },
        }));
        const out = renderTranscript([{ kind: "tool", tool: "shell", input: { command: old } }, ...many, { kind: "tool", tool: "shell", input: { command: "current" } }]);
        expect(out).toContain(JSON.stringify(old));
        expect(out).toContain("step-0 ");
        expect(out).not.toContain("truncated");
        expect(out).not.toContain("omitted");
    });
});

describe("transcriptBlocks", () => {
    it("gives each earlier entry its own block and keeps the action in the tail", () => {
        const entries: TranscriptEntry[] = [
            { kind: "user", text: "clean up" },
            { kind: "tool", tool: "file_write", input: { file_path: "a.txt", content: "a" } },
            { kind: "tool", tool: "shell", input: { command: "rm a.txt" } },
        ];
        const { history, tail } = transcriptBlocks(entries);
        expect(history).toEqual(["<transcript>", '\n{"user":"clean up"}', '\n{"file_write":{"file_path":"a.txt","content":"a"}}']);
        expect(tail).toBe('\n{"Bash":"rm a.txt"}\n</transcript>');
        expect(history.join("") + tail).toBe(renderTranscript(entries));
    });

    it("renders an earlier entry to the same block whatever follows it", () => {
        const first = transcriptBlocks([{ kind: "user", text: "u" }, { kind: "tool", tool: "shell", input: { command: "a" } }]);
        const later = transcriptBlocks([
            { kind: "user", text: "u" },
            { kind: "tool", tool: "shell", input: { command: "a" } },
            { kind: "tool", tool: "shell", input: { command: "b" } },
        ]);
        expect(later.history.slice(0, first.history.length)).toEqual(first.history);
    });

    it("keeps the ground-truth lines with a large action, in order", () => {
        const big = `echo ${"x".repeat(90_000)} >> notes.txt`;
        const lines = renderTranscript([
            { kind: "user", text: "older" },
            { kind: "meta", gitStatus: { clean: true } },
            { kind: "resolved-paths", resolvedPaths: [{ path: "notes.txt", resolvesTo: "/home/u/.ssh/authorized_keys" }] },
            { kind: "tool", tool: "shell", input: { command: big } },
        ]).split("\n");
        expect(lines[1]).toBe('{"user":"older"}');
        expect(lines[2]).toBe('{"meta":{"gitStatus":{"clean":true}}}');
        expect(lines[3]).toContain('"resolvedPaths"');
        expect(lines[4]).toBe(JSON.stringify({ Bash: big }));
        const { tail } = transcriptBlocks([
            { kind: "user", text: "older" },
            { kind: "meta", gitStatus: { clean: true } },
            { kind: "tool", tool: "shell", input: { command: big } },
        ]);
        expect(tail.startsWith('\n{"meta":{"gitStatus"')).toBe(true);
    });

    it("renders the resolvedPaths line with its own note, and the summary line as model context", () => {
        const text = renderTranscript([
            { kind: "summary", text: "Earlier the agent created build/tmp." },
            { kind: "resolved-paths", resolvedPaths: [{ path: "notes.txt", resolvesTo: "/outside/secret" }] },
            { kind: "tool", tool: "shell", input: { command: "echo x >> notes.txt" } },
        ]);
        expect(text.split("\n")).toEqual([
            "<transcript>",
            '{"summary":"Earlier the agent created build/tmp."}',
            JSON.stringify({ meta: { resolvedPaths: [{ path: "notes.txt", resolvesTo: "/outside/secret" }], note: RESOLVED_PATHS_NOTE } }),
            '{"Bash":"echo x >> notes.txt"}',
            "</transcript>",
        ]);
    });

    it("counts local reads and searches as historical reads, and nothing that runs or writes", () => {
        expect(isHistoricalRead({ kind: "tool", tool: "file_read", input: { file_path: "a" } })).toBe(true);
        expect(isHistoricalRead({ kind: "tool", tool: "getCompilationErrors", input: {} })).toBe(true);
        expect(isHistoricalRead({ kind: "tool", tool: "file_write", input: { file_path: "a" } })).toBe(false);
        expect(isHistoricalRead({ kind: "tool", tool: "shell", input: { command: "cat a" } })).toBe(false);
        expect(isHistoricalRead({ kind: "user", text: "file_read" })).toBe(false);
    });
});

describe("rule denials", () => {
    it("renders a denial as its own line, naming the rule and what was attempted", () => {
        const out = renderTranscript([
            { kind: "user", text: "Delete scripts/slow_build.sh" },
            { kind: "denied", tool: "shell", subject: "rm scripts/slow_build.sh", rule: "Bash(rm:*)" },
            { kind: "tool", tool: "shell", input: { command: "python3 -c \"import os; os.remove('scripts/slow_build.sh')\"" } },
        ]);
        expect(out).toContain('"denied_by_permission_rule"');
        expect(out).toContain('"rule":"Bash(rm:*)"');
        expect(out).toContain('"attempted":"rm scripts/slow_build.sh"');
        expect(out).toContain('"tool":"Bash"');
    });

    it("keeps a long denied subject whole like every other field", () => {
        const out = renderTranscript([
            { kind: "denied", tool: "shell", subject: "x".repeat(5000), rule: "Bash(rm:*)" },
            { kind: "tool", tool: "shell", input: { command: "current" } },
        ]);
        expect(out).toContain("x".repeat(5000));
        expect(out).not.toContain("truncated");
    });
});



describe("renderTranscript — PowerShell and the gitStatus meta line", () => {
    it("renders a powershell call as {\"PowerShell\":\"<command>\"} like Bash", () => {
        const text = renderTranscript([
            { kind: "user", text: "check the tree" },
            { kind: "tool", tool: "powershell", input: { command: "git status", description: "look" } },
            { kind: "tool", tool: "shell", input: { command: "git status" } },
        ]);
        expect(text).toContain('{"PowerShell":"git status"}');
        expect(text).toContain('{"Bash":"git status"}');
        expect(text).not.toContain('"description"');
    });

    it("renders the captured ground-truth line after a git status", () => {
        const text = renderTranscript([
            { kind: "tool", tool: "powershell", input: { command: "git status" } },
            { kind: "meta", gitStatus: { clean: true } },
        ]);
        expect(text.split("\n")).toEqual(["<transcript>", '{"PowerShell":"git status"}', '{"meta":{"gitStatus":{"clean":true}}}', "</transcript>"]);
    });

    it("renders a denied powershell call with Claude Code's tool name", () => {
        const text = renderTranscript([{ kind: "denied", tool: "powershell", subject: "rm -r x", rule: "PowerShell(Remove-Item:*)" }]);
        expect(text).toContain('"tool":"PowerShell"');
    });
});
