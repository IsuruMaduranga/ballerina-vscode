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
 * The BI side of the bash pre-gate: the probe list, the two BI
 * additions to pincer's `shell-analysis.ts` (git path operands, the scratchpad
 * write root), readable roots, and BI's own credential files.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeShellCommand, type AnalyzeInput } from "../../features/ai/agent/auto-mode/shell-analysis";
import { forwardSlashes as sh } from "../../features/ai/agent/auto-mode/shared-paths";
import { expectLabeled } from "./labeled";

let root: string;
let cwd: string;
let home: string;
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-gate-")));
    cwd = join(root, "project");
    home = join(root, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, "a.txt"), "a\n");
    writeFileSync(join(cwd, "src", "b.bal"), "b\n");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const analyze = (command: string, extra: Partial<AnalyzeInput> = {}) => analyzeShellCommand({ command, cwd, home, ...extra });
const verdict = (command: string, extra: Partial<AnalyzeInput> = {}) => analyze(command, extra).verdict;
const gitInit = () => execFileSync("git", ["init", "-q"], { cwd });

describe("design §6: every probe against pincer 5059966 now escalates", () => {
    // Each of these returned "safe" before pincer's c1e65da; the last two run a
    // program.
    const probes = [
        "git branch -D x",
        "git branch -m a b",
        "git tag -d v1",
        "git tag v2",
        "git log --output=out.txt",
        "git diff --output=/etc/x",
        "git diff --no-index /etc/hosts a.txt",
        "git ls-remote --upload-pack=touch .",
        "git grep -Otouch foo",
        "git grep --open-files-in-pager=touch foo",
    ];

    it("outside a repository", () => {
        for (const command of probes) { expectLabeled(verdict(command), command).toBe("escalate"); }
    });

    posixOnly("inside a repository", () => {
        gitInit();
        for (const command of probes) { expectLabeled(verdict(command), command).toBe("escalate"); }
    });
});

describe("BI addition: git path operands get the outside-read check", () => {
    const outside = ["git diff /etc/hosts a.txt", "git diff -- /etc/hosts a.txt", "git log -p -- ../x", "git grep -e foo /etc", "git show HEAD -- /etc/hosts", "git blame /etc/hosts"];
    const inside = [
        "git diff",
        "git diff HEAD~1 -- src",
        "git diff a.txt src/b.bal",
        "git log --oneline origin/main..HEAD",
        "git show HEAD:src/b.bal",
        "git grep -n foo -- src",
        // grep's first operand is its pattern, even when it looks like a path.
        "git grep -n /etc/hosts",
        "git ls-files src",
        "git status",
    ];

    it("outside a repository, where git diff reads both paths", () => {
        for (const command of outside) {
            const evidence = analyze(command);
            expectLabeled(evidence.verdict, command).toBe("escalate");
            expectLabeled(evidence.readOnlyOutside, command).toBe(true);
        }
        for (const command of inside) { expectLabeled(verdict(command), command).toBe("safe"); }
    });

    posixOnly("inside a repository", () => {
        gitInit();
        for (const command of outside) { expectLabeled(verdict(command), command).toBe("escalate"); }
        for (const command of inside) { expectLabeled(verdict(command), command).toBe("safe"); }
    });

    it("clears an operand inside a readable root", () => {
        const cache = join(home, ".ballerina", "repositories");
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "x.bal"), "");
        const command = `git diff --stat a.txt ${sh(cache)}/x.bal`;
        expect(verdict(command)).toBe("escalate");
        expect(verdict(command, { readableRoots: [cache] })).toBe("safe");
    });
});

describe("readable roots widen reads only", () => {
    let cache: string;
    beforeEach(() => {
        cache = join(home, ".ballerina", "repositories", "central.ballerina.io", "bala", "ballerina", "http");
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "client.bal"), "");
        writeFileSync(join(home, ".ballerina", "Settings.toml"), "[central]\naccesstoken=\"x\"\n");
    });
    const roots = () => [join(home, ".ballerina", "repositories")];

    it("clears a read inside a root and nothing beside it", () => {
        for (const command of [`grep -rn Client ${sh(cache)}`, `cat ${sh(cache)}/client.bal`, `ls ~/.ballerina/repositories`]) {
            expectLabeled(verdict(command), command).toBe("escalate");
            expectLabeled(verdict(command, { readableRoots: roots() }), command).toBe("safe");
        }
        // The Central token sits beside the cache, not under it.
        const token = analyze("cat ~/.ballerina/Settings.toml", { readableRoots: roots() });
        expect(token.verdict).toBe("escalate");
        expect(token.sensitivePaths).toEqual(["~/.ballerina/Settings.toml"]);
    });

    it("never clears a write or a delete inside a root", () => {
        for (const command of [`echo x > ${sh(cache)}/client.bal`, `rm ${sh(cache)}/client.bal`, `sort -o ${sh(cache)}/out a.txt`]) {
            expectLabeled(verdict(command, { readableRoots: roots() }), command).toBe("escalate");
        }
    });
});

describe("BI addition: the scratchpad is a write root", () => {
    let scratchpad: string;
    beforeEach(() => {
        scratchpad = join(root, "tmp", "wso2-integrator-copilot-501", "project", "default", "scratchpad");
        mkdirSync(scratchpad, { recursive: true });
    });

    it("clears a redirect into the scratchpad and nothing outside it", () => {
        const command = `git diff > ${sh(scratchpad)}/changes.diff`;
        expect(verdict(command)).toBe("escalate");
        expect(verdict(command, { writableRoots: [scratchpad] })).toBe("safe");
        expect(verdict(`echo x > ${sh(scratchpad)}/../escape.txt`, { writableRoots: [scratchpad] })).toBe("escalate");
        expect(verdict(`echo x > ${sh(root)}/tmp/other.txt`, { writableRoots: [scratchpad] })).toBe("escalate");
    });

    it("still refuses a credential or protected name inside it", () => {
        for (const command of [`echo x > ${sh(scratchpad)}/.env`, `echo x > ${sh(scratchpad)}/.git/hooks/pre-commit`]) {
            expectLabeled(verdict(command, { writableRoots: [scratchpad] }), command).toBe("escalate");
        }
    });

    it("does not make the scratchpad readable by itself", () => {
        writeFileSync(join(scratchpad, "notes.txt"), "");
        expect(verdict(`cat ${sh(scratchpad)}/notes.txt`, { writableRoots: [scratchpad] })).toBe("escalate");
        expect(verdict(`cat ${sh(scratchpad)}/notes.txt`, { readableRoots: [scratchpad] })).toBe("safe");
    });
});

describe("BI's credential files", () => {
    it("escalates a shell read of Config.toml, which holds the LLM-proxy token", () => {
        writeFileSync(join(cwd, "Config.toml"), "accessToken=\"x\"\n");
        for (const command of ["cat Config.toml", "grep -n token Config.toml", "head -1 ./Config.toml"]) {
            const evidence = analyze(command);
            expectLabeled(evidence.verdict, command).toBe("escalate");
            expectLabeled(evidence.sensitivePaths.length, command).toBeGreaterThan(0);
        }
        expect(verdict("cat Ballerina.toml")).toBe("safe");
    });
});
