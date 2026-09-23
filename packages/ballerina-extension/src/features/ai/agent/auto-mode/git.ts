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
 * Shared git helpers. Ported from pincer-agent `extensions/lib/git.ts` (tip
 * `2602e3c`) without `findProjectRoot` / `linkedWorktreeMainRoot`, which only
 * One Code's project identity used.
 */

/**
 * Global options for every git command the harness runs on its own (startup
 * git status, recoverability, consent checks, worktree bookkeeping). git
 * honours the checkout's own `.git/config`, and `core.fsmonitor` there names a
 * program that `status` and other index reads run — so a directory whose
 * `.git` came from an archive or a copied tree would run it the moment the
 * gate inspects it, before any prompt (SECURITY-REVIEW-2026-09-23 M5).
 * `--no-optional-locks` stops `status` rewriting the index, which would run the
 * checkout's `post-index-change` hook. The model's own git commands are judged
 * by the permission gate instead (auto-mode/git-checkout-programs.ts).
 */
export const HARNESS_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

import { execFile } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

/**
 * `git status` output for `cwd` with the given arguments, or undefined when
 * git could not say (not a repo, git missing, timeout). Asynchronous so the
 * tool_call hook it runs from does not stall the event loop; used for the
 * classifier transcript's gitStatus line (auto-mode/git-status-meta.ts).
 */
export function gitStatusOutput(cwd: string, args: readonly string[]): Promise<string | undefined> {
    return new Promise((resolvePromise) => {
        execFile("git", [...HARNESS_GIT_CONFIG, ...args], { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
            resolvePromise(error ? undefined : stdout);
        });
    });
}

/**
 * The nearest checkout root at or above `startDir`: the directory holding a
 * `.git` entry (a directory for a main checkout, a file for a linked worktree
 * or a submodule). This is the bound for walking up a checkout (context files,
 * banner listing); for the repository a directory *belongs to*, which linked
 * worktrees share with their main checkout, use `findProjectRoot`.
 */
export function findGitRoot(startDir: string): string | undefined {
    let dir = startDir;
    while (true) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * The git dir a checkout root's `.git` FILE points at (a linked worktree or a
 * submodule: `gitdir: <path>`), absolute; undefined when `.git` is a directory,
 * missing, or unreadable.
 */
export function gitdirFileTarget(root: string): string | undefined {
    const dotGit = join(root, ".git");
    try {
        if (!statSync(dotGit).isFile()) return undefined;
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
        if (!match) return undefined;
        return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
    } catch {
        return undefined;
    }
}
