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
 * The thread's scratchpad: a temp-files directory the system prompt points the
 * agent at, instead of `/tmp` or the user's project (design §8). The shape
 * follows Claude Code's (`<tmp>/<owner>/<project-slug>/<session-id>/scratchpad`)
 * as pincer-agent's `extensions/lib/scratchpad.ts` (tip `2602e3c`) builds it,
 * with the WSO2 Integrator Copilot's own owner segment, so a machine running
 * Claude Code too never interleaves the two under one owner directory, and a
 * thread id in place of the session id.
 *
 * The bash pre-gate clears writes into exactly this directory
 * (`shell-analysis.ts` `writableRoots`) and it is a readable root for both
 * pre-gates (`auto-mode/readable-roots.ts`); nothing else under the temp root
 * gets special treatment.
 */

import { mkdirSync } from "fs";
import * as os from "os";
import { join } from "path";
import { tryRealpath } from "../auto-mode/shared-paths";

/** Claude Code's project-directory slug: every character outside [A-Za-z0-9-] becomes "-". */
export function projectSlug(projectRoot: string): string {
    return projectRoot.replace(/[^A-Za-z0-9-]/g, "-");
}

/** Pure core: the scratchpad's path for a temp root, a user id, a project and a thread. */
export function scratchpadDir(tmpRoot: string, uid: number | undefined, projectRoot: string, threadId: string): string {
    const owner = uid === undefined ? "wso2-integrator-copilot" : `wso2-integrator-copilot-${uid}`;
    // The thread id is slugged too: it names a directory, so it must not carry a separator or `..`.
    return join(tmpRoot, owner, projectSlug(projectRoot), projectSlug(threadId), "scratchpad");
}

/**
 * The temp root in its resolved spelling, so the path in the prompt, the path
 * the gate compares and a write's resolved target all name the same place:
 * `/tmp` through its symlink (macOS: `/private/tmp`), and on Windows, which has
 * no `/tmp`, `%TEMP%` through the 8.3 short names it is often spelled with
 * (`C:\Users\RUNNER~1\…`). A write's target arrives realpath'd to the long
 * form, so a scratchpad kept in the short spelling would contain nothing
 * (pincer `01a303a`). Falls back to the spelling as given where resolution fails.
 */
export function resolveTmpRoot(platform: NodeJS.Platform = process.platform): string {
    return tryRealpath(platform === "win32" ? os.tmpdir() : "/tmp") ?? os.tmpdir();
}

/** The thread's scratchpad for a workspace root, derived the same way by every consumer. */
export function threadScratchpadDir(projectRoot: string, threadId: string): string {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return scratchpadDir(resolveTmpRoot(), uid, projectRoot, threadId);
}

/**
 * Create the scratchpad (owner-only on POSIX) and return it, or undefined when
 * it cannot be created. Created up front so the gate's roots resolve to a real
 * directory and the agent's first write into it needs no `mkdir`.
 */
export function ensureScratchpadDir(dir: string): string | undefined {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    } catch {
        return undefined;
    }
}

/**
 * The system prompt section that announces the scratchpad. Claude Code's
 * section in BI's own words, with the same coverage.
 */
export function scratchpadPromptSection(dir: string): string {
    return `# Scratchpad directory

Put temporary files in this directory, not in \`/tmp\`, another system temp directory or the user's project:
\`${dir}\`

It is the place for:
- intermediate results and data during a multi-step task
- throwaway scripts and configuration files
- output that does not belong in the user's project
- working files for an analysis
- anything that would otherwise go to \`/tmp\`

Use \`/tmp\` only when the user asks for it.

The directory belongs to this chat thread, is kept apart from the user's project, and writing to it rarely needs the user's approval.`;
}
