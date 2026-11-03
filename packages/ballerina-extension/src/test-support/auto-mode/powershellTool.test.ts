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
 * The Windows `powershell` tool: which tool a platform gets, how
 * PowerShell resolves, its guards (ported from an earlier harness's
 * `powershell-guards.test.ts`), its description, its gate branch and session
 * rules, the Windows roots on the sensitive list, and a live run through a
 * real `pwsh` when one is found (`PWSH_PATH`, PATH, or the portable build
 * cached locally for Mac development).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, isAbsolute, join } from "path";
import { authorizeShellCommand, decideShellCommand, type ShellApprovalPrompt, type ShellGateInput } from "../../features/ai/agent/auto-mode/gate";
import type { ClassifyVerdict } from "../../features/ai/agent/auto-mode/prompt";
import { PauseTracker } from "../../features/ai/agent/auto-mode/pause";
import { isSensitivePath } from "../../features/ai/agent/auto-mode/sensitive";
import { matchPowerShellSessionRule, suggestPowerShellSessionRule } from "../../features/ai/agent/auto-mode/session-rules";
import { EDITION_SECTIONS, powershellToolDescription } from "../../features/ai/agent/shell/powershell-description";
import { powershellGuardReason, startSleepSeconds } from "../../features/ai/agent/shell/powershell-guards";
import { runShellCall } from "../../features/ai/agent/shell/shell-call";
import { NO_POWERSHELL_NOTICE, shellToolPolicy } from "../../features/ai/agent/shell/shell-policy";
import { shellRunSetup } from "../../features/ai/agent/shell/shell-session";
import { POWERSHELL_ARGS, powerShellEdition, resolvePowerShellSpawn, withPowerShellUtf8 } from "../../features/ai/agent/shell/shell-spawn";
import { whichOnPath } from "../../features/ai/agent/shell/which";
import { expectLabeled } from "./labeled";
import { itParses, psParse } from "./powershellParse";

describe("shellToolPolicy: exactly one shell tool per platform", () => {
    it("gives Windows PowerShell, or no shell tool with a notice", () => {
        expect(shellToolPolicy({ platform: "win32", env: {}, powershell: true })).toEqual({ tool: "powershell" });
        expect(shellToolPolicy({ platform: "win32", env: {}, powershell: false })).toEqual({ tool: "none", notice: NO_POWERSHELL_NOTICE });
    });

    it("gives macOS and Linux bash, or PowerShell under the development override", () => {
        expect(shellToolPolicy({ platform: "darwin", env: {}, powershell: true })).toEqual({ tool: "shell" });
        expect(shellToolPolicy({ platform: "linux", env: { WSO2_INTEGRATOR_COPILOT_SHELL: "powershell" }, powershell: true })).toEqual({ tool: "powershell" });
        const fallback = shellToolPolicy({ platform: "darwin", env: { WSO2_INTEGRATOR_COPILOT_SHELL: "powershell" }, powershell: false });
        expect(fallback.tool).toBe("shell");
        expect(fallback.notice).toContain("no pwsh");
    });

    it("never reads the override on Windows", () => {
        expect(shellToolPolicy({ platform: "win32", env: { WSO2_INTEGRATOR_COPILOT_SHELL: "bash" }, powershell: true }).tool).toBe("powershell");
    });
});

