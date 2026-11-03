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
 * The classifier transcript's `{"meta":{"resolvedPaths":…}}` line: an
 * in-project name that a symlink takes outside the working directories is
 * reported with where it lands, built just before the classifier runs;
 * everything else gets no line.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ClassifierModelCall } from "../../features/ai/agent/auto-mode/classifier";
import { defaultEnvironment } from "../../features/ai/agent/auto-mode/classifier-prompt";
import { parseAutoModeConfig } from "../../features/ai/agent/auto-mode/config";
import {
    bashPathCandidates,
    MAX_RESOLVED_PATHS,
    MAX_RESOLVED_WORD,
    powershellPathCandidates,
    RESOLVED_PATHS_NOTE,
    resolvedPathFacts,
    resolveThroughLinks,
    shellResolvedPaths,
} from "../../features/ai/agent/auto-mode/resolved-paths-meta";
import { classifyShellCommand } from "../../features/ai/agent/auto-mode/shell-classify";

const posix = process.platform !== "win32";
const describePosix = posix ? describe : describe.skip;

// The real spelling (macOS tmpdir is under a symlinked /var): the line reports the filesystem's own case.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bi-resolved-paths-")));
const cwd = join(root, "project");
const outside = join(root, "outside");
const scratch = join(root, "scratch");
const secret = join(outside, "secret.txt");
const opts = { cwd, home: root, roots: [cwd, scratch] };

beforeAll(() => {
    for (const dir of [join(cwd, "src"), outside, scratch]) { mkdirSync(dir, { recursive: true }); }
    writeFileSync(secret, "s\n");
    writeFileSync(join(cwd, "src", "a.txt"), "a\n");
    if (!posix) { return; }
    symlinkSync(secret, join(cwd, "notes.txt"));
    symlinkSync(secret, join(cwd, " leading.txt"));
    symlinkSync(outside, join(cwd, "out"));
    symlinkSync(join(cwd, "src"), join(cwd, "inner")); // stays inside
    symlinkSync(scratch, join(cwd, "tmp")); // into another working directory
    symlinkSync(join(cwd, "loop"), join(cwd, "loop")); // a cycle
    symlinkSync(join(outside, "missing.txt"), join(cwd, "dangling.txt"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describePosix("resolvedPathFacts", () => {
    it("reports an in-project name, or a path under an in-project link, that resolves outside", () => {
        expect(resolvedPathFacts(["notes.txt", "out/new.txt"], opts)).toEqual([
            { path: "notes.txt", resolvesTo: secret },
            { path: "out/new.txt", resolvesTo: join(outside, "new.txt") },
        ]);
    });

    it("follows a dangling link to where a write would land", () => {
        expect(resolvedPathFacts(["dangling.txt"], opts)).toEqual([{ path: "dangling.txt", resolvesTo: join(outside, "missing.txt") }]);
    });

    it("reports a path spelled through the alias the working directory was given as", () => {
        const alias = join(root, "alias");
        symlinkSync(cwd, alias);
        expect(resolvedPathFacts([join(alias, "notes.txt"), "notes.txt"], { cwd: alias, home: root, roots: [alias] })).toEqual([
            { path: join(alias, "notes.txt"), resolvesTo: secret },
            { path: "notes.txt", resolvesTo: secret },
        ]);
    });

    it("reports nothing for paths that stay inside, lead into another working directory, or are outside as spelled", () => {
        expect(resolvedPathFacts(["src/a.txt", "inner/a.txt", "tmp/x.txt", "missing.txt", "-v", secret, "../outside/secret.txt", ""], opts)).toBeUndefined();
    });

    it("stops a link cycle instead of recursing without bound", () => {
        expect(() => resolveThroughLinks(join(cwd, "loop"))).not.toThrow();
        expect(resolvedPathFacts(["loop"], opts)).toBeUndefined();
    });

    it("reports at most 16 paths and skips words longer than 1,024 characters", () => {
        const many = Array.from({ length: 40 }, (_v, i) => `out/f${i}.txt`);
        expect(resolvedPathFacts(many, opts)).toHaveLength(MAX_RESOLVED_PATHS);
        expect(resolvedPathFacts([`out/${"x".repeat(MAX_RESOLVED_WORD)}`], opts)).toBeUndefined();
    });
});

describe("the words a command names", () => {
    it("bash: every constant word, input and redirect target, and --opt=value, but no expansion", () => {
        expect(bashPathCandidates("cat ' leading.txt' --file=out/x < in.txt > out/y")).toEqual(
            expect.arrayContaining([" leading.txt", "out/x", "in.txt", "out/y"]),
        );
        expect(bashPathCandidates('cat "$HOME/x"')).not.toContain("$HOME/x");
    });

    it("PowerShell, until it is parsed: the floor's path tokens and every other bare word", () => {
        const words = powershellPathCandidates("Set-Content -Path notes.txt -Value x; Get-Content '.\\out\\y.txt' | Out-Null", "/home/u");
        expect(words).toEqual(expect.arrayContaining(["notes.txt", "./out/y.txt"]));
        expect(words).not.toContain("-Path");
    });
});

describePosix("shellResolvedPaths", () => {
    it("bash: reports a redirect through an in-project link and nothing for an ordinary command", () => {
        expect(shellResolvedPaths("shell", "echo key >> notes.txt", opts)).toEqual([{ path: "notes.txt", resolvesTo: secret }]);
        expect(shellResolvedPaths("shell", "echo hi > ' leading.txt'", opts)).toEqual([{ path: " leading.txt", resolvesTo: secret }]);
        expect(shellResolvedPaths("shell", "cat src/a.txt | grep a", opts)).toBeUndefined();
    });

    it("PowerShell: reports a bare in-project name that links out", () => {
        expect(shellResolvedPaths("powershell", "Add-Content notes.txt 'key'", opts)).toEqual([{ path: "notes.txt", resolvesTo: secret }]);
        expect(shellResolvedPaths("powershell", "Get-Content src/a.txt", opts)).toBeUndefined();
    });
});

describePosix("the line in the classifier's request", () => {
    const config = parseAutoModeConfig(undefined, defaultEnvironment({ kind: "bash" }));
    const run = async (command: string) => {
        const users: string[] = [];
        const call: ClassifierModelCall = async ({ user }) => {
            users.push(user);
            return { text: "<severity>10</severity>", finishReason: "stop" };
        };
        await classifyShellCommand(
            { command, tool: "shell", cwd, home: root, extraRoots: [scratch], generations: [{ userPrompt: "add a note" }], denials: [], username: "tester", config },
            { call },
        );
        const user = users[0];
        return user.slice(user.indexOf("<transcript>"), user.indexOf("</transcript>")).trim().split("\n");
    };

    it("sits directly above the command, with its note", async () => {
        const lines = await run("echo key >> notes.txt");
        expect(lines.slice(-2)).toEqual([
            JSON.stringify({ meta: { resolvedPaths: [{ path: "notes.txt", resolvesTo: secret }], note: RESOLVED_PATHS_NOTE } }),
            '{"Bash":"echo key >> notes.txt"}',
        ]);
    });

    it("is absent when every path stays inside", async () => {
        const lines = await run("echo note >> src/a.txt");
        expect(lines.join("\n")).not.toContain("resolvedPaths");
    });
});
