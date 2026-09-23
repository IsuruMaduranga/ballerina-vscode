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
 * Regression tests for pincer-agent's SECURITY-REVIEW-2026-09-23, ported from
 * its `test/unit/security-review-2026-09-23.test.ts` (tip `2602e3c`): every
 * probe from the review must reach the classifier, and the everyday reads the
 * pre-gate exists to fast-path must stay "safe". Left out until their modules
 * are ported: the safety-floor probes, the PowerShell ones and the gitStatus
 * line's arguments; pincer's LSP trust has no counterpart here.
 */

import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkOptions, READ_ONLY_SPECS } from "../../features/ai/agent/auto-mode/read-only-options";
import { analyzeShellCommand, parseCommand } from "../../features/ai/agent/auto-mode/shell-analysis";
import { configRunsProgram } from "../../features/ai/agent/auto-mode/git-checkout-programs";
import { gitStatusOutput, HARNESS_GIT_CONFIG } from "../../features/ai/agent/auto-mode/git";
import { expectLabeled } from "./labeled";

let root: string;
let cwd: string;
let home: string;
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-sec-"));
    cwd = join(root, "project");
    home = join(root, "home");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, "a.txt"), "a\n");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const verdict = (command: string) => analyzeShellCommand({ command, cwd, home }).verdict;

describe("H1: read-only commands are proved by their options, not their name", () => {
    it("escalates git subcommands carrying options that write, delete or run a program", () => {
        for (const command of [
            "git branch -D main",
            "git branch -m old new",
            "git branch feature",
            "git tag v2",
            "git tag -d v1",
            "git tag -v v1",
            "git diff --output=out.txt",
            "git show --output=o HEAD",
            "git log --output=o",
            "git diff --ext-diff",
            "git grep -O foo",
            "git grep --open-files-in-pager=x foo",
            "git cat-file --textconv HEAD:a",
            "git ls-remote https://example.com/x.git",
            "git log --show-signature",
            "git diff --no-index a b",
            "git blame --contents x a.txt",
        ]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
    });

    it("does not let a required value hide the next option (parser agreement)", () => {
        // `-S` takes the next word as its value whatever it is, so `--output=f`
        // after `--` is still an option to git, and must be to the check too.
        expect(verdict("git diff -S -- --output=f")).toBe("escalate");
        // `--contains` does not swallow a following option.
        expect(verdict("git branch -l --contains -D main")).toBe("escalate");
    });

    it("escalates other read-only commands with options that write or run a program", () => {
        for (const command of [
            "rg --pre=cat foo",
            "rg --hostname-bin=x foo",
            "ack --pager=cat foo",
            "ag foo",
            "tree -o out.txt",
            "uniq a.txt b.txt",
            "sort -uo out.txt a.txt",
            "sort --compress-program=gzip a.txt",
            "file -C -m x",
            "wc --files0-from=list",
            "find . -fprint out",
            "find -fprint out",
            "find . -delete",
            "find . -exec rm {} ;",
            "printf -v PATH ./bin",
            "hostname evil",
            "date 010100002030",
            "date -s 2020-01-01",
        ]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
    });

    it("keeps everyday reads fast-pathed", () => {
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "src", "b.ts"), "");
        for (const command of [
            "ls -la",
            "cat a.txt",
            "head -n 5 a.txt",
            "tail -5 a.txt",
            "wc -l src/*.ts",
            "grep -rn foo .",
            "rg -n --hidden -g '*.ts' foo src",
            "jq .name a.txt",
            "find . -name '*.ts' -type f -maxdepth 2",
            "sort -u a.txt",
            "uniq -c a.txt",
            "diff -u a.txt src/b.ts",
            "date +%s",
            "git status -sb",
            "git log --oneline -5",
            "git log --stat --format='%h %s' -n 3",
            "git diff --stat HEAD~1",
            "git diff -S foo -- src",
            "git show HEAD --name-only",
            "git branch",
            "git branch -a -v",
            "git branch --list 'feat*'",
            "git tag",
            "git tag -l 'v*'",
            "git blame -L 1,5 a.txt",
            "git grep -n foo",
            "git rev-parse --abbrev-ref HEAD",
            "git --no-pager log -1",
            "LANG=C sort a.txt",
        ]) {
            expectLabeled(verdict(command), command).toBe("safe");
        }
    });

    it("parses short clusters and attached values like getopt", () => {
        const grep = READ_ONLY_SPECS.grep;
        const ok = checkOptions(grep, [{ value: "-rnA3" }, { value: "pat" }, { value: "src" }]);
        expect(ok.ok && ok.parsed.positionals.map((w) => w.value)).toEqual(["pat", "src"]);
        const withFile = checkOptions(grep, [{ value: "-f" }, { value: "pats.txt" }, { value: "src" }]);
        expect(withFile.ok && withFile.parsed.fileValues.map((w) => w.value)).toEqual(["pats.txt"]);
        expect(checkOptions(grep, [{ value: "-rX" }]).ok).toBe(false);
    });
});