describe("resolvePowerShellSpawn", () => {
    const env = { SystemRoot: "C:\\Windows" };

    it("prefers pwsh on PATH, then Windows PowerShell 5.1 at its System32 path on Windows", () => {
        const pwsh = resolvePowerShellSpawn({ platform: "win32", env, which: () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe", exists: () => true });
        expect(pwsh).toEqual({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [...POWERSHELL_ARGS] });
        expect(powerShellEdition(pwsh)).toBe("core");
        const desktop = resolvePowerShellSpawn({ platform: "win32", env, which: () => undefined, exists: (path) => path.endsWith("powershell.exe") });
        expect(desktop?.shell).toMatch(/System32.WindowsPowerShell.v1\.0.powershell\.exe$/i);
        expect(powerShellEdition(desktop)).toBe("desktop");
        expect(resolvePowerShellSpawn({ platform: "win32", env, which: () => undefined, exists: () => false })).toBeUndefined();
    });

    it("takes only a PATH pwsh elsewhere", () => {
        expect(resolvePowerShellSpawn({ platform: "darwin", env: {}, which: () => "/usr/local/bin/pwsh" })?.shell).toBe("/usr/local/bin/pwsh");
        expect(resolvePowerShellSpawn({ platform: "darwin", env: {}, which: () => undefined, exists: () => true })).toBeUndefined();
    });

    it("prefixes every command with one line: UTF-8 console, Out-File and $OutputEncoding, plain-text rendering", () => {
        const wrapped = withPowerShellUtf8("git status");
        expect(wrapped.startsWith("try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ")).toBe(true);
        expect(wrapped).toContain("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'");
        expect(wrapped).toContain("$OutputEncoding = [System.Text.UTF8Encoding]::new()");
        expect(wrapped).toContain("$PSStyle.OutputRendering = 'PlainText'");
        // One line of prefix, so an error's line number is off by one only.
        expect(wrapped.split("\n")).toHaveLength(2);
        expect(wrapped.endsWith("\ngit status")).toBe(true);
    });
});

describe("shellRunSetup picks the tool", () => {
    let root: string;
    beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "bi-ps-setup-"))); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const setup = (platform: NodeJS.Platform, env: Record<string, string>, powershellAvailable: boolean) =>
        shellRunSetup(join(root, "p"), "t", { platform, env, home: join(root, "h"), scratchpadDir: join(root, "s"), powershellAvailable });

    it("sets up PowerShell on Windows and names it in the prompt", () => {
        const win = setup("win32", {}, true);
        expect(win?.tool).toBe("powershell");
        expect(win?.promptSection).toContain("The powershell tool runs PowerShell commands");
        expect(setup("win32", {}, false)).toBeUndefined();
    });

    it("sets up bash elsewhere unless the override asks for PowerShell", () => {
        expect(setup("darwin", {}, true)?.tool).toBe("shell");
        expect(setup("darwin", { WSO2_INTEGRATOR_COPILOT_SHELL: "powershell" }, true)?.tool).toBe("powershell");
    });
});

describe("startSleepSeconds / powershellGuardReason", () => {
    const fg = { background: false };

    it("reads positional, -Seconds, -s and -Milliseconds forms, and nothing else", () => {
        expect(startSleepSeconds("Start-Sleep 5")).toBe(5);
        expect(startSleepSeconds("Start-Sleep -Seconds 30")).toBe(30);
        expect(startSleepSeconds("Start-Sleep -s 1")).toBe(1);
        expect(startSleepSeconds("Start-Sleep -Milliseconds 500")).toBe(0.5);
        expect(startSleepSeconds("Start-Sleep -Seconds:3")).toBe(3);
        expect(startSleepSeconds("Start-Sleep $delay")).toBeUndefined();
        expect(startSleepSeconds("Start-Sleep -Duration ([TimeSpan]::FromSeconds(3))")).toBeUndefined();
        expect(startSleepSeconds("Start-Sleep")).toBeUndefined();
    });

    it("blocks a leading Start-Sleep that is not provably short", () => {
        expect(powershellGuardReason("Start-Sleep -Seconds 30", fg)).toMatch(/Blocked: standalone `Start-Sleep -Seconds 30`/);
        expect(powershellGuardReason("sleep 10; bal test", fg)).toMatch(/followed by: bal test/);
        expect(powershellGuardReason("Start-Sleep 1; Start-Sleep 1; ls", fg)).toMatch(/Blocked/);
        expect(powershellGuardReason("Start-Sleep $n", fg)).toMatch(/Blocked/);
    });

    it("passes a short pacing sleep, a sleep deeper in the chain, and background runs", () => {
        expect(powershellGuardReason("Start-Sleep -Milliseconds 500; ls", fg)).toBeUndefined();
        expect(powershellGuardReason("bal build; Start-Sleep 30", fg)).toBeUndefined();
        expect(powershellGuardReason("Start-Sleep 60", { background: true })).toBeUndefined();
    });

    it("blocks interactive cmdlets and interactive git in either mode", () => {
        expect(powershellGuardReason("Read-Host 'name'", fg)).toMatch(/read-host/);
        expect(powershellGuardReason("ls | Out-GridView", { background: true })).toMatch(/out-gridview/);
        expect(powershellGuardReason("git rebase -i HEAD~3", fg)).toMatch(/git rebase -i/);
        expect(powershellGuardReason("git add -p", fg)).toMatch(/interactive `git add`/);
        expect(powershellGuardReason("git -C C:\\repo rebase -i HEAD~3", fg)).toMatch(/git rebase -i/);
        expect(powershellGuardReason("git -c core.pager=cat add --patch", fg)).toMatch(/interactive `git add`/);
        expect(powershellGuardReason("Read-Host 'name'", fg)).toContain("Clarify");
    });

    it("passes ordinary and unparseable lines", () => {
        expect(powershellGuardReason("git status; bal test", fg)).toBeUndefined();
        expect(powershellGuardReason("echo 'open", fg)).toBeUndefined();
    });
});

