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
 * The directories a read-only shell command may read besides the working
 * directory without the classifier (design §7, confirmed by the owner
 * 2026-09-23). Both pre-gates take this list (`shell-analysis.ts`
 * `readableRoots`, the PowerShell check). It widens reads only: writes and
 * deletes never consult it, and the sensitive list still applies inside it.
 *
 * Not in the list: the thread's chat history under
 * `~/.ballerina/copilot/workspaces/` (nothing here reads it, and it is a floor
 * target for writes) and `~/.ballerina/Settings.toml` (the Central access
 * token), which sits beside the bala cache rather than under it.
 */

import { join } from "path";
import { tryRealpath } from "./shared-paths";

export interface ReadableRootsInput {
    home: string;
    /** The thread's scratchpad (`shell/scratchpad.ts`), when one was created. */
    scratchpadDir?: string;
    /**
     * The Ballerina home, where `bal` keeps its caches: `BALLERINA_HOME_DIR`
     * when the user's environment sets it, else `~/.ballerina` (as
     * `utils/bir-cache-recovery.ts` resolves it). Never a workspace setting.
     */
    ballerinaHome?: string;
}

/** The Ballerina home from the environment, as `bal` resolves it. */
export function ballerinaHomeFromEnv(home: string, env: Record<string, string | undefined> = process.env): string {
    const fromEnv = env.BALLERINA_HOME_DIR;
    return fromEnv && fromEnv.length > 0 ? fromEnv : join(home, ".ballerina");
}

/**
 * The readable roots, each realpath-resolved once (the gate compares them
 * against realpaths); a root that does not exist yet keeps its spelling.
 */
export function readableRoots({ home, scratchpadDir, ballerinaHome = join(home, ".ballerina") }: ReadableRootsInput): string[] {
    const roots = [
        scratchpadDir,
        // The downloaded bala cache: the sources of every library the project uses.
        join(ballerinaHome, "repositories"),
        // The Librarian's rendered docs: `utils/libs/lib-docs-cache.ts` LIB_DOCS_ROOT,
        // spelled out because importing that module would widen this leaf.
        join(home, ".ballerina", "copilot", "lib-docs"),
    ];
    return roots.filter((root): root is string => !!root).map((root) => tryRealpath(root) ?? root);
}
