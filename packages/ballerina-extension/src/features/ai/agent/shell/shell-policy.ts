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
 * Which one shell tool this platform gets (owner, 2026-09-23), cut
 * down from pincer-agent `extensions/powershell/policy.ts`: never two.
 *
 * - Windows: `powershell` when a PowerShell resolves, else no shell tool and a
 *   notice saying why. No bash, whether or not Git for Windows is installed.
 * - macOS and Linux: `shell` (bash), or `powershell` when the development
 *   override `WSO2_INTEGRATOR_COPILOT_SHELL=powershell` is set in the
 *   environment and a `pwsh` is on PATH. The override is read from the
 *   environment only, never from a workspace setting.
 *
 * Pure.
 */

export const SHELL_OVERRIDE_VAR = "WSO2_INTEGRATOR_COPILOT_SHELL";

export type ShellToolKind = "shell" | "powershell" | "none";

export interface ShellAvailability {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    /** A PowerShell resolved (`shell-spawn.ts resolvePowerShellSpawn`). */
    powershell: boolean;
}

export interface ShellToolPolicy {
    tool: ShellToolKind;
    /** Shown to the user once, when the platform ends up without the shell it expected. */
    notice?: string;
}

export const NO_POWERSHELL_NOTICE =
    "The WSO2 Integrator Copilot has no shell tool on this machine: neither pwsh.exe on PATH nor Windows PowerShell " +
    "(System32\\WindowsPowerShell\\v1.0\\powershell.exe) was found. It can still build, run and test through its own tools.";

export function shellToolPolicy({ platform, env, powershell }: ShellAvailability): ShellToolPolicy {
    if (platform === "win32") {
        return powershell ? { tool: "powershell" } : { tool: "none", notice: NO_POWERSHELL_NOTICE };
    }
    if (env[SHELL_OVERRIDE_VAR]?.trim().toLowerCase() === "powershell") {
        return powershell
            ? { tool: "powershell" }
            : { tool: "shell", notice: `${SHELL_OVERRIDE_VAR}=powershell is set but no pwsh is on PATH, so the bash shell tool is used.` };
    }
    return { tool: "shell" };
}