describe("powershellToolDescription", () => {
    it("carries the edition section chosen by executable name", () => {
        expect(powershellToolDescription("core")).toContain(EDITION_SECTIONS.core);
        expect(powershellToolDescription("desktop")).toContain("`&&` and `||` do not exist");
        expect(powershellToolDescription("unknown")).toContain("write for Windows PowerShell 5.1");
    });

    it("steers to BI's tools, background runs, the scratchpad and one-line reads", () => {
        const text = powershellToolDescription("core");
        for (const needle of ["file_read", "getCompilationErrors", "task-service-", "task_output", "kill_task", "scratchpad", "one plain command per call", "$LASTEXITCODE", "@'"]) {
            expectLabeled(text.includes(needle), needle).toBe(true);
        }
        expect(text).not.toMatch(/\bbash is also available\b/i);
    });
});

describe("the gate's PowerShell branch", () => {
    let root: string;
    let cwd: string;
    beforeEach(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), "bi-ps-gate-")));
        cwd = join(root, "project");
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "main.bal"), "");
    });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const input = (command: string, sessionRules: ShellGateInput["sessionRules"] = []): ShellGateInput => ({
        command, cwd, home: join(root, "home"), readableRoots: [], writableRoots: [], sessionRules, shell: "powershell",
    });

    const readOnlyLines = ["Get-ChildItem src", "Get-Content main.bal | Select-Object -First 5", "git status", "git log --oneline -3"];
    const otherLines = ["bal build", "Remove-Item main.bal", "Get-Content (Remove-Item main.bal)", "git push"];
    itParses([...readOnlyLines, ...otherLines])("clears read-only lines from PowerShell's parse, git reads included, and nothing else", async () => {
        // A package-manager runner can put `./node_modules/.bin` on PATH; the git check refuses git then.
        const pathBefore = process.env.PATH;
        process.env.PATH = (pathBefore ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter);
        try {
            for (const command of readOnlyLines) {
                const decision = decideShellCommand({ ...input(command), powershellParse: await psParse(command) });
                expectLabeled(decision.outcome, command).toBe("allow");
            }
            for (const command of otherLines) {
                expectLabeled(decideShellCommand({ ...input(command), powershellParse: await psParse(command) }).outcome, command).toBe("ask");
            }
        } finally {
            process.env.PATH = pathBefore;
        }
        expect(decideShellCommand(input("Get-ChildItem src")).outcome).toBe("ask");
    });

    it("offers a guarded canonical prefix, and none for a destructive line", () => {
        const context = { cwd, home: join(root, "home"), writableRoots: [] };
        expect(suggestPowerShellSessionRule("bal build", context)?.rule).toEqual({ kind: "prefix", command: "bal build" });
        for (const command of ["Remove-Item -Recurse target", "rm main.bal", "del x", "git push", "bal push", "Start-Process notepad"]) {
            expectLabeled(suggestPowerShellSessionRule(command), command).toBeUndefined();
        }
        const rules = [{ kind: "prefix" as const, command: "bal build" }];
        expect(matchPowerShellSessionRule(rules, "bal build --offline", context)).toBeDefined();
        expect(decideShellCommand(input("bal build --offline", rules))).toMatchObject({ outcome: "allow", layer: "session-rule" });
    });

    it("matches PowerShell prefixes statement-by-statement after alias canonicalization", () => {
        const context = { cwd, home: join(root, "home"), writableRoots: [] };
        const rules = [
            { kind: "prefix" as const, command: "get-childitem src" },
            { kind: "prefix" as const, command: "get-content src" },
        ];
        expect(matchPowerShellSessionRule(rules, "DIR src -Force; cat src", context)).toEqual(rules[0]);
        expect(matchPowerShellSessionRule(rules, "DIR src; Remove-Item main.bal", context)).toBeUndefined();
    });

    it("never lets a PowerShell prefix cover an outside, secret or protected target", () => {
        const context = { cwd, home: join(root, "home"), writableRoots: [] };
        const rule = { kind: "prefix" as const, command: "get-childitem src" };
        for (const command of [
            "Get-ChildItem /etc",
            "Get-ChildItem .env",
            "Get-ChildItem .git/config",
            "Get-ChildItem -Path=/etc",
            "Get-ChildItem --output=/etc",
        ]) {
            expectLabeled(matchPowerShellSessionRule([rule], command, context), command).toBeUndefined();
        }
        expect(suggestPowerShellSessionRule("Set-Content .git/config value", context)?.rule.kind).toBe("exact");
        expect(suggestPowerShellSessionRule("bal build --output=/etc", context)?.rule.kind).toBe("exact");
    });

    it("does not let a prefix carry directory state into later statements", () => {
        const context = { cwd, home: join(root, "home"), writableRoots: [] };
        const rules = [
            { kind: "prefix" as const, command: "set-location src" },
            { kind: "prefix" as const, command: "bal build" },
        ];
        expect(suggestPowerShellSessionRule("Set-Location src", context)?.rule.kind).toBe("exact");
        expect(matchPowerShellSessionRule(rules, "Set-Location src; bal build", context)).toBeUndefined();
    });

    it("compares only command words case-insensitively", () => {
        const context = { cwd, home: join(root, "home"), writableRoots: [] };
        const rule = { kind: "prefix" as const, command: "npm run Build" };
        expect(matchPowerShellSessionRule([rule], "NPM run Build --offline", context)).toBe(rule);
        expect(matchPowerShellSessionRule([rule], "NPM run build --offline", context)).toBeUndefined();
    });

    it("stops a line naming a floor target, in ask and auto mode", async () => {
        const decision = decideShellCommand(input("Get-Content Config.toml"));
        expect(decision).toMatchObject({ outcome: "ask", floor: true });
        const prompts: ShellApprovalPrompt[] = [];
        const classified: string[] = [];
        await authorizeShellCommand(input("Set-Content .mcp.json '{}'"), "auto", {
            ask: async (prompt) => { prompts.push(prompt); return "deny"; },
            grantRule: () => undefined,
            auto: { pause: new PauseTracker(), classify: async (c) => { classified.push(c); return { decision: "allow", reason: "", tier: "allow" }; } },
        });
        expect(classified).toHaveLength(0);
        expect(prompts).toHaveLength(1);
    });

    it("classifies an in-workspace Remove-Item in auto mode: no recoverability fast path", async () => {
        const classified: string[] = [];
        const block: ClassifyVerdict = { decision: "block", reason: "Irreversible Local Destruction", tier: "soft_deny", ruleId: "Irreversible Local Destruction" };
        const result = await authorizeShellCommand(input("Remove-Item main.bal"), "auto", {
            ask: async () => "allow",
            grantRule: () => undefined,
            auto: { pause: new PauseTracker(), classify: async (c) => { classified.push(c); return block; } },
        });
        expect(classified).toEqual(["Remove-Item main.bal"]);
        expect(result).toMatchObject({ allowed: false, by: "classifier" });
    });
});

