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
 * Native Windows inputs through the PowerShell path, modelled on an
 * earlier harness's Windows-native-paths test suite:
 * `C:\…`, `C:/…`, UNC, drive-relative and `%USERPROFILE%` paths through the
 * read-only check and the floor, the scratchpad's long form under `%TEMP%`,
 * PowerShell resolution, a `.bat` stand-in for `bal.bat` through
 * `commandLaunch` and through PowerShell, and a `-Command` holding `"`.
 * Windows only: the inputs mean nothing elsewhere. Assertions carry the paths
 * they compared, so a CI log is enough to debug a failure. Never assume the
 * checkout and the profile share a drive.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { powershellFloorReason } from "../../features/ai/agent/auto-mode/safety-floor";
import { commandLaunch } from "../../features/ai/agent/shell/command-launch";
import { powershellGuardReason } from "../../features/ai/agent/shell/powershell-guards";
import { runProcess } from "../../features/ai/agent/shell/runner";
import { threadScratchpadDir } from "../../features/ai/agent/shell/scratchpad";
import { runShellCall } from "../../features/ai/agent/shell/shell-call";
import { powerShellEdition, resolvePowerShellSpawn, withPowerShellUtf8 } from "../../features/ai/agent/shell/shell-spawn";
import { expectLabeled } from "./labeled";
import { POWERSHELL_TEST_TIMEOUT, psReadOnly } from "./powershellParse";

const win32 = process.platform === "win32";
const onWindows = win32 ? describe : describe.skip;

onWindows("Windows: the PowerShell read-only check on native paths", () => {
    const root = win32 ? realpathSync(mkdtempSync(join(tmpdir(), "bi-win-ro-"))) : "";
    const cwd = join(root, "project");
    const roots = [join(root, "scratch")];
    if (win32) {
        mkdirSync(join(cwd, "src"), { recursive: true });
        mkdirSync(roots[0], { recursive: true });
        writeFileSync(join(cwd, "src", "main.bal"), "");
    }
    afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    // The read-only check reads PowerShell's own parse, so these run against a real PowerShell.
    jest.setTimeout(POWERSHELL_TEST_TIMEOUT);
    const ro = async (command: string) => (await psReadOnly(command, { cwd, home: homedir(), readableRoots: roots })).readOnly;

    it("clears reads inside the workspace and the readable roots, in either separator", async () => {
        for (const command of [
            `Get-Content ${join(cwd, "src", "main.bal")}`,
            `Get-Content ${join(cwd, "src", "main.bal").replace(/\\/g, "/")}`,
            `Get-ChildItem ${roots[0]}`,
            "Get-ChildItem src\\",
        ]) { expectLabeled(await ro(command), command).toBe(true); }
    });

    it("refuses UNC, drive-relative, other-drive, ~ and .. paths", async () => {
        const otherDrive = cwd.toUpperCase().startsWith("Z:") ? "Y:\\x.txt" : "Z:\\x.txt";
        for (const command of ["Get-Content \\\\server\\share\\a.txt", "Get-Content C:foo.txt", `Get-Content ${otherDrive}`, "Get-Content ~\\secrets.txt", "Get-Content ..\\x.txt", "Get-Content C:\\Windows\\win.ini"]) {
            expectLabeled(await ro(command), command).toBe(false);
        }
    });

    it("stops a floor target spelled with $env:USERPROFILE", () => {
        expect(powershellFloorReason("Set-Content $env:USERPROFILE\\.ballerina\\copilot\\mcp.json '{}'", { cwd, home: homedir() })).toBeDefined();
    });
});

onWindows("Windows: the scratchpad under %TEMP%", () => {
    it("is spelled long-form even when %TEMP% carries an 8.3 short name", () => {
        const dir = threadScratchpadDir(process.cwd(), "thread-1");
        console.log(`tmpdir=${tmpdir()} scratchpad=${dir}`);
        expect(dir).not.toMatch(/~\d/);
    });
});

onWindows("Windows: PowerShell resolution and a live run", () => {
    const spawn = resolvePowerShellSpawn();

    it("finds pwsh or Windows PowerShell 5.1", () => {
        console.log(`powershell=${spawn?.shell} edition=${powerShellEdition(spawn)}`);
        expect(spawn).toBeDefined();
    });

    const dir = win32 ? realpathSync(mkdtempSync(join(tmpdir(), "bi-win-live-"))) : "";
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    if (win32) { writeFileSync(join(dir, "fakebal.bat"), "@echo off\r\necho fakebal %*\r\nexit /b 3\r\n"); }
    const run = (command: string) => runShellCall({ command }, {
        toolName: "powershell", dialect: "powershell", label: "PowerShell", spawn, guard: powershellGuardReason, wrapCommand: withPowerShellUtf8, cwd: dir, runKey: "t", toolCallId: "t",
    });

    it("starts a .bat through PowerShell by bare name and surfaces its exit code", async () => {
        const result = await run("$env:PATH = \"$PWD;$env:PATH\"; fakebal build --offline; Write-Output \"code=$LASTEXITCODE\"");
        expect(result.kind).toBe("foreground");
        if (result.kind === "foreground") {
            expect(result.text).toContain("fakebal build --offline");
            expect(result.text).toContain("code=3");
        }
    }, 60_000);

    it("round-trips a -Command holding double quotes", async () => {
        const result = await run('Write-Output "say ""hi"" there"');
        if (result.kind === "foreground") { expect(result.text.trim()).toBe('say "hi" there'); }
    }, 60_000);

    it("starts a .bat through commandLaunch (the bal tools' path) with its arguments intact", async () => {
        const launch = commandLaunch(join(dir, "fakebal.bat"), ["test", "two words"], process.env);
        expect(launch.command.toLowerCase()).toContain("cmd.exe");
        const summary = await runProcess(launch, { cwd: dir, timeoutMs: 30_000 });
        expect(summary.output.trim()).toBe('fakebal test "two words"');
        expect(summary.exitCode).toBe(3);
    }, 60_000);
});
