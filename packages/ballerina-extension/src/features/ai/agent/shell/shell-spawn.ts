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
 * (tip `5059966`), cut down to what BI runs (design §6, §9):
 *
 * - bash is `/bin/bash`, macOS and Linux only. There is no bash on Windows (owner, 2026-09-23), so no Git
 *   Bash search, no bash-path setting and no WSL stdin transport: the command always goes in as an argv
 *   element (`bash -c <cmd>`).
 * - PowerShell (`pwsh.exe`, else Windows PowerShell 5.1 at its System32 path) arrives in Phase B2 as a
 *   second resolver returning the same `ShellSpawn`, so the runner never changes.
 *
 * Nothing here reads a workspace setting: a checked-in `.vscode/settings.json` must never be able to name
 * the executable that runs every shell call.
 */

import type { ProcessLaunch } from "./runner";

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