describe("Windows roots on the sensitive list", () => {
    it("covers the Windows directory and AppData, except the temp directory holding the scratchpad", () => {
        for (const path of ["C:\\Windows\\System32\\config\\SAM", "c:/windows/win.ini", "C:\\Users\\u\\AppData\\Roaming\\gh\\hosts.yml", "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data", "C:\\Users\\u\\AppData\\LocalLow\\x"]) {
            expectLabeled(isSensitivePath(path), path).toBe(true);
        }
        for (const path of ["C:\\Users\\u\\AppData\\Local\\Temp\\wso2-integrator-copilot\\p\\t\\scratchpad\\a.txt", "C:\\Users\\u\\proj\\main.bal", "C:\\WindowsApps-not\\x"]) {
            expectLabeled(isSensitivePath(path), path).toBe(false);
        }
    });
});

/** A real pwsh: PWSH_PATH, PATH, or the portable PowerShell 7 build cached under `~/.cache/cc-windows-mode/pwsh` for Mac development. */
function findPwsh(): string | undefined {
    const candidates = [process.env.PWSH_PATH, whichOnPath("pwsh", process.env), join(homedir(), ".cache", "cc-windows-mode", "pwsh", "pwsh")];
    return candidates.find((path): path is string => !!path && existsSync(path));
}

