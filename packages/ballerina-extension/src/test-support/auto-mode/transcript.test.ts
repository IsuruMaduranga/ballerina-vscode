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

/** The classifier transcript, ported from pincer-agent `test/unit/auto-mode-transcript.test.ts` and `transcript-powershell.test.ts` (`3b290c8`). */

import { renderTranscript, transcriptToolName, type TranscriptEntry } from "../../features/ai/agent/auto-mode/transcript";

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

    it("clips an oversized field so one argument cannot dominate", () => {
        const out = renderTranscript([{ kind: "tool", tool: "shell", input: { command: "x".repeat(50_000) } }], {
            maxField: 100,
        });
        expect(out).toContain("truncated");
        expect(out.length).toBeLessThan(1000);
    });

    it("drops oldest entries past the char budget but always keeps the action under review", () => {
        const many: TranscriptEntry[] = Array.from({ length: 50 }, (_v, i) => ({
            kind: "tool",
            tool: "shell",
            input: { command: `echo step-${i} ${"x".repeat(200)}` },
        }));
        many.push({ kind: "tool", tool: "shell", input: { command: "THE-ACTION-UNDER-REVIEW" } });
        const out = renderTranscript(many, { maxChars: 2000 });
        expect(out).toContain("THE-ACTION-UNDER-REVIEW"); // last entry always kept
        expect(out).toContain("omitted for length");
        expect(out).not.toContain("step-0 ");
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

    it("clips a long denied subject like every other field", () => {
        const out = renderTranscript([{ kind: "denied", tool: "shell", subject: "x".repeat(5000), rule: "Bash(rm:*)" }], { maxField: 50 });
        expect(out).toContain("truncated");
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
