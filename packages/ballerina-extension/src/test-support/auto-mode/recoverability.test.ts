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

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    checkRecoverability,
    combine,
    judgeTargets,
    judgeWholeTree,
    type RecoverabilityResult,
    type TargetState,
} from "../../features/ai/agent/auto-mode/recoverability";

describe("judgeTargets (pure)", () => {
    const t = (over: Partial<TargetState>): TargetState => ({ token: "f", tracked: true, dirty: false, ...over });

    it("clears when every target is tracked and clean", () => {
        expect(judgeTargets([t({}), t({ token: "g" })]).verdict).toBe("recoverable");
    });

    it("refuses an untracked target — git cannot restore it", () => {
        expect(judgeTargets([t({}), t({ token: "new.txt", tracked: false })]).verdict).toBe("unrecoverable");
    });

    it("refuses a tracked-but-dirty target — the uncommitted change would be lost", () => {
        expect(judgeTargets([t({ token: "edited.txt", dirty: true })]).verdict).toBe("unrecoverable");
    });

    it("is unknown when no target could be identified", () => {
        expect(judgeTargets([]).verdict).toBe("unknown");
    });

    it("names the offending target, not file contents", () => {
        expect(judgeTargets([t({ token: "secret.txt", tracked: false })]).reason).toContain("secret.txt");
    });
});

describe("judgeWholeTree (pure)", () => {
    it("clears a clean tree", () => {
        expect(judgeWholeTree(true, "").verdict).toBe("recoverable");
        expect(judgeWholeTree(true, "  \n ").verdict).toBe("recoverable");
    });

    it("refuses a dirty tree", () => {
        expect(judgeWholeTree(true, " M tracked.txt\n").verdict).toBe("unrecoverable");
        expect(judgeWholeTree(true, "?? untracked.txt\n").verdict).toBe("unrecoverable");
    });

    it("refuses when it is not a git repo", () => {
        expect(judgeWholeTree(false, "").verdict).toBe("unrecoverable");
    });
});

describe("combine", () => {
    const r = (verdict: RecoverabilityResult["verdict"]): RecoverabilityResult => ({ verdict, reason: verdict });
    it("takes unrecoverable over everything", () => {
        expect(combine([r("recoverable"), r("unrecoverable"), r("unknown")]).verdict).toBe("unrecoverable");
    });
    it("takes unknown over recoverable", () => {
        expect(combine([r("recoverable"), r("unknown")]).verdict).toBe("unknown");
    });
    it("clears only when all parts are recoverable", () => {
        expect(combine([r("recoverable"), r("recoverable")]).verdict).toBe("recoverable");
    });
});

