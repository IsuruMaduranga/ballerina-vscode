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
 * Which shell the Copilot spawns, and how. The shape of pincer-agent's `extensions/lib/shell-spawn.ts`
 * (tip `5059966`), cut down to what BI runs:
 *
 * - bash is `/bin/bash`, macOS and Linux only. There is no bash on Windows (owner, 2026-09-23), so no Git
 *   Bash search, no bash-path setting and no WSL stdin transport: the command always goes in as an argv
 *   element (`bash -c <cmd>`).
 * - PowerShell: `pwsh.exe` from PATH, else Windows PowerShell 5.1 at its System32 path (never from PATH),
 *   on Windows; a `pwsh` on PATH elsewhere, for the development override (`shell-policy.ts`). It is a second
 *   resolver returning the same `ShellSpawn`, so the runner never changes. Every command gets
 *   `POWERSHELL_UTF8_PREFIX`, so Windows PowerShell 5.1 does not print UTF-16.
 *
 * Nothing here reads a workspace setting: a checked-in `.vscode/settings.json` must never be able to name
 * the executable that runs every shell call.
 */

import { existsSync } from "fs";
import { basename } from "path";
import { system32Path } from "../auto-mode/shared-paths";
import type { ProcessLaunch } from "./runner";
import { whichOnPath } from "./which";

/** How to start a shell for one command line: `shell` with `args`, then the command as one more argument. */
export interface ShellSpawn {
    shell: string;
    args: string[];
}

export const BASH_PATH = "/bin/bash";

/** The bash the `shell` tool runs, or undefined on Windows (no bash tool there). */
export function bashSpawn(platform: NodeJS.Platform = process.platform): ShellSpawn | undefined {
    if (platform === "win32") { return undefined; }
    return { shell: BASH_PATH, args: ["-c"] };
}

/** The launch for `command` under `spec`, for `runner.ts`. Never through `shell: true` or `cmd.exe`. */
export function shellLaunch(spec: ShellSpawn, command: string): ProcessLaunch {
    return { command: spec.shell, args: [...spec.args, command] };
}

/** pi's PowerShell argument list, which Claude Code also runs: no profile, no prompts, no script policy. */
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Prefixed to every PowerShell command: Windows PowerShell 5.1 otherwise writes UTF-16 to a pipe. */
export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** Windows PowerShell 5.1, addressed by its System32 path so a PATH entry can never stand in for it. */
export const WINDOWS_POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";

export interface PowerShellResolveInput {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** PATH lookup (`which.ts whichOnPath`); injectable for tests. */
    which?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
    /** Whether a file exists; injectable for tests. */
    exists?: (path: string) => boolean;
}

/** The PowerShell for this machine, or undefined when none resolves. */
export function resolvePowerShellSpawn(input: PowerShellResolveInput = {}): ShellSpawn | undefined {
    const platform = input.platform ?? process.platform;
    const env = input.env ?? process.env;
    const which = input.which ?? ((command: string, e: NodeJS.ProcessEnv) => whichOnPath(command, e, platform));
    const pwsh = which("pwsh", env);
    if (pwsh) { return { shell: pwsh, args: [...POWERSHELL_ARGS] }; }
    if (platform === "win32") {
        const desktop = system32Path(WINDOWS_POWERSHELL, env);
        if ((input.exists ?? existsSync)(desktop)) { return { shell: desktop, args: [...POWERSHELL_ARGS] }; }
    }
    return undefined;
}

let cachedPowerShell: { spawn: ShellSpawn | undefined } | undefined;

/** The PowerShell this process spawns, resolved once per process. */
export function powerShellSpawn(): ShellSpawn | undefined {
    cachedPowerShell ??= { spawn: resolvePowerShellSpawn() };
    return cachedPowerShell.spawn;
}

/** PowerShell 7+ (`pwsh`) or Windows PowerShell 5.1 (`powershell.exe`), by executable name, never by a probe. */
export function powerShellEdition(spec: ShellSpawn | undefined): "core" | "desktop" | "unknown" {
    if (!spec) { return "unknown"; }
    const name = basename(spec.shell.replace(/\\/g, "/")).toLowerCase();
    if (name === "pwsh" || name === "pwsh.exe") { return "core"; }
    if (name === "powershell.exe" || name === "powershell") { return "desktop"; }
    return "unknown";
}

/** The command PowerShell runs: the UTF-8 prefix, then the model's command. */
export function withPowerShellUtf8(command: string): string {
    return `${POWERSHELL_UTF8_PREFIX}${command}`;
}
