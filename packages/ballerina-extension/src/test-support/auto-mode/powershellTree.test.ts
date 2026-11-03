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
 * The PowerShell pre-gate's tree verdicts (`powershell-tree.ts`) against
 * PowerShell's own parse: Claude Code's acceptEdits cmdlets as the
 * contained-edit fast path, the mode it is offered in through the gate, the
 * read-only verdict's binding and script-block checks, and `git` judged by
 * the bash git check. A line recorded in `powershell-parses.json` runs on
 * every machine; the rest need a real PowerShell (`powershellParse.ts`).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, isAbsolute, join } from "path";
import { decideShellCommand, authorizeShellCommand, type ShellGateInput } from "../../features/ai/agent/auto-mode/gate";
import { PauseTracker } from "../../features/ai/agent/auto-mode/pause";
import { resolveForContainment } from "../../features/ai/agent/auto-mode/paths";
import type { PowerShellParse } from "../../features/ai/agent/auto-mode/powershell-parser";
import { applicationArgument } from "../../features/ai/agent/auto-mode/powershell-cmdlets";
import { powershellTreeContainedEdits, powershellTreeReadOnly } from "../../features/ai/agent/auto-mode/powershell-tree";
import { expectLabeled } from "./labeled";
import { describeWithPowerShell, itParses, psParse, POWERSHELL_TEST_TIMEOUT } from "./powershellParse";

jest.setTimeout(POWERSHELL_TEST_TIMEOUT);

