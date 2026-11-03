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
 * shell/exit-semantics.ts: which nonzero exits read as plain output rather than a failure. The Bash side
 * runs on the vendored grammar (`parserSetup.ts` waits for it); the PowerShell side is textual.
 */
import { bashExitOneIsSuccess, exitJudgeFor, gitSubcommandOf, powershellExitIsSuccess } from "../../features/ai/agent/shell/exit-semantics";
import { EMPTY_OUTPUT_MARKER } from "../../features/ai/agent/shell/output";

describe("bashExitOneIsSuccess", () => {
    it.each([
        "grep absent file",
        "rg absent file",
        "egrep absent file",
        "fgrep absent file",
        "find file",
        "diff a b",
        "test -e file",
        "[ -e file ]",
        "git grep absent",
        "git -C root diff --quiet",
        "git --git-dir .git --work-tree . diff --quiet",
        "echo one | rg absent",
        "echo one; rg absent",
        "echo one || rg absent",
        "grep absent file 2>/dev/null",
        "grep absent file # look for it",
    ])("treats exit 1 of %s as a success", (command) => {
        expect(bashExitOneIsSuccess(command)).toBe(true);
    });

    it.each([
        "false",
        "false && rg absent",
        "env rg absent",
        "/usr/bin/grep absent file",
        "git status",
        "cat a.txt",
        `rg ${"x".repeat(10_000)}`,
    ])("keeps exit 1 of %s a failure", (command) => {
        expect(bashExitOneIsSuccess(command)).toBe(false);
    });
});

describe("gitSubcommandOf", () => {
    it("skips global options and the values of those that take one", () => {
        expect(gitSubcommandOf(["-C", "repo", "diff"])).toBe("diff");
        expect(gitSubcommandOf(["-c", "a=b", "grep", "x"])).toBe("grep");
        expect(gitSubcommandOf(["--git-dir", ".git", "--work-tree", ".", "diff"])).toBe("diff");
        expect(gitSubcommandOf(["--git-dir=.git", "status"])).toBe("status");
        expect(gitSubcommandOf(["--no-pager"])).toBeUndefined();
    });
});

describe("powershellExitIsSuccess", () => {
    it.each<[string, string, number]>([
        ["findstr absent notes.txt", "", 1],
        ["rg absent", "", 1],
        ["& 'C:\\Tools\\rg.exe' absent", "", 1],
        ["robocopy src dst /E", "  Files : 3", 3],
        ["robocopy src dst /E", "  Files : 3", 7],
        ["where.exe node", "INFO: Could not find files for the given pattern(s).", 1],
        ["fc.exe a.txt b.txt", "***** a.txt", 1],
        ["git -C repo diff --quiet", "", 1],
        ["git --git-dir .git --work-tree . diff --quiet", "", 1],
        ["Get-ChildItem; grep absent notes.txt", "a.txt", 1],
    ])("treats %s (output %j, exit %i) as a success", (command, output, code) => {
        expect(powershellExitIsSuccess(command, code, output)).toBe(true);
    });

    it.each<[string, string, number]>([
        ["robocopy src dst /E", "ERROR 5", 8],
        ["rg absent", "", 2],
        ["where node", "x", 1],
        ["where.exe node", "", 1],
        ["fc a.txt b.txt", "***** a.txt", 1],
        ["Test-Path x && rg absent", "", 1],
        ["rg absent", "rg : The term 'rg' is not recognized as a name of a cmdlet", 1],
        ["findstr absent notes.txt", "FINDSTR: Cannot open notes.txt", 1],
        ["Remove-Item x", "", 1],
    ])("keeps %s (output %j, exit %i) a failure", (command, output, code) => {
        expect(powershellExitIsSuccess(command, code, output)).toBe(false);
    });
});

describe("exitJudgeFor", () => {
    it("accepts only exit 1 on the Bash side", () => {
        const judge = exitJudgeFor("bash", "grep absent file");
        expect(judge(1, EMPTY_OUTPUT_MARKER)).toBe(true);
        expect(judge(2, EMPTY_OUTPUT_MARKER)).toBe(false);
        expect(exitJudgeFor("bash", "cat a.txt")(1, "")).toBe(false);
    });

    it("reads the runner's empty-output marker as no output on the PowerShell side", () => {
        expect(exitJudgeFor("powershell", "where.exe node")(1, EMPTY_OUTPUT_MARKER)).toBe(false);
        expect(exitJudgeFor("powershell", "where.exe node")(1, "C:\\node.exe")).toBe(true);
    });
});
