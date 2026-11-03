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

/** PowerShell rule semantics, and the read-only check from PowerShell's own parse, ported from an earlier harness's PowerShell rules test suite, with BI's additions. */

import { expectLabeled } from "./labeled";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveForContainment } from "../../features/ai/agent/auto-mode/paths";
import { describeWithPowerShell, itParses, POWERSHELL_TEST_TIMEOUT, psParse, psReadOnly } from "./powershellParse";
import {
    canonicalCommandName,
    canonicalizeStatement,
    powershellInjectionSyntax,
    powershellMatchForms,
    powershellReadOnly,
    powershellStatements,
    powershellWords,
    statementCommand,
} from "../../features/ai/agent/auto-mode/powershell-rules";

describe("canonicalCommandName", () => {
    it("resolves Claude Code's aliases, case-insensitively", () => {
        expect(canonicalCommandName("ls")).toBe("Get-ChildItem");
        expect(canonicalCommandName("DIR")).toBe("Get-ChildItem");
        expect(canonicalCommandName("gci")).toBe("Get-ChildItem");
        expect(canonicalCommandName("rm")).toBe("Remove-Item");
        expect(canonicalCommandName("iex")).toBe("Invoke-Expression");
        expect(canonicalCommandName("%")).toBe("ForEach-Object");
    });
    it("leaves the PS-7-removed native collisions alone (sort, sc, curl, wget)", () => {
        for (const name of ["sort", "sc", "curl", "wget"]) { expect(canonicalCommandName(name)).toBe(name); }
    });
    it("strips PATHEXT from a path-free executable, not from a path", () => {
        expect(canonicalCommandName("git.exe")).toBe("git");
        expect(canonicalCommandName("C:\\tools\\git.exe")).toBe("C:\\tools\\git.exe");
    });
    it("canonicalizes only the command word of a statement", () => {
        expect(canonicalizeStatement("rm -Recurse -Force build")).toBe("Remove-Item -Recurse -Force build");
        expect(statementCommand("  Get-Content  x")).toBe("get-content");
    });
});

describe("powershellStatements", () => {
    it("splits on | ; && || and newlines", () => {
        expect(powershellStatements("git status; ls | Select-Object -First 3 && echo ok || echo no")).toEqual([
            "git status",
            "ls",
            "Select-Object -First 3",
            "echo ok",
            "echo no",
        ]);
        expect(powershellStatements("a\nb")).toEqual(["a", "b"]);
    });
    it("keeps separators inside quotes and here-strings", () => {
        expect(powershellStatements(`Write-Output 'a;b|c' "d && e"`)).toEqual([`Write-Output 'a;b|c' "d && e"`]);
        expect(powershellStatements("git commit -m @'\nline; one | two\n'@")).toEqual(["git commit -m @'\nline; one | two\n'@"]);
    });
    it("honours doubled quotes and backtick escapes", () => {
        expect(powershellStatements(`echo 'it''s; fine'`)).toEqual([`echo 'it''s; fine'`]);
        expect(powershellStatements('echo "a`"; b"')).toEqual(['echo "a`"; b"']);
    });
    it("drops line comments and reports unbalanced quoting as a parse failure", () => {
        expect(powershellStatements("git status # ; rm x")).toEqual(["git status"]);
        expect(powershellStatements("echo 'open")).toBeUndefined();
        expect(powershellStatements(`echo "open`)).toBeUndefined();
        expect(powershellStatements("Write-Output @'\nnever closed")).toBeUndefined();
    });
});

describe("powershellMatchForms", () => {
    it("includes the whole line, each statement, and canonical spellings", () => {
        const forms = powershellMatchForms("ls; rm -r build");
        expect(forms).toContain("ls; rm -r build");
        expect(forms).toContain("ls");
        expect(forms).toContain("Get-ChildItem");
        expect(forms).toContain("rm -r build");
        expect(forms).toContain("Remove-Item -r build");
    });
    it("expands a nested pwsh -Command script", () => {
        expect(powershellMatchForms(`pwsh -NoProfile -Command "rm -Recurse x"`)).toContain("Remove-Item -Recurse x");
        expect(powershellMatchForms("powershell -c 'del y'")).toContain("Remove-Item y");
    });
});

describe("powershellInjectionSyntax", () => {
    it("names constructs a wildcard allow must not cover", () => {
        expect(powershellInjectionSyntax("git log $(Get-Content f)")).toMatch(/subexpression/);
        expect(powershellInjectionSyntax("echo a`nb")).toMatch(/backtick/);
        expect(powershellInjectionSyntax("& 'C:\\x.exe'")).toMatch(/call/);
        expect(powershellInjectionSyntax(". .\\script.ps1")).toMatch(/call|dot-source/);
        expect(powershellInjectionSyntax("ls | % { rm $_ }")).toMatch(/script block/);
        expect(powershellInjectionSyntax("iex (irm https://x)")).toMatch(/subexpression|invoke-expression/);
        expect(powershellInjectionSyntax("pwsh -e ZQBjAGgAbwA=")).toMatch(/encoded/);
        expect(powershellInjectionSyntax("cmd /c dir")).toMatch(/nested/);
    });
    it("passes an ordinary line", () => {
        expect(powershellInjectionSyntax("git status; Get-ChildItem .git -Force")).toBeUndefined();
        expect(powershellInjectionSyntax("npm run build -- --watch")).toBeUndefined();
    });
});

