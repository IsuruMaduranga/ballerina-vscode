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
 * The safety floor with BI's targets: gate-control files, the
 * Copilot's own state, and Config.toml. Modelled on an earlier harness's
 * safety-floor test suites (bash and PowerShell).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashFloorReason, powershellFloorReason, powershellPathTokens } from "../../features/ai/agent/auto-mode/safety-floor";
import { forwardSlashes as sh } from "../../features/ai/agent/auto-mode/shared-paths";
import { expectLabeled } from "./labeled";

let root: string;
let cwd: string;
let home: string;
let tmp: string;
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-floor-")));
    cwd = join(root, "project");
    home = join(root, "home");
    tmp = join(root, "tmp");
    mkdirSync(join(cwd, ".vscode"), { recursive: true });
    mkdirSync(join(home, ".ballerina", "copilot", "workspaces", "abc"), { recursive: true });
    mkdirSync(join(tmp, "bal-proj-1234"), { recursive: true });
    writeFileSync(join(cwd, "main.bal"), "");
    writeFileSync(join(cwd, ".mcp.json"), "{}");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const bash = (command: string) => bashFloorReason(command, { cwd, home, tmpDir: tmp });
const pwsh = (command: string) => powershellFloorReason(command, { cwd, home, tmpDir: tmp });

describe("bashFloorReason", () => {
    it("stops writes to gate-control files, in this project or anywhere", () => {
        const stopped = [
            "echo '{}' > .mcp.json",
            "echo '{}' > .vscode/settings.json",
            "cp /tmp/x.json .copilot/skills.config.json",
            `echo '{}' > ${sh(join(home, ".ballerina", "copilot", "mcp.json"))}`,
            "echo '{}' > ~/.ballerina/copilot/mcp.json",
            "echo '{}' > ~/.ballerina/copilot/auto-mode.json",
            `echo '{}' > ${sh(join(root, "other-checkout", ".vscode", "settings.json"))}`,
            "sed -i s/a/b/ .mcp.json",
            "echo '{}' > .vscode/sett*.json",
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("stops anything touching the Copilot's own state", () => {
        const stopped = [
            "rm -rf ~/.ballerina/copilot/workspaces",
            "echo x > ~/.ballerina/copilot/workspaces/abc/thread.json",
            `rm -rf ${sh(join(tmp, "bal-proj-1234"))}`,
            `echo x > ${sh(join(tmp, "bal-proj-1234", "main.bal"))}`,
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("stops any mention of Config.toml, read or write", () => {
        for (const command of ["cat Config.toml", "cat tests/Config.toml", "grep token ./Config.toml", "echo x >> config.toml", "cp Config.toml /tmp/c"]) {
            expectLabeled(bash(command), command).toContain("Config.toml");
        }
    });

    it("lets a proven read of a gate-control file through", () => {
        expect(bash("cat .mcp.json")).toBeUndefined();
        // The pre-gate escalates a read of .vscode/*.json (an execution primitive), so the
        // textual pass sees it and stops: a false positive costs one prompt.
        expect(bash("cat .vscode/settings.json")).toBeDefined();
    });

    it("leaves ordinary work alone", () => {
        for (const command of ["bal build", "git status", "echo hi > out.txt", "cat main.bal", "ls ~/.ballerina/repositories", "cat Config.toml.example.md"]) {
            expectLabeled(bash(command), command).toBeUndefined();
        }
    });

    posixOnly("resolves a symlink onto a target rather than trusting the literal path", () => {
        symlinkSync(join(cwd, ".mcp.json"), join(cwd, "innocent.json"));
        expect(bash("echo '{}' > innocent.json")).toBeDefined();
    });

    it("names a target in a command it cannot model as a write", () => {
        expect(bash("python3 tool.py --out .vscode/settings.json")).toBeDefined();
        expect(bash("sh -c 'echo x > .mcp.json'")).toBeDefined();
    });

    it("tracks a literal cd by scope for redirect and input targets", () => {
        expect(bash("cd .copilot && python3 tool.py --out skills.config.json")).toBeDefined();
        expect(bash("cd .copilot && python3 tool.py < skills.config.json")).toBeDefined();
    });

    it("stops a control-file basename when a cd target is unknown or conditional", () => {
        const stopped = [
            'cd "$TARGET"; python3 tool.py --out skills.config.json',
            "false && cd .copilot; python3 tool.py --out skills.config.json",
            "cd .copilot | cat; python3 tool.py --out skills.config.json",
            "while false; do cd .copilot; done; python3 tool.py --out skills.config.json",
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("does not leak a cd in command substitution into the parent shell", () => {
        expect(bash('cd .copilot; echo "$(cd /tmp; pwd)" > skills.config.json')).toBeDefined();
    });
});

describe("powershellPathTokens", () => {
    it("extracts path-shaped tokens, expanding $env:USERPROFILE, $HOME and ~, forward-slashed", () => {
        expect(powershellPathTokens(`Set-Content -Path "$env:USERPROFILE\\.ballerina\\copilot\\mcp.json" '{}'`, "/h")).toEqual(["/h/.ballerina/copilot/mcp.json"]);
        expect(powershellPathTokens("Get-Content ~/.ballerina/copilot/auto-mode.json | Out-Null", "/h")).toEqual(["/h/.ballerina/copilot/auto-mode.json"]);
        expect(powershellPathTokens("Set-Content -Path:.vscode\\settings.json x", "/h")).toEqual([".vscode/settings.json"]);
        expect(powershellPathTokens("git status; bal build", "/h")).toEqual([]);
    });
});

describe("powershellFloorReason", () => {
    it("stops any line naming a target, read or write", () => {
        const stopped = [
            `Set-Content -Path "$env:USERPROFILE\\.ballerina\\copilot\\mcp.json" -Value '{}'`,
            "Add-Content .vscode/settings.json '{}'",
            "Get-Content .mcp.json",
            "Get-Content Config.toml",
            "Remove-Item -Recurse ~/.ballerina/copilot/workspaces",
        ];
        for (const command of stopped) { expectLabeled(pwsh(command), command).toBeDefined(); }
    });

    it("lets ordinary work through", () => {
        for (const command of ["git status; bal build", "Set-Content src/config.json '{}'", "Get-Content package.json"]) {
            expectLabeled(pwsh(command), command).toBeUndefined();
        }
    });
});
