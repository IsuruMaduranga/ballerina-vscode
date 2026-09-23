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

/** The `{"meta":{"gitStatus":…}}` transcript line, ported from pincer-agent `test/unit/auto-mode-git-status-meta.test.ts` (`3b290c8`). */

import { expectLabeled } from "./labeled";
import { destructiveCategory, gitStatusMeta, gitStatusMetaArgs, reachesIgnoredFiles, wantsGitStatusMeta } from "../../features/ai/agent/auto-mode/git-status-meta";
import { renderTranscript } from "../../features/ai/agent/auto-mode/transcript";

describe("the transcript's gitStatus line", () => {
    it("goes above bash commands that can destroy uncommitted work", () => {
        for (const command of ["git reset --hard HEAD~1", "git checkout .", "git restore -- .", "git clean -fdx", "rm -rf dist", "rm -r build", "rm -f a.txt", "ls && rm -fr x"]) {
            expectLabeled(wantsGitStatusMeta("bash", command), command).toBe(true);
        }
        for (const command of ["git status", "git clean -n", "git clean --dry-run -f", "rm a.txt", "git checkout main", "git stash drop", "git branch -D x"]) {
            expectLabeled(wantsGitStatusMeta("bash", command), command).toBe(false);
        }
    });

    it("adds the line for any destructive part of a compound command", () => {
        // The command is named by its first match (a force push), but the rm later
        // in the line still destroys uncommitted work.
        expect(destructiveCategory("bash", "git push --force origin x && rm -rf y")).toBe("git_force_push");
        expect(wantsGitStatusMeta("bash", "git push --force origin x && rm -rf y")).toBe(true);
    });

    it("goes above PowerShell removals too", () => {
        expect(wantsGitStatusMeta("powershell", "Remove-Item -Recurse -Force dist")).toBe(true);
        expect(wantsGitStatusMeta("powershell", "Clear-Content *.log")).toBe(true);
        expect(wantsGitStatusMeta("powershell", "Remove-Item a.txt")).toBe(false);
    });

    it("summarizes porcelain output as clean or counts", () => {
        expect(gitStatusMeta("")).toEqual({ clean: true });
        expect(gitStatusMeta("M  staged.ts\n M modified.ts\nMM both.ts\n?? new.txt\n")).toEqual({ staged: 2, modified: 2, untracked: 1 });
    });

    it("withholds clean when only ignored entries remain", () => {
        expect(gitStatusMeta("!! .env\n!! node_modules/\n")).toBeUndefined();
        expect(gitStatusMeta("?? new.txt\n!! .env\n")).toEqual({ staged: 0, modified: 0, untracked: 1 });
        // A dirty submodule (--ignore-submodules=none) is a modification.
        expect(gitStatusMeta(" M vendor/sub\n")).toEqual({ staged: 0, modified: 1, untracked: 0 });
        // Only a command that reaches ignored files asks git to list them.
        // Every command sees dirty submodules (a reset can recurse into them);
        // only a command that deletes ignored files asks git to list those.
        expect(gitStatusMetaArgs(false)).toEqual(["status", "--porcelain", "--ignore-submodules=none", "--untracked-files=normal"]);
        expect(gitStatusMetaArgs(true)).toEqual([...gitStatusMetaArgs(false), "--ignored=matching"]);
    });

    it("knows which commands reach ignored files", () => {
        for (const command of ["rm -rf dist", "rm -f .env", "git clean -fdx", "git clean -fX", "ls && rm -r build"]) {
            expectLabeled(reachesIgnoredFiles("bash", command), command).toBe(true);
        }
        for (const command of ["git reset --hard", "git checkout .", "git restore .", "git clean -fd", "git clean -nfx"]) {
            expectLabeled(reachesIgnoredFiles("bash", command), command).toBe(false);
        }
        expect(reachesIgnoredFiles("powershell", "Remove-Item -Recurse -Force dist")).toBe(true);
        expect(reachesIgnoredFiles("powershell", "git reset --hard")).toBe(false);
    });

    it("renders directly above the command it describes", () => {
        const text = renderTranscript([
            { kind: "user", text: "reset it" },
            { kind: "meta", gitStatus: { staged: 0, modified: 1, untracked: 0 } },
            { kind: "tool", tool: "shell", input: { command: "git reset --hard" } },
        ]);
        expect(text.split("\n").slice(2, 4)).toEqual(['{"meta":{"gitStatus":{"staged":0,"modified":1,"untracked":0}}}', '{"Bash":"git reset --hard"}']);
    });
});