describe("H2: assignments and git's retargeting options escalate", () => {
    it("escalates a leading assignment that is not locale or display", () => {
        for (const command of ["GIT_DIR=x git status", "GIT_CONFIG_COUNT=1 git status", "RIPGREP_CONFIG_PATH=x rg foo", "FOO=1 cat a.txt"]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
    });

    it("escalates a bare assignment segment that changes what later words run", () => {
        expect(verdict("PATH=./bin; ls")).toBe("escalate");
    });

    it("escalates every retargeting git global option, in-project or not", () => {
        mkdirSync(join(cwd, "sub"));
        for (const command of [
            "git --config-env=core.pager=X log",
            "git --git-dir=sub status",
            "git --work-tree=sub status",
            "git --exec-path=sub status",
            "git --namespace=x log",
            "git -p log",
        ]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
        expect(verdict("git -C sub status")).toBe("safe");
    });
});

describe("H3: unmodelled writes are recorded as writes", () => {
    it("records `>&word` as a write target, and fd duplication as none", () => {
        expect(parseCommand("echo x >&out.txt").segments[0].redirects).toEqual(["out.txt"]);
        expect(parseCommand("echo x >& out.txt").segments[0].redirects).toEqual(["out.txt"]);
        expect(parseCommand("echo x 2>&1").segments[0].redirects).toEqual([]);
        expect(parseCommand("echo x >&-").segments[0].redirects).toEqual([]);
    });

});

describe("M1/M2: operands are judged where bash resolves them", () => {
    posixOnly("escalates a bare name that is a symlink out of the project", () => {
        writeFileSync(join(root, "outside.txt"), "secret");
        symlinkSync(join(root, "outside.txt"), join(cwd, "notes"));
        expect(verdict("cat notes")).toBe("escalate");
        // …and a glob match that is one.
        symlinkSync(join(root, "outside.txt"), join(cwd, "z.log"));
        expect(verdict("cat *.log")).toBe("escalate");
    });

    posixOnly("escalates a bare name that resolves onto a credential path", () => {
        mkdirSync(join(cwd, "keys"));
        writeFileSync(join(cwd, "keys", "id_rsa"), "k");
        symlinkSync(join(cwd, "keys", "id_rsa"), join(cwd, "readme"));
        expect(analyzeShellCommand({ command: "cat readme", cwd, home }).sensitivePaths).toContain("readme");
    });

    it("escalates ~name, ~- and ~+ reads and writes", () => {
        for (const command of ["cat ~root/x", "cat ~-/x", "ls ~+/..", "echo x > ~nobody/Desktop/x", "git -C ~root/repo status"]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
        expect(verdict("cat ~/x")).toBe("escalate"); // outside the project, as before
    });

    it("escalates globs that could reach .. or cannot be enumerated", () => {
        for (const command of ["cat .?/x", "ls .*", "cat src/*/index.ts", "echo x > *.txt"]) {
            expectLabeled(verdict(command), command).toBe("escalate");
        }
        // Quoted glob characters are literal: find sees the pattern, bash expands nothing.
        expect(verdict("find . -name '*.ts'")).toBe("safe");
    });
});

describe("M3: jq's env builtin", () => {
    it("escalates a jq program that reads the environment", () => {
        expect(verdict("jq -n env")).toBe("escalate");
        expect(verdict("jq -n 'env.HOME'")).toBe("escalate");
        expect(verdict("jq .environment a.txt")).toBe("safe");
    });
});

describe("M5: harness git ignores the checkout's fsmonitor", () => {
    posixOnly("does not run core.fsmonitor from the checkout's config", async () => {
        execFileSync("git", ["init", "-q"], { cwd });
        const marker = join(root, "fsmonitor-ran");
        const hook = join(root, "hook.sh");
        writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
        execFileSync("git", ["config", "core.fsmonitor", hook], { cwd });
        expect(HARNESS_GIT_CONFIG).toEqual(["-c", "core.fsmonitor=false", "--no-optional-locks"]);
        await gitStatusOutput(cwd, ["status", "--porcelain"]);
        expect(existsSync(marker)).toBe(false);
    });

    posixOnly("does not run the checkout's post-index-change hook", async () => {
        execFileSync("git", ["init", "-q"], { cwd });
        execFileSync("git", ["add", "a.txt"], { cwd });
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
        const marker = join(root, "hook-ran");
        writeFileSync(join(cwd, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
        // A touched file makes status refresh the index, which would write it.
        writeFileSync(join(cwd, "a.txt"), "a\n");
        await gitStatusOutput(cwd, ["status", "--porcelain"]);
        expect(existsSync(marker)).toBe(false);
    });
});

describe("M5: every harness git call carries HARNESS_GIT_CONFIG", () => {
    it("finds no git spawn in the agent's modules without the hardening", () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (path.endsWith(".ts")) files.push(path);
            }
        };
        const agentDir = join(__dirname, "..", "..", "features", "ai", "agent");
        walk(agentDir);
        // A spawn of the git binary whose argument list does not start with the
        // harness config.
        const spawn = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|run|probe)\(\s*"git",(?!\s*\[\s*\.\.\.HARNESS_GIT_CONFIG\b)/;
        const offenders = files.flatMap((file) =>
            readFileSync(file, "utf-8")
                .split("\n")
                .map((line, index) => ({ line, index }))
                .filter(({ line }) => spawn.test(line))
                .map(({ index }) => `${file.slice(agentDir.length + 1)}:${index + 1}`),
        );
        expect(files.length).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });
});

describe("PR #8 review follow-ups", () => {
    it("escalates a glob with a bracket range JavaScript cannot compile, instead of throwing", () => {
        expect(verdict("cat [z-a]")).toBe("escalate");
        expect(verdict("ls .claude/[b-a]*")).toBe("escalate");
    });

});

describe("PR #8 review: a checkout's git config can make a git read run a program", () => {
    it("finds the program-valued keys a read runs, and nothing else", () => {
        for (const [text, key] of [
            ["[core]\n\tfsmonitor = ./hook.sh\n", "core.fsmonitor"],
            ["[core] fsmonitor = ./hook.sh\n", "core.fsmonitor"],
            ['[diff "bin"]\n\ttextconv = ./conv\n', "diff.textconv"],
            ["[diff]\n\texternal = ./ext\n", "diff.external"],
            ['[filter "x"]\n\tclean = ./clean\n', "filter.clean"],
            ["[pager]\n\tlog = ./page\n", "pager.log"],
            ["[gpg]\n\tprogram = ./sign\n", "gpg.program"],
            ["[core]\n\tpager = ./page\n", "core.pager"],
            ["[include]\n\tpath = ../x.cfg\n", "include.path"],
        ] as const) {
            expectLabeled(configRunsProgram(text).program, text).toBe(key);
        }
        for (const text of [
            "[core]\n\tfsmonitor = true\n\tbare = false\n",
            '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
            "[pager]\n\tstatus = false\n",
            '[remote "origin"]\n\turl = https://example.com/x.git\n# [diff] external = ./x\n',
        ]) {
            expectLabeled(configRunsProgram(text).program, text).toBeUndefined();
        }
        expect(configRunsProgram("[core]\n\thooksPath = .husky/_\n")).toEqual({ hooksPaths: [".husky/_"] });
    });

    posixOnly("escalates a git read in a checkout whose config or hooks run a program", () => {
        execFileSync("git", ["init", "-q"], { cwd });
        expect(verdict("git status")).toBe("safe");
        expect(verdict("git log --oneline")).toBe("safe");

        execFileSync("git", ["config", "core.fsmonitor", "./hook.sh"], { cwd });
        expect(verdict("git status")).toBe("escalate");
        expect(verdict("git diff")).toBe("escalate");
        execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd });

        execFileSync("git", ["config", "filter.x.clean", "./clean.sh"], { cwd });
        expect(verdict("git status")).toBe("escalate");
        execFileSync("git", ["config", "--remove-section", "filter.x"], { cwd });
        expect(verdict("git status")).toBe("safe");

        // husky's hooks path is fine until it holds the hook status runs.
        execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd });
        mkdirSync(join(cwd, ".husky", "_"), { recursive: true });
        writeFileSync(join(cwd, ".husky", "_", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
        expect(verdict("git status")).toBe("safe");
        writeFileSync(join(cwd, ".husky", "_", "post-index-change"), "#!/bin/sh\n", { mode: 0o755 });
        expect(verdict("git status")).toBe("escalate");
    });

    posixOnly("judges the checkout git runs in: after cd and -C, and a nested repository's own", () => {
        execFileSync("git", ["init", "-q"], { cwd });
        const nested = join(cwd, "vendor", "lib");
        mkdirSync(nested, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: nested });
        writeFileSync(join(nested, ".git", "hooks", "post-index-change"), "#!/bin/sh\n", { mode: 0o755 });
        expect(verdict("git status")).toBe("safe");
        expect(verdict("git -C vendor/lib status")).toBe("escalate");
        expect(verdict("git -C vendor -C lib status")).toBe("escalate");
        expect(verdict("cd vendor/lib && git status")).toBe("escalate");
    });

    posixOnly("reads every submodule's config: nested, and wherever a .gitmodules path's .git points", () => {
        execFileSync("git", ["init", "-q"], { cwd });
        const nested = join(cwd, ".git", "modules", "libs", "a", "modules", "b");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(nested, "config"), "[core]\n\tbare = false\n");
        expect(verdict("git status")).toBe("safe");
        writeFileSync(join(nested, "config"), "[core]\n\tfsmonitor = ./hook\n");
        expect(verdict("git status")).toBe("escalate");
        rmSync(join(cwd, ".git", "modules"), { recursive: true });

        // A submodule whose .git file points outside .git/modules.
        const elsewhere = join(root, "elsewhere.git");
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, "config"), '[filter "x"]\n\tclean = ./clean\n');
        mkdirSync(join(cwd, "sub"));
        writeFileSync(join(cwd, "sub", ".git"), `gitdir: ${elsewhere}\n`);
        writeFileSync(join(cwd, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/sub.git\n');
        expect(verdict("git status")).toBe("escalate");
    });

    posixOnly("treats a config it cannot read as naming a program", () => {
        if (process.getuid?.() === 0) return; // root reads a mode-000 file
        execFileSync("git", ["init", "-q"], { cwd });
        const config = join(cwd, ".git", "config");
        chmodSync(config, 0o000);
        try {
            expect(verdict("git status")).toBe("escalate");
        } finally {
            chmodSync(config, 0o644);
        }
    });

    posixOnly("reads a ] first in a negated bracket set as a member", () => {
        writeFileSync(join(root, "outside.txt"), "secret");
        symlinkSync(join(root, "outside.txt"), join(cwd, "z"));
        // bash expands `[!]abc]` to `z`, a symlink out of the project.
        expect(verdict("cat [!]abc]")).toBe("escalate");
    });
});