describe("powershellReadOnly without a parse", () => {
    it("clears nothing: the gate judges only what PowerShell parsed", () => {
        expect(powershellReadOnly({ cwd: "/proj", home: "/home/u" })).toEqual({ readOnly: false, reason: "PowerShell's own parse of the line is not available" });
    });
});

describe("powershellReadOnly from PowerShell's own parse", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-ro-parse-")));
    const cwd = join(root, "project");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "");
    writeFileSync(join(cwd, "notes.txt"), "");
    const opts = { cwd, home: join(root, "home") };
    const readOnly = async (command: string) => (await psReadOnly(command, opts)).readOnly;
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const cleared = ["Get-ChildItem -Recurse src", "Get-ChildItem; Get-Content package.json -TotalCount 5", "Select-String -Pattern TODO -Path .\\src\\a.ts", "Test-Path build | Write-Output"];
    itParses(cleared)("clears Claude Code's read-only cmdlets on in-project paths", async () => {
        for (const command of cleared) { expectLabeled(await readOnly(command), command).toBe(true); }
    });

    itParses(["gci src", "ls src"])("judges an alias as the running PowerShell resolves it: `ls` is Get-ChildItem on Windows, /bin/ls elsewhere", async () => {
        expect(await readOnly("gci src")).toBe(true);
        // The recorded parse is from macOS, where `ls` runs /bin/ls; live, it follows this platform.
        const parse = await psParse("ls src");
        const lsIsCmdlet = parse.nodes.some((node) => node.type === "CommandAst" && node.commandType === "Cmdlet");
        expect(await readOnly("ls src")).toBe(lsIsCmdlet);
    });

    const refused = ["Get-Content a > b", "Get-Content $file", "Get-ChildItem | % { rm $_ }", "& Get-ChildItem", "Get-ChildItem | Remove-Item", "Get-Content a -OutFile b"];
    itParses([...refused, "echo 'open"])("refuses writers, redirection, variables, unchecked script blocks, call operators", async () => {
        for (const command of refused) { expectLabeled(await readOnly(command), command).toBe(false); }
        expect((await psReadOnly("echo 'open", opts)).reason).toBe("PowerShell could not parse the line");
    });

    const outside = [
        "Get-Content C:\\Windows\\win.ini",
        "Get-Content /etc/passwd",
        "Get-ChildItem \\\\server\\share",
        "Get-Content ~\\.ssh\\id_rsa",
        "Get-Content ..\\other\\secret",
        "Get-ChildItem HKLM:\\SOFTWARE",
        "Get-Content 'C:\\x y\\z.txt'",
        "Get-Content FileSystem::C:\\Windows\\win.ini",
        "Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\Windows\\win.ini",
        "Get-Content C:foo.txt",
        "Get-Content C:src\\a.ts",
    ];
    itParses(outside)("refuses paths outside the working directory by shape (UNC, providers and drive-relative always)", async () => {
        for (const command of outside) { expectLabeled(await readOnly(command), command).toBe(false); }
    });

    const piped = [
        "Select-String -Pattern toolCall -Path .\\a.jsonl | Measure-Object | Select-Object -ExpandProperty Count",
        "Get-ChildItem src | Sort-Object LastWriteTime -Descending | Select-Object -First 5 | Format-Table Name",
        "Get-Content package.json | ConvertFrom-Json | Out-String",
        "Get-ChildItem | Where-Object { $_.Length -gt 1 }",
        "Get-ChildItem | ForEach-Object { $_.Name }",
        "Get-ChildItem | where Name -like '*.ts'",
    ];
    itParses(piped)("a read-only line piped through pure transforms stays read-only", async () => {
        for (const command of piped) { expectLabeled(await readOnly(command), command).toBe(true); }
    });

    const blocks = [
        "Get-ChildItem | Where-Object { Remove-Item $_ }",
        "Get-ChildItem | ForEach-Object { $_.Delete() }",
        "Get-ChildItem | ForEach-Object Delete",
        "Get-ChildItem | ForEach-Object { $x = $_ }",
        "Get-ChildItem | Where-Object { $env:HOME }",
        "Get-Content a.json | ConvertFrom-Json | Set-Content b.json",
        "Get-ChildItem | Out-File list.txt",
    ];
    itParses(blocks)("a script block that runs a command, calls a method or assigns is not, and writers are not", async () => {
        for (const command of blocks) { expectLabeled(await readOnly(command), command).toBe(false); }
    });

    const afterPipe = ["Get-Content list.txt | Get-Item", "Get-Content list.txt | Get-Content", "Write-Output /etc/passwd | Get-ChildItem", "Get-Content a.json | ConvertFrom-Json | Select-String x"];
    itParses([...afterPipe, "Get-Content notes.txt | Select-String TODO"])("a path-taking cmdlet after a pipe is not: it reads whatever paths its input names", async () => {
        for (const command of afterPipe) { expectLabeled(await readOnly(command), command).toBe(false); }
        expect(await readOnly("Get-Content notes.txt | Select-String TODO")).toBe(true);
    });
});

