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
 * gate's readable and writable roots (design §7, §8).
 *
 * The bash tool exists on macOS and Linux only. Windows gets the PowerShell
 * tool in Phase B2; until then it has no shell tool at all.
 */

import { homedir } from "os";
import { readableRoots, ballerinaHomeFromEnv } from "../auto-mode/readable-roots";
import { tryRealpath } from "../auto-mode/shared-paths";
import { SHELL_TOOL_NAME } from "./bash-description";
import { ensureScratchpadDir, scratchpadPromptSection, threadScratchpadDir } from "./scratchpad";

export interface ShellRunSetup {
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
}

/** The shell's system prompt section, in BI's words. */
export function shellPromptSection(scratchpadDir: string | undefined): string {
    const shell = `# Shell

The ${SHELL_TOOL_NAME} tool runs bash commands in the workspace root. Read-only commands inside the workspace, the scratchpad and the Ballerina library cache run straight away. Any other command is checked first: depending on the user's setting, a safety check screens it or the user approves it, so do not run one the task does not need. If a command is declined or blocked, the result says so and why: do not retry it or reach the same effect another way; explain what you needed it for and continue with other work.`;
    return scratchpadDir ? `${shell}\n\n${scratchpadPromptSection(scratchpadDir)}` : shell;
}

/** The shell setup for a run, or undefined when this platform has no shell tool yet or there is no workspace root. */
export function shellRunSetup(projectRoot: string, threadId: string, options: ShellRunSetupOptions = {}): ShellRunSetup | undefined {
    const platform = options.platform ?? process.platform;
    if (platform === "win32" || !projectRoot) { return undefined; }
    const home = options.home ?? homedir();
    const created = ensureScratchpadDir(options.scratchpadDir ?? threadScratchpadDir(projectRoot, threadId));
    const scratchpadDir = created ? tryRealpath(created) ?? created : undefined;
    return {
        cwd: projectRoot,
        home,
        scratchpadDir,
        readableRoots: readableRoots({ home, scratchpadDir, ballerinaHome: ballerinaHomeFromEnv(home, options.env) }),
        writableRoots: scratchpadDir ? [scratchpadDir] : [],
        promptSection: shellPromptSection(scratchpadDir),
    };
}