const root = resolveForContainment(mkdtempSync(join(tmpdir(), "ps-tree-"))) as string;
const cwd = join(root, "project");
const outside = join(root, "outside");
const home = join(root, "home");
for (const dir of [join(cwd, "src"), join(cwd, ".git"), join(cwd, "vendor", "lib", ".git"), join(cwd, ".claude"), join(cwd, ".github", "workflows"), outside, home]) {
    mkdirSync(dir, { recursive: true });
}
writeFileSync(join(cwd, "src", "a.txt"), "a\n");
writeFileSync(join(cwd, "notes.txt"), "n\n");
writeFileSync(join(cwd, "main.bal"), "");
writeFileSync(join(cwd, ".claude", "settings.json"), "{}\n"); // removing .claude takes a protected file with it
writeFileSync(join(outside, "secret.txt"), "s\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = { cwd, home };
const edits = async (command: string) => powershellTreeContainedEdits(await psParse(command), opts);
const reads = async (command: string) => powershellTreeReadOnly(await psParse(command), opts);

describe("contained edits: Claude Code's acceptEdits cmdlets on the working space", () => {
    const cleared = [
        "Set-Content -Path src/b.txt -Value hello",
        "Set-Content src/b.txt 'two words'",
        "Add-Content notes.txt more",
        "Remove-Item src/a.txt",
        "Remove-Item -Recurse -Force src",
        "Clear-Content notes.txt",
        "Set-Content src/b.txt x; Remove-Item notes.txt",
        "Set-Content src/b.txt x | Out-Null",
        "Remove-Item -LiteralPath src/a.txt -ErrorAction SilentlyContinue",
    ];
    itParses(cleared)("clears Set-Content, Add-Content, Remove-Item and Clear-Content inside the working directory", async () => {
        for (const command of cleared) {
            expectLabeled(await edits(command), command).toEqual({ ok: true });
        }
    });

    const others = ["New-Item src/c.txt", "Copy-Item src/a.txt src/b.txt", "Move-Item src/a.txt src/b.txt", "Rename-Item src/a.txt b.txt", "Out-File src/b.txt", "Get-Content src/a.txt"];
    itParses(others)("refuses every other cmdlet, however contained: New-Item, Copy-Item, Move-Item stay with the classifier", async () => {
        for (const command of others) {
            expectLabeled((await edits(command)).ok, command).toBe(false);
        }
    });

    const byShape = ["Set-Content link/x.txt y", "Remove-Item link/secret.txt", "Set-Content ../x.txt y", "Set-Content ~/x.txt y", "Set-Content Env:\\PATH y", "Remove-Item \\\\server\\share\\x", "Set-Content FileSystem::/tmp/x y"];
    (process.platform === "win32" ? it.skip : itParses(byShape))("refuses a write outside the working space, through a link, or by shape", async () => {
        symlinkSync(outside, join(cwd, "link"));
        for (const command of byShape) {
            expectLabeled((await edits(command)).ok, command).toBe(false);
        }
        rmSync(join(cwd, "link"));
    });

    describeWithPowerShell("an absolute path outside", () => {
        it("refuses it", async () => {
            expect((await edits(`Set-Content '${join(outside, "x.txt")}' y`)).ok).toBe(false);
        });
    });

    const recursive = ["Remove-Item -Recurse build", "Get-ChildItem -Recurse build", "Get-ChildItem -Depth 2 build", "Get-ChildItem build"];
    (process.platform === "win32" ? it.skip : itParses(recursive))("refuses a recursive removal or listing over a tree with a link in it (Windows PowerShell 5.1 follows it)", async () => {
        mkdirSync(join(cwd, "build", "deep"), { recursive: true });
        expect(await edits("Remove-Item -Recurse build")).toEqual({ ok: true });
        expect(await reads("Get-ChildItem -Recurse build")).toEqual({ ok: true });
        symlinkSync(outside, join(cwd, "build", "deep", "out"));
        expect(await edits("Remove-Item -Recurse build")).toMatchObject({ ok: false, reason: expect.stringMatching(/link/) });
        expect(await reads("Get-ChildItem -Recurse build")).toMatchObject({ ok: false, reason: expect.stringMatching(/link/) });
        expect(await reads("Get-ChildItem -Depth 2 build")).toMatchObject({ ok: false });
        expect(await reads("Get-ChildItem build")).toEqual({ ok: true }); // one level: each entry is judged where it resolves elsewhere
        rmSync(join(cwd, "build"), { recursive: true, force: true });
    });

    itParses(["Remove-Item src/*.txt", "Remove-Item -Path src/[ab].txt"])("refuses a wildcard target, which it does not enumerate", async () => {
        expect(await edits("Remove-Item src/*.txt")).toMatchObject({ ok: false, reason: expect.stringMatching(/wildcard/) });
        expect((await edits("Remove-Item -Path src/[ab].txt")).ok).toBe(false);
    });

    const losses = ["Remove-Item -Recurse .", "Remove-Item -Recurse .git", "Remove-Item -Recurse vendor", "Remove-Item -Recurse .claude", "Remove-Item .github/workflows"];
    itParses(losses)("refuses removing a working root, a .git, a directory holding one, or a guarded path", async () => {
        for (const command of losses) {
            expectLabeled(await edits(command), command).toMatchObject({ ok: false });
        }
    });

    const guarded = ["Set-Content .env TOKEN=x", "Set-Content .github/workflows/ci.yml x", "Set-Content .claude/settings.json '{}'", "Set-Content .git/config x", "Set-Content Config.toml x", "Add-Content .vscode/settings.json x"];
    itParses(guarded)("refuses a credential, execution-primitive or protected target, Config.toml included", async () => {
        for (const command of guarded) {
            expectLabeled(await edits(command), command).toMatchObject({ ok: false });
        }
    });

    const dynamic = [
        "Set-Content src/b.txt $env:SECRET",
        "Set-Content src/b.txt (Get-Content ../outside/secret.txt)",
        "Set-Content src/b.txt \"$(whoami)\"",
        "Remove-Item $path",
        "Set-Content src/b.txt x > ../y.txt",
        "Get-ChildItem | Remove-Item",
        "Remove-Item src/a.txt | Remove-Item notes.txt",
        "Remove-Item",
        "Remove-Item -Credential x src/a.txt",
    ];
    itParses(dynamic)("refuses values computed at run time, redirections, script blocks and piped input", async () => {
        for (const command of dynamic) {
            expectLabeled((await edits(command)).ok, command).toBe(false);
        }
    });
});

describe("contained edits through the gate: auto mode with a capable model only", () => {
    const input = (command: string, parse: PowerShellParse | undefined, extra: Partial<ShellGateInput> = {}): ShellGateInput => ({
        command, cwd, home, readableRoots: [], writableRoots: [], sessionRules: [], shell: "powershell", powershellParse: parse, ...extra,
    });
    const subject = "Remove-Item src/a.txt";

    itParses([subject])("clears a contained edit only where guarded file operations are allowed, and never without a parse", async () => {
        const parse = await psParse(subject);
        expect(decideShellCommand(input(subject, parse, { allowContainedFileOperations: true }))).toMatchObject({ outcome: "allow", layer: "file-operation" });
        expect(decideShellCommand(input(subject, parse)).outcome).toBe("ask");
        expect(decideShellCommand(input(subject, undefined, { allowContainedFileOperations: true })).outcome).toBe("ask");
    });

    itParses([subject])("clears it in auto mode and asks in ask mode", async () => {
        const parse = await psParse(subject);
        const classified: string[] = [];
        const callbacks = {
            ask: async () => "deny" as const,
            grantRule: () => undefined,
            parsePowerShell: async () => parse,
            auto: { pause: new PauseTracker(), classify: async (c: string) => { classified.push(c); return { decision: "block" as const, reason: "x", tier: "soft_deny" as const }; } },
        };
        expect(await authorizeShellCommand(input(subject, undefined, { allowContainedFileOperations: true }), "auto", callbacks)).toMatchObject({ allowed: true, by: "file-operation", mayWrite: true });
        expect(classified).toHaveLength(0);
        expect(await authorizeShellCommand(input(subject, undefined, { allowContainedFileOperations: true }), "ask", callbacks)).toMatchObject({ allowed: false, by: "user" });
    });

    describeWithPowerShell("a scratchpad edit", () => {
        it("is contained when the scratchpad is a writable root", async () => {
            const extra = join(root, "extra");
            mkdirSync(extra, { recursive: true });
            const command = `Set-Content '${join(extra, "x.txt")}' y`;
            const parse = await psParse(command);
            expect(decideShellCommand(input(command, parse, { allowContainedFileOperations: true, writableRoots: [extra] }))).toMatchObject({ outcome: "allow", layer: "file-operation" });
            expect(decideShellCommand(input(command, parse, { allowContainedFileOperations: true })).outcome).toBe("ask");
        });
    });
});

describe("the read-only verdict reads PowerShell's binding", () => {
    const spellings = [
        "Get-Content -pa src/a.txt",
        "Get-Content -LP src/a.txt",
        "Get-Content -First 3 src/a.txt",
        "Select-String TODO src/a.txt",
        "Get-ChildItem -fi x",
        "Get-Content src/a.txt extra",
        "Get-Content -Path a -Path b",
    ];
    itParses(spellings)("judges the parameter PowerShell binds, however it is spelled", async () => {
        expect((await reads("Get-Content -pa src/a.txt")).ok).toBe(true); // -Path abbreviated
        expect((await reads("Get-Content -LP src/a.txt")).ok).toBe(true); // -LiteralPath's alias
        expect((await reads("Get-Content -First 3 src/a.txt")).ok).toBe(true); // -TotalCount's alias
        expect((await reads("Select-String TODO src/a.txt")).ok).toBe(true); // positionals: Pattern, then Path
        expect((await reads("Get-ChildItem -fi x")).ok).toBe(false); // ambiguous: -Filter or -File
        expect((await reads("Get-Content src/a.txt extra")).ok).toBe(false); // a surplus positional
        expect((await reads("Get-Content -Path a -Path b")).ok).toBe(false); // bound twice
    });

    describeWithPowerShell("a positional path outside", () => {
        it("is judged as the path it binds", async () => {
            expect((await reads(`Select-String TODO '${join(outside, "secret.txt")}'`)).ok).toBe(false);
        });
    });

    const unlisted = ["Get-Content -Wait src/a.txt", "Get-ChildItem -FollowSymlink", "Get-Content src/a.txt -ErrorVariable e", "Get-ChildItem -Credential x"];
    itParses(unlisted)("refuses a parameter outside the cmdlet's table", async () => {
        for (const command of unlisted) {
            expectLabeled((await reads(command)).ok, command).toBe(false);
        }
    });

    const switches = ["Get-ChildItem -Recurse:$false src", "Get-ChildItem -Rec:$false src", "Get-ChildItem -Recurse:$true src", "Get-ChildItem -Recurse:$x src", "Remove-Item src/a.txt -Confirm:$false"];
    itParses(switches)("allows a switch set to $true or $false, and nothing else", async () => {
        expect((await reads("Get-ChildItem -Recurse:$false src")).ok).toBe(true);
        expect((await reads("Get-ChildItem -Rec:$false src")).ok).toBe(true);
        expect((await reads("Get-ChildItem -Recurse:$true src")).ok).toBe(true);
        expect((await reads("Get-ChildItem -Recurse:$x src")).ok).toBe(false);
        expect(await edits("Remove-Item src/a.txt -Confirm:$false")).toEqual({ ok: true });
    });

    itParses(["Get-ChildItem -FollowSymlink:$false src", "Get-Content -Wait:$false src/a.txt"])("still names-checks a switch the binder drops for being $false", async () => {
        // PowerShell's binder leaves `-X:$false` out of its bindings, so the
        // spelling itself must be one of the cmdlet's switches.
        expect(await reads("Get-ChildItem -FollowSymlink:$false src")).toMatchObject({ ok: false, reason: expect.stringMatching(/FollowSymlink/) });
        expect((await reads("Get-Content -Wait:$false src/a.txt")).ok).toBe(false);
    });

    (process.platform === "win32" ? it : it.skip)("clears findstr and where.exe with their switches when they are Windows' own", async () => {
        expect(await reads("findstr /i /n TODO src\\a.txt")).toEqual({ ok: true });
        expect(await reads("where.exe /q git")).toEqual({ ok: true });
        expect((await reads("findstr /s TODO *.txt")).ok).toBe(false);
    });

    const blocksOk = [
        "Get-ChildItem | Where-Object { $_.Length -gt 1kb -and $_.Name -like '*.ts' }",
        "Get-ChildItem | Sort-Object { $_.Name.Length }",
        "Get-ChildItem | ForEach-Object { $_.FullName }",
        "Get-ChildItem | Where-Object { -not $_.PSIsContainer }",
    ];
    const blocksRefused = [
        "Get-ChildItem | Where-Object { $_ | Remove-Item }",
        "Get-ChildItem | ForEach-Object { [IO.File]::Delete($_) }",
        "Get-ChildItem | ForEach-Object { $_.FullName > out.txt }",
        "Get-ChildItem | ForEach-Object { $_.$name }",
        "Get-ChildItem | Where-Object { 1..100000000 }",
        "Get-ChildItem | ForEach-Object -Begin { Remove-Item x } -Process { $_ }",
        "Get-ChildItem | Select-Object @{ n = 'x'; e = { Remove-Item y } }",
    ];
    itParses([...blocksOk, ...blocksRefused])("allows only an expression over $_ in a script block", async () => {
        for (const command of blocksOk) {
            expectLabeled(await reads(command), command).toEqual({ ok: true });
        }
        for (const command of blocksRefused) {
            expectLabeled((await reads(command)).ok, command).toBe(false);
        }
    });
});

describe("the read-only applications' switches (findstr, where.exe)", () => {
    it("clears their non-recursive switches, refuses the rest, and judges other arguments as paths", () => {
        expect(applicationArgument("findstr", "/i")).toBe("switch");
        expect(applicationArgument("FINDSTR.EXE", "/N")).toBe("switch");
        expect(applicationArgument("findstr", "/C:two words")).toBe("switch");
        expect(applicationArgument("findstr", "/S")).toBe("refused"); // recurses
        expect(applicationArgument("findstr", "/G:list.txt")).toBe("refused"); // names more files
        expect(applicationArgument("where.exe", "/q")).toBe("switch");
        expect(applicationArgument("where.exe", "/R")).toBe("refused");
        expect(applicationArgument("findstr", "src\\a.txt")).toBe("path");
        expect(applicationArgument("findstr", "TODO")).toBe("path");
    });
});

describe("paths judged as PowerShell spells them", () => {
    const spaces = ["Set-Content -LiteralPath ' leading.txt' -Value x", "Get-Content -LiteralPath ' leading.txt'", "Set-Content -LiteralPath 'notes.txt ' -Value x", "Get-Content -LiteralPath ' '", "Set-Content -LiteralPath 'two words.txt' -Value x"];
    (process.platform === "win32" ? it.skip : itParses(spaces))("refuses a path with a space at either end, which names another file than the trimmed one", async () => {
        symlinkSync(join(outside, "secret.txt"), join(cwd, " leading.txt"));
        expect((await edits("Set-Content -LiteralPath ' leading.txt' -Value x")).ok).toBe(false);
        expect((await reads("Get-Content -LiteralPath ' leading.txt'")).ok).toBe(false);
        expect((await edits("Set-Content -LiteralPath 'notes.txt ' -Value x")).ok).toBe(false);
        expect((await reads("Get-Content -LiteralPath ' '")).ok).toBe(false);
        expect(await edits("Set-Content -LiteralPath 'two words.txt' -Value x")).toEqual({ ok: true });
    });

    const backticks = ["Set-Content -Path 'link``name.txt' -Value x", "Set-Content -LiteralPath 'link``name.txt' -Value x"];
    (process.platform === "win32" ? it.skip : itParses(backticks))("refuses a write target with a backtick, which -Path unescapes and -LiteralPath keeps", async () => {
        symlinkSync(join(outside, "secret.txt"), join(cwd, "link`name.txt"));
        for (const command of backticks) {
            expectLabeled((await edits(command)).ok, command).toBe(false);
        }
    });

    const brackets = ["Get-ChildItem -LiteralPath 'sub[1]' | Select-String s", "Get-ChildItem -Path 'sub`[1`]' | Select-String s", "Get-ChildItem -LiteralPath 'safe[1]' | Select-String a", "Get-ChildItem src/*.txt | Select-String a"];
    (process.platform === "win32" ? it.skip : itParses(brackets))("judges the entries of a bracketed directory listed literally before Select-String reads them", async () => {
        mkdirSync(join(cwd, "sub[1]"));
        symlinkSync(join(outside, "secret.txt"), join(cwd, "sub[1]", "f.txt"));
        mkdirSync(join(cwd, "safe[1]"));
        writeFileSync(join(cwd, "safe[1]", "a.txt"), "a\n");
        expect((await reads("Get-ChildItem -LiteralPath 'sub[1]' | Select-String s")).ok).toBe(false);
        expect((await reads("Get-ChildItem -Path 'sub`[1`]' | Select-String s")).ok).toBe(false);
        expect(await reads("Get-ChildItem -LiteralPath 'safe[1]' | Select-String a")).toEqual({ ok: true });
        expect(await reads("Get-ChildItem src/*.txt | Select-String a")).toEqual({ ok: true });
    });

    const literal = ["Get-Content -LiteralPath 'n[1].txt'", "Get-Content 'n`[1`].txt'", "Get-Content n[1].txt"];
    (process.platform === "win32" ? it.skip : itParses(literal))("judges the literal path of a name with brackets, however it is spelled", async () => {
        symlinkSync(join(outside, "secret.txt"), join(cwd, "n[1].txt"));
        for (const command of literal) {
            expectLabeled((await reads(command)).ok, command).toBe(false);
        }
    });

    const jobs = ["Get-ChildItem | ForEach-Object { $_ & }", "Get-ChildItem | ForEach-Object { ($_ &) }", "Get-ChildItem | ForEach-Object { $_ }"];
    itParses(jobs)("refuses a background job inside a script block", async () => {
        expect((await reads("Get-ChildItem | ForEach-Object { $_ & }")).ok).toBe(false);
        expect((await reads("Get-ChildItem | ForEach-Object { ($_ &) }")).ok).toBe(false);
        expect(await reads("Get-ChildItem | ForEach-Object { $_ }")).toEqual({ ok: true });
    });
});

describe("git judged by the bash git check", () => {
    // A package-manager runner can put `./node_modules/.bin` on PATH; the check refuses git then.
    const pathBefore = process.env.PATH;
    beforeAll(() => { process.env.PATH = (pathBefore ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter); });
    afterAll(() => { process.env.PATH = pathBefore; });

    const clearedGit = ["git status", "git log --oneline -5", "git diff", "git diff -- src/a.txt", "git show HEAD --stat", "git branch", "git log -n:3", "Get-ChildItem src; git status", "git status 2>&1", "git status | Out-String"];
    itParses(clearedGit)("clears the read-only git commands the agent runs constantly", async () => {
        for (const command of clearedGit) {
            expectLabeled(await reads(command), command).toEqual({ ok: true });
        }
    });

    const refusedGit = [
        "git branch -D x",
        "git tag v2",
        "git log --output=out.txt",
        "git diff --no-index /etc/hosts src/a.txt",
        "git ls-remote --upload-pack=touch .",
        "git grep -Otouch foo",
        "git push",
        "git reset --hard",
        "git -C .. status",
        "git log –C ..",
        "git log $ref",
        "git log \"$(Remove-Item x)\"",
        "git status > out.txt",
        "Get-Content src/a.txt | git hash-object --stdin",
        "& git status",
        "git log 'a\" --output=o.txt \"b'",
        "git log ''",
    ];
    itParses(["git status"])("refuses git when PATH has a relative entry, which can name another git where the command runs", async () => {
        const absolute = process.env.PATH;
        process.env.PATH = `bin${delimiter}${absolute}`;
        try {
            expect(await reads("git status")).toMatchObject({ ok: false, reason: expect.stringMatching(/relative entry/) });
        } finally {
            process.env.PATH = absolute;
        }
    });

    itParses(["git status"])("checks the PATH the command runs with, not the extension host's", async () => {
        const parse = await psParse("git status");
        const absolute = process.env.PATH ?? "";
        expect(powershellTreeReadOnly({ ...parse, lookupPath: absolute }, opts)).toMatchObject({ ok: true });
        expect(powershellTreeReadOnly({ ...parse, lookupPath: `bin${delimiter}${absolute}` }, opts)).toMatchObject({ ok: false, reason: expect.stringMatching(/relative entry/) });
    });

    itParses(refusedGit)("refuses what the git check refuses, a computed argument, a redirection, git after a pipe, and words PowerShell 5.1 passes mangled", async () => {
        for (const command of refusedGit) {
            expectLabeled((await reads(command)).ok, command).toBe(false);
        }
    });
});

describe("the gate's PowerShell branch without a parse", () => {
    it("clears nothing: the line goes to the classifier or the banner", () => {
        for (const command of ["Get-ChildItem src", "git status"]) {
            const decision = decideShellCommand({ command, cwd, home, readableRoots: [], writableRoots: [], sessionRules: [], shell: "powershell" });
            expectLabeled(decision, command).toMatchObject({ outcome: "ask", reasons: ["not a read-only command: PowerShell's own parse of the line is not available"] });
        }
    });
});