describe("checkRecoverability (real git)", () => {
    let repo: string;
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), "cc-recover-"));
        g("init", "-q");
        g("config", "user.email", "a@b.c");
        g("config", "user.name", "a");
        writeFileSync(join(repo, "committed.txt"), "v1\n");
        g("add", "committed.txt");
        g("commit", "-qm", "init");
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("clears deleting a tracked, clean file", () => {
        expect(checkRecoverability(repo, { targets: [join(repo, "committed.txt")], wholeTree: false }).verdict).toBe(
            "recoverable",
        );
    });

    it("refuses deleting an untracked file", () => {
        writeFileSync(join(repo, "untracked.txt"), "x\n");
        expect(checkRecoverability(repo, { targets: [join(repo, "untracked.txt")], wholeTree: false }).verdict).toBe(
            "unrecoverable",
        );
    });

    it("refuses deleting a tracked file with uncommitted edits", () => {
        writeFileSync(join(repo, "committed.txt"), "v2 uncommitted\n");
        expect(checkRecoverability(repo, { targets: [join(repo, "committed.txt")], wholeTree: false }).verdict).toBe(
            "unrecoverable",
        );
    });

    it("clears a whole-tree reset on a clean tree", () => {
        expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("recoverable");
    });

    it("refuses a whole-tree reset on a dirty tree", () => {
        writeFileSync(join(repo, "committed.txt"), "dirty\n");
        expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
    });

    it("refuses a whole-tree reset when untracked files are present", () => {
        writeFileSync(join(repo, "untracked.txt"), "x\n");
        expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
    });

    it("refuses deleting a tracked-but-dirty BROKEN symlink (lstat, not existsSync)", () => {
        // existsSync follows the link to its dead target and reports false; using it
        // would wrongly clear this as "nothing to lose" even though the uncommitted
        // symlink change is real, unrecoverable content.
        writeFileSync(join(repo, "target.txt"), "t\n");
        symlinkSync("target.txt", join(repo, "link"));
        g("add", "-A");
        g("commit", "-qm", "add link");
        // Repoint the (tracked) symlink at a missing target: now dirty AND broken.
        unlinkSync(join(repo, "link"));
        symlinkSync("does-not-exist", join(repo, "link"));
        expect(checkRecoverability(repo, { targets: [join(repo, "link")], wholeTree: false }).verdict).toBe(
            "unrecoverable",
        );
    });

    it("refuses deleting the repository root itself (rm -rf . passes the tracked test but removes .git)", () => {
        const result = checkRecoverability(repo, { targets: [repo], wholeTree: false });
        expect(result.verdict).toBe("unrecoverable");
        expect(result.reason).toMatch(/\.git/);
    });

    it("refuses deleting .git or anything inside it", () => {
        expect(checkRecoverability(repo, { targets: [join(repo, ".git")], wholeTree: false }).verdict).toBe("unrecoverable");
        expect(checkRecoverability(repo, { targets: [join(repo, ".git", "HEAD")], wholeTree: false }).verdict).toBe(
            "unrecoverable",
        );
    });

    it("refuses deleting a directory that holds a nested repository", () => {
        mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
        writeFileSync(join(repo, "vendor", "lib", "a.txt"), "x\n");
        g("add", "vendor");
        g("commit", "-qm", "vendor");
        execFileSync("git", ["init", "-q"], { cwd: join(repo, "vendor", "lib"), stdio: "ignore" });
        expect(checkRecoverability(repo, { targets: [join(repo, "vendor")], wholeTree: false }).verdict).toBe("unrecoverable");
    });

    it("clears deleting a directory whose content is all tracked and clean", () => {
        mkdirSync(join(repo, "sub"));
        writeFileSync(join(repo, "sub", "a.txt"), "x\n");
        g("add", "sub");
        g("commit", "-qm", "sub");
        expect(checkRecoverability(repo, { targets: [join(repo, "sub")], wholeTree: false }).verdict).toBe("recoverable");
    });

    it("refuses deleting a directory holding an untracked file", () => {
        mkdirSync(join(repo, "sub"));
        writeFileSync(join(repo, "sub", "a.txt"), "x\n");
        g("add", "sub");
        g("commit", "-qm", "sub");
        writeFileSync(join(repo, "sub", "scratch.txt"), "new\n");
        const result = checkRecoverability(repo, { targets: [join(repo, "sub")], wholeTree: false });
        expect(result.verdict).toBe("unrecoverable");
        expect(result.reason).toMatch(/directory holding/);
    });

    it("refuses deleting a directory holding IGNORED files (porcelain omits them by default)", () => {
        mkdirSync(join(repo, "sub"));
        writeFileSync(join(repo, "sub", "a.txt"), "x\n");
        writeFileSync(join(repo, ".gitignore"), "*.env\n");
        g("add", "sub", ".gitignore");
        g("commit", "-qm", "sub");
        writeFileSync(join(repo, "sub", "secrets.env"), "KEY=1\n");
        expect(checkRecoverability(repo, { targets: [join(repo, "sub")], wholeTree: false }).verdict).toBe("unrecoverable");
    });

    it("treats a non-git directory as unrecoverable", () => {
        const plain = mkdtempSync(join(tmpdir(), "cc-plain-"));
        mkdirSync(join(plain, "sub"), { recursive: true });
        writeFileSync(join(plain, "f.txt"), "x\n");
        try {
            expect(checkRecoverability(plain, { targets: [join(plain, "f.txt")], wholeTree: false }).verdict).toBe(
                "unrecoverable",
            );
            expect(checkRecoverability(plain, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
        } finally {
            rmSync(plain, { recursive: true, force: true });
        }
    });
});