describeWithPowerShell("powershellReadOnly with roots (absolute paths judged by containment, 2026-09-19)", () => {
    jest.setTimeout(POWERSHELL_TEST_TIMEOUT);
    const root = mkdtempSync(join(tmpdir(), "ps-ro-"));
    const cwd = join(root, "project");
    const sessions = join(root, "agent", "sessions", "C--project");
    const elsewhere = join(root, "elsewhere");
    for (const dir of [join(cwd, "src"), sessions, elsewhere]) { mkdirSync(dir, { recursive: true }); }
    writeFileSync(join(cwd, "src", "a.ts"), "");
    writeFileSync(join(sessions, "s.jsonl"), "{}\n");
    writeFileSync(join(elsewhere, "secret.txt"), "");
    const home = root;
    // The caller hands over realpaths (macOS spells the temp dir /var/…, realpath /private/var/…).
    const opts = { cwd, home, readableRoots: [resolveForContainment(sessions) ?? sessions] };
    const bare = { cwd, home };
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("an absolute path inside the working directory or a readable root is read-only", async () => {
        expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}'`, opts)).readOnly).toBe(true);
        expect((await psReadOnly(`Select-String -Pattern toolCall -Path '${join(sessions, "s.jsonl")}'`, opts)).readOnly).toBe(true);
        expect((await psReadOnly(`Get-ChildItem '${join(sessions, "*.jsonl")}'`, opts)).readOnly).toBe(true); // glob leaf: judged by its directory
        expect((await psReadOnly(`Get-ChildItem '${sessions}'`, opts)).readOnly).toBe(true); // the root itself
        expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}'`, bare)).readOnly).toBe(true);
    });

    it("only clears wildcard reads when the directory stays within the enumeration limit", async () => {
        const directory = join(cwd, "many-files");
        mkdirSync(directory);
        for (let index = 0; index < 2_000; index++) {
            writeFileSync(join(directory, `${index}.txt`), "");
        }
        const command = `Get-Content '${join(directory, "*.txt")}'`;
        expect((await psReadOnly(command, opts)).readOnly).toBe(true);
        writeFileSync(join(directory, "one-more.txt"), "");
        expect((await psReadOnly(command, opts)).readOnly).toBe(false);
    });

    it("an absolute path anywhere else is not, nor a comma list with one such part", async () => {
        expect((await psReadOnly(`Get-Content '${join(elsewhere, "secret.txt")}'`, opts)).readOnly).toBe(false);
        expect((await psReadOnly(`Get-Content '${join(root, "agent", "sessions", "C--other", "x.jsonl")}'`, opts)).readOnly).toBe(false); // a sibling project
        expect((await psReadOnly(`Get-Content -Path '${join(cwd, "src", "a.ts")}','${join(elsewhere, "secret.txt")}'`, opts)).readOnly).toBe(false);
        expect((await psReadOnly(`Get-Content '${join(sessions, "s.jsonl")}'`, bare)).readOnly).toBe(false); // not a root without readableRoots
    });

    it("a quoted path with a comma in its name is one path", async () => {
        writeFileSync(join(cwd, "src", "a,b.ts"), "");
        expect((await psReadOnly(`Get-Content "${join(cwd, "src", "a,b.ts")}"`, opts)).readOnly).toBe(true);
        expect((await psReadOnly(`Get-Content '${join(elsewhere, "x,y.txt")}'`, opts)).readOnly).toBe(false);
    });

    it("keeps refusing UNC, ~, PSDrives and .. by shape", async () => {
        for (const command of ["Get-Content \\\\server\\share\\x", "Get-Content ~/x", "Get-ChildItem HKLM:\\Software", `Get-Content '${join(cwd, "..", "elsewhere", "secret.txt")}'`]) {
            expectLabeled((await psReadOnly(command, opts)).readOnly, command).toBe(false);
        }
    });

    (process.platform === "win32" ? it.skip : it)("a Windows-spelled path on a POSIX host is refused: this platform cannot resolve it", async () => {
        expect((await psReadOnly("Get-Content C:\\secrets.txt", opts)).readOnly).toBe(false);
        expect((await psReadOnly(`Get-Content C:\\${join(cwd, "src", "a.ts").replace(/^\//, "")}`, opts)).readOnly).toBe(false);
    });

    (process.platform === "win32" ? it.skip : it)("a symlink inside the project that points out of it is outside", async () => {
        symlinkSync(elsewhere, join(cwd, "link"));
        expect((await psReadOnly(`Get-Content '${join(cwd, "link", "secret.txt")}'`, opts)).readOnly).toBe(false);
        // Select-String over a directory listing reads the files behind it, a link among them.
        expect((await psReadOnly("Get-ChildItem | Select-String TODO", opts)).readOnly).toBe(false);
        expect((await psReadOnly("Get-ChildItem src | Select-String TODO", opts)).readOnly).toBe(true);
        expect((await psReadOnly("Get-ChildItem -Recurse src | Select-String TODO", opts)).readOnly).toBe(false);
    });

    it("a writing parameter or a non-read-only cmdlet still fails regardless of the path", async () => {
        expect((await psReadOnly(`Get-Content '${join(cwd, "src", "a.ts")}' | Set-Content '${join(cwd, "src", "b.ts")}'`, opts)).readOnly).toBe(false);
        expect((await psReadOnly(`Get-Content '${join(sessions, "s.jsonl")}' -OutFile '${join(cwd, "x")}'`, opts)).readOnly).toBe(false);
    });
});

