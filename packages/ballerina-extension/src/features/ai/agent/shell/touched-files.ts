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
 * Which workspace files a shell command changed (design §9). Shell edits
 * bypass `persistLiveEdit`, so the shell tool stats the workspace before and
 * after a command that may write, and the caller registers each changed file
 * the way the file tools register theirs (`tools/shell-touched-files.ts`).
 *
 * A stat walk rather than `git status`: it sees a change to a file that was
 * already dirty, works outside a repository, and costs a few milliseconds on
 * a Ballerina project. It compares size and modification time, so an edit
 * that keeps both (a same-length rewrite within the filesystem's timestamp
 * resolution) is missed; decline-restore does not depend on this list, since
 * it restores the whole pre-generation snapshot.
 *
 * Pure apart from reading the directory tree: no `vscode` import.
 */

import { type Dirent, readdirSync, statSync } from "fs";
import { join } from "path";

/** Directories never walked: version control, dependencies and build output. */
export const SKIPPED_DIRS = new Set([".git", "node_modules", "target", ".idea"]);

/** The most files one walk records; past it the walk stops and says so. */
export const MAX_SNAPSHOT_FILES = 20_000;

export interface FileStamp {
    size: number;
    mtimeMs: number;
}

export interface WorkspaceSnapshot {
    /** Workspace-relative paths with `/` separators. */
    files: Map<string, FileStamp>;
    /** True when the walk hit `MAX_SNAPSHOT_FILES`; files past it are not compared. */
    truncated: boolean;
}

export interface TouchedFiles {
    created: string[];
    changed: string[];
    deleted: string[];
}

/** Stat every regular file under `root`, skipping `SKIPPED_DIRS` and symlinks. Never throws. */
export function snapshotWorkspace(root: string, maxFiles = MAX_SNAPSHOT_FILES): WorkspaceSnapshot {
    const files = new Map<string, FileStamp>();
    let truncated = false;
    const walk = (dir: string, prefix: string) => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (truncated) { return; }
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) { walk(join(dir, entry.name), rel); }
            } else if (entry.isFile()) {
                if (files.size >= maxFiles) {
                    truncated = true;
                    return;
                }
                try {
                    const stat = statSync(join(dir, entry.name));
                    files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
                } catch {
                    // Gone between readdir and stat: the next snapshot decides.
                }
            }
        }
    };
    walk(root, "");
    return { files, truncated };
}

/** The files created, changed or deleted between two snapshots, each sorted. */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): TouchedFiles {
    const created: string[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const [path, stamp] of after.files) {
        const previous = before.files.get(path);
        if (!previous) {
            // Past the first walk's cap, a file is unknown rather than new.
            if (!before.truncated) { created.push(path); }
        } else if (previous.size !== stamp.size || previous.mtimeMs !== stamp.mtimeMs) {
            changed.push(path);
        }
    }
    if (!after.truncated) {
        for (const path of before.files.keys()) {
            if (!after.files.has(path)) { deleted.push(path); }
        }
    }
    return { created: created.sort(), changed: changed.sort(), deleted: deleted.sort() };
}

export function hasTouchedFiles(touched: TouchedFiles): boolean {
    return touched.created.length + touched.changed.length + touched.deleted.length > 0;
}

/**
 * Packages the command created: each created `Ballerina.toml` names its
 * package directory, with the package's created `.bal` files relative to it.
 */
export function createdPackages(touched: TouchedFiles): { packageDir: string; balFiles: string[] }[] {
    return touched.created
        .filter((path) => path === "Ballerina.toml" || path.endsWith("/Ballerina.toml"))
        .map((toml) => {
            const packageDir = toml === "Ballerina.toml" ? "" : toml.slice(0, -"/Ballerina.toml".length);
            const prefix = packageDir ? `${packageDir}/` : "";
            const balFiles = touched.created
                .filter((path) => path.endsWith(".bal") && path.startsWith(prefix))
                .map((path) => path.slice(prefix.length));
            return { packageDir, balFiles };
        });
}