const pwsh = findPwsh();
(pwsh ? describe : describe.skip)(`the shared body against a real PowerShell (${pwsh ?? "none found"})`, () => {
    let cwd: string;
    beforeEach(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), "bi-ps-live-"))); });
    afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
    const run = (command: string) => runShellCall({ command }, {
        toolName: "powershell",
        label: "PowerShell",
        spawn: { shell: pwsh as string, args: [...POWERSHELL_ARGS] },
        guard: powershellGuardReason,
        wrapCommand: withPowerShellUtf8,
        cwd,
        runKey: "test",
        toolCallId: "t1",
    });

    it("runs a command in the workspace and returns UTF-8 output", async () => {
        const result = await run("Set-Content -Path a.txt -Value 'naïve café' -Encoding utf8; Get-Content a.txt; (Get-Location).Path");
        expect(result.kind).toBe("foreground");
        if (result.kind === "foreground") {
            expect(result.summary.exitCode).toBe(0);
            expect(result.text).toContain("naïve café");
            expect(result.text).toContain(cwd);
        }
    }, 60_000);

    it("reports a native program's failure through its exit code", async () => {
        const result = await run("git --no-such-flag");
        expect(result.kind).toBe("foreground");
        if (result.kind === "foreground") { expect(result.summary.exitCode).not.toBe(0); }
    }, 60_000);

    it("round-trips a command holding double quotes", async () => {
        const result = await run('Write-Output "say ""hi"" to $("the" + " world")"');
        if (result.kind === "foreground") { expect(result.text.trim()).toBe('say "hi" to the world'); }
    }, 60_000);

    it("formats tables without ANSI colour, and writes a redirect as UTF-8", async () => {
        const result = await run("[pscustomobject]@{ Name = 'a' } | Format-Table; 'naïve' > out.txt");
        expect(result.kind).toBe("foreground");
        if (result.kind === "foreground") {
            expect(result.text).toContain("Name");
            expect(result.text).not.toContain("\x1b[");
        }
        // UTF-8, with or without a byte-order mark, never UTF-16.
        expect(readFileSync(join(cwd, "out.txt")).toString("utf8").replace(/^\uFEFF/, "").trim()).toBe("naïve");
    }, 60_000);
});
