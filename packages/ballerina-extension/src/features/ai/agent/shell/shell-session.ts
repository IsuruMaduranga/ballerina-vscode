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
 * What one agent run needs to offer the shell tool, resolved once at run
 * start and shared by the system prompt and the tool registry: the workspace
 * root the shell runs in, the thread's scratchpad (created here), and the
 * gate's readable and writable roots.
 *
 * One shell tool per platform (`shell-policy.ts`): bash on macOS and Linux,
 * PowerShell on Windows, and none on a Windows machine with no PowerShell.
 */

import { homedir } from "os";
import { dirname } from "path";
import { readableRoots, ballerinaHomeFromEnv } from "../auto-mode/readable-roots";
import { tryRealpath } from "../auto-mode/shared-paths";
import { SHELL_TOOL_NAME } from "./bash-description";
import { POWERSHELL_TOOL_NAME } from "./powershell-description";
import { SHELL_OVERRIDE_VAR, shellToolPolicy } from "./shell-policy";
import { powerShellSpawn } from "./shell-spawn";
import { ensureScratchpadDir, scratchpadPromptSection, threadScratchpadDir } from "./scratchpad";

export interface ShellRunSetup {
    /** The one shell tool this platform gets. */
    tool: "shell" | "powershell";
    /** Why the platform did not get the shell it expected, once per session. */
    notice?: string;
    /** The workspace root: every command runs here. */
    cwd: string;
    home: string;
    /** The thread's scratchpad, realpath-resolved; undefined when it could not be created. */
    scratchpadDir?: string;
    readableRoots: string[];
    writableRoots: string[];
    /** The system prompt section for the shell and the scratchpad. */
    promptSection: string;
}

export interface ShellRunSetupOptions {
    platform?: NodeJS.Platform;
    home?: string;
    env?: Record<string, string | undefined>;
    /** Overrides the scratchpad location (tests). */
    scratchpadDir?: string;
    /** Whether a PowerShell resolves; `shell-spawn.ts powerShellSpawn` when absent (tests inject it). */
    powershellAvailable?: boolean;
}

/** The shell's system prompt section, in BI's words. */
export function shellPromptSection(scratchpadDir: string | undefined, tool: "shell" | "powershell" = "shell"): string {
    const runs = tool === "powershell" ? `The ${POWERSHELL_TOOL_NAME} tool runs PowerShell commands` : `The ${SHELL_TOOL_NAME} tool runs bash commands`;
    const shell = `# Shell

${runs} in the workspace root. Read-only commands inside the workspace, the scratchpad and the Ballerina library cache run straight away. Any other command is checked first: depending on the user's setting, a safety check screens it or the user approves it, so do not run one the task does not need. If a command is declined or blocked, the result says so and why: do not retry it or reach the same effect another way; explain what you needed it for and continue with other work.`;
    return scratchpadDir ? `${shell}\n\n${scratchpadPromptSection(scratchpadDir)}` : shell;
}

/** The shell setup for a run, or undefined when this platform has no shell tool or there is no workspace root. */
export function shellRunSetup(projectRoot: string, threadId: string, options: ShellRunSetupOptions = {}): ShellRunSetup | undefined {
    const platform = options.platform ?? process.platform;
    if (!projectRoot) { return undefined; }
    const env = options.env ?? process.env;
    // Resolve PowerShell only where it can be chosen: Windows, or the development override.
    const wantsPowerShell = platform === "win32" || env[SHELL_OVERRIDE_VAR]?.trim().toLowerCase() === "powershell";
    const powershell = wantsPowerShell && (options.powershellAvailable ?? !!powerShellSpawn());
    const policy = shellToolPolicy({ platform, env, powershell });
    if (policy.tool === "none") {
        if (policy.notice) { console.warn(`[ShellTool] ${policy.notice}`); }
        return undefined;
    }
    const home = options.home ?? homedir();
    const requestedScratchpad = options.scratchpadDir ?? threadScratchpadDir(projectRoot, threadId);
    const owner = options.scratchpadDir ? requestedScratchpad : dirname(dirname(dirname(requestedScratchpad)));
    const created = ensureScratchpadDir(requestedScratchpad, owner);
    const scratchpadDir = created ? tryRealpath(created) ?? created : undefined;
    return {
        tool: policy.tool,
        notice: policy.notice,
        cwd: projectRoot,
        home,
        scratchpadDir,
        readableRoots: readableRoots({ home, scratchpadDir, ballerinaHome: ballerinaHomeFromEnv(home, env) }),
        writableRoots: scratchpadDir ? [scratchpadDir] : [],
        promptSection: shellPromptSection(scratchpadDir, policy.tool),
    };
}