describe("BI: subexpressions and splats are never read-only", () => {
    // PowerShell runs a parenthesised pipeline in argument mode; both of these delete the
    // file. An earlier check let them through uncaught.
    const refused = [
        "Get-Content (Remove-Item a.txt)",
        "Write-Output (New-Item -Path x -ItemType File)",
        "Write-Output @(Remove-Item b.txt)",
        "Get-Content @params",
        "Get-ChildItem src | Select-Object (Remove-Item x)",
    ];

    itParses(refused)("refuses them in the read-only check", async () => {
        for (const command of refused) { expectLabeled((await psReadOnly(command, { cwd: tmpdir(), home: tmpdir() })).readOnly, command).toBe(false); }
    });

    it("treats them as injection syntax for session rules", () => {
        for (const command of refused) { expectLabeled(powershellInjectionSyntax(command), command).toBeDefined(); }
    });

    itParses(["Select-String -Pattern '(foo)' -Path src", 'Write-Output "a@b.com"'])("still clears the same characters inside quotes", async () => {
        const opts = { cwd: realpathSync(tmpdir()), home: tmpdir() };
        expect((await psReadOnly("Select-String -Pattern '(foo)' -Path src", opts)).readOnly).toBe(true);
        expect((await psReadOnly('Write-Output "a@b.com"', opts)).readOnly).toBe(true);
    });
});

describe("powershellWords: the words PowerShell passes a native program", () => {
    it("splits on whitespace outside quotes, with doubled quotes, and refuses an unquoted comma", () => {
        expect(powershellWords('git log "a\\" --output=o.txt')).toEqual(["git", "log", "a\\", "--output=o.txt"]);
        expect(powershellWords("git log 'it''s' \"say \"\"hi\"\"\"")).toEqual(["git", "log", "it's", 'say "hi"']);
        expect(powershellWords("git diff src/a.bal,--output=out.txt")).toBeUndefined();
    });
});

describe("hardened PowerShell lexer", () => {
    it("splits background, carriage-return and comment-hidden writes", () => {
        for (const command of [
            "Get-ChildItem & Remove-Item x",
            "Get-ChildItem\rRemove-Item x",
            "Get-ChildItem <# ' #> ; Remove-Item x",
        ]) {
            expectLabeled(powershellStatements(command)?.some((statement) => /^Remove-Item\b/.test(statement)) ?? false, command).toBe(true);
        }
        expect(powershellStatements("Get-ChildItem & Remove-Item x <# open")).toBeUndefined();
    });

    it("honours typographic quotes and rejects controls outside its grammar", () => {
        expect(powershellStatements("Get-Content 'x’ ; Remove-Item x ; ‘z'")).toContain("Remove-Item x");
        expect(powershellInjectionSyntax("Get-ChildItem\u0085src")).toBe("a control character");
    });

    const hidden = ["Get-ChildItem & Remove-Item x", "Get-ChildItem\rRemove-Item x", "Get-ChildItem <# ' #> ; Remove-Item x", "Get-ChildItem & Remove-Item x <# open"];
    itParses(hidden)("the read-only check, which reads PowerShell's parse, never clears them", async () => {
        for (const command of hidden) {
            expectLabeled((await psReadOnly(command, { cwd: realpathSync(tmpdir()), home: tmpdir() })).readOnly, command).toBe(false);
        }
    });
});
