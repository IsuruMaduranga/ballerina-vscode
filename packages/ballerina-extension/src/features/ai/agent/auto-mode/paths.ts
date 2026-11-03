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
 * Path resolution and containment for the shell pre-gate (pure apart from fs
 * reads). `WRITING_TOOLS` names BI's own tools.
 *
 * Two fixes over the sandbox this derives from:
 *
 * 1. **The symlink leaf is inspected.** The original's
 *    ENOENT fallback joined literal basenames onto the nearest resolved
 *    ancestor without ever lstat-ing the leaf, so `ln -s /outside/x link`
 *    followed by `echo hi > link` resolved to `<project>/link` — inside the
 *    project — while bash wrote through the symlink to `/outside/x`.
 * 2. **Resolution failure is reported, not swallowed.** The original returned a
 *    best-effort path on failure, so the caller could not tell a real
 *    containment pass from a guess. Here an unresolvable path is `undefined`
 *    and every caller treats that as "not provably contained".
 */

import { type Dirent, lstatSync, readdirSync, readlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { isProtectedPath } from "./protected-paths";
import { isExecutionPrimitivePath, isSensitivePath } from "./sensitive";
import { comparablePath, expandTilde, gitBashPathToNative, isPathAtOrUnder, tryRealpath } from "./shared-paths";

/**
 * Tools whose calls write to a path. Lives here — the lowest shared layer both
 * the shell safety floor and the permission gate import — so the two write-gates
 * share one source of truth for "which tools write". The names are
 * `tools/text-editor.ts`'s `FILE_WRITE_TOOL_NAME` / `FILE_SINGLE_EDIT_TOOL_NAME`
 * / `FILE_BATCH_EDIT_TOOL_NAME`, spelled out because importing that module
 * would pull `vscode` into this leaf.
 */
export const WRITING_TOOLS = new Set(["file_write", "file_edit", "file_batch_edit"]);

export function isWritingTool(toolName: string): boolean {
    return WRITING_TOOLS.has(toolName);
}

/**
 * The path a file tool call targets (`file_path` for BI's file tools; `path`
 * and `notebook_path` for other tool shapes), or undefined. The one place
 * that knows the field names, shared by every path-based gate.
 */
export function pathArgument(input: Record<string, unknown> | undefined): string | undefined {
    const path = input?.path ?? input?.file_path ?? input?.notebook_path;
    return typeof path === "string" ? path : undefined;
}

/** The shared comparison form (lib/paths.ts): `/` separators, case-folded on darwin/win32. */
const normalize = comparablePath;

/**
 * Resolve a path for containment checks, following a symlink leaf that does not
 * yet have a target. Returns undefined when nothing about the path can be
 * resolved — callers must not treat that as contained.
 */
export function resolveForContainment(target: string): string | undefined {
    const resolved = resolveThroughLinks(target);
    return resolved === undefined ? undefined : normalize(resolved);
}

/**
 * {@link resolveForContainment} in the filesystem's own spelling (not
 * case-folded), for showing where a path lands.
 */
export function resolveThroughLinks(target: string, hops = 0): string | undefined {
    const absolute = resolve(target);

    const direct = tryRealpath(absolute);
    if (direct) { return direct; }

    // The leaf may be a dangling symlink: realpath fails on it, but writes still
    // follow it. Read the link and resolve its target instead of assuming the
    // literal path.
    try {
        const stats = lstatSync(absolute);
        // A link cycle (`a -> a`) stops at the kernel's usual 40 hops, then
        // resolves like any other leaf, below, instead of overflowing the stack.
        if (stats.isSymbolicLink() && hops < 40) {
            const linkTarget = readlinkSync(absolute);
            const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(absolute), linkTarget);
            // One hop is enough: the target's own realpath covers the rest of a chain.
            return resolveThroughLinks(resolvedTarget, hops + 1) ?? resolvedTarget;
        }
    } catch {
        // Does not exist yet — fall through to ancestor resolution below.
    }

    // A path being created (`> newfile`): resolve the nearest existing ancestor
    // and re-attach the tail, so a symlinked *parent* directory is still followed.
    const tail: string[] = [];
    let cursor = absolute;
    for (;;) {
        const parent = dirname(cursor);
        if (parent === cursor) { return undefined; }
        tail.unshift(basename(cursor));
        const realParent = tryRealpath(parent);
        if (realParent) { return join(realParent, ...tail); }
        cursor = parent;
    }
}

/** True only when `target` is provably at or under `base` (lib/paths.ts `isPathAtOrUnder`, argument order kept for the callers here). */
export function isWithin(base: string, target: string): boolean {
    return isPathAtOrUnder(target, base);
}

/**
 * Expand a leading `~`, then resolve relative to `cwd`. Kept separate from
 * resolveForContainment so callers can report the *original* token in messages:
 * a resolved path can embed an expanded environment-variable value, and echoing
 * that back to the model leaks the secret it was meant to protect.
 */
export function toAbsolute(cwd: string, token: string, home: string): string {
    if (token === "~") { return home; }
    if (token === "~" || token.startsWith("~/")) { return resolve(expandTilde(token, home)); }
    if (isAbsolute(token)) { return resolve(token); }
    return resolve(cwd, token);
}

/**
 * {@link toAbsolute} for a token taken from a bash command line. On Windows the
 * bash tool runs Git Bash, whose absolute paths are MSYS spellings — `/c/proj/f`
 * is `C:\proj\f`, `/tmp/f` sits under the user's temp dir — so the token is
 * converted first (lib/paths.ts gitBashPathToNative). `path.resolve` alone reads
 * `/c/proj/f` as `<cwd drive>:\c\proj\f`, which no gate recognises as the
 * project: the error fell towards escalate/prompt, never towards allow, but every
 * in-project write spelled that way went to the classifier. File-tool paths keep
 * `toAbsolute`: the file tools resolve them natively, and a gate must
 * judge the path the tool acts on, not the one Git Bash would reach.
 */
export function toAbsoluteBash(cwd: string, token: string, home: string): string {
    return toAbsolute(cwd, gitBashPathToNative(token), home);
}

/**
 * Whether moving, copying or removing `source` touches a path `guarded`
 * flags beneath it: walks `source` without following symlinks, at most
 * `budget` entries, and tests each entry's counterpart under `target` (the
 * same path for a removal). A walk that runs out of budget counts as touching
 * one, so the command is judged, not cleared. A file source walks nothing.
 * `guarded` also gets the source's directory entry (a symbolic link is one).
 */
export function touchesGuardedPath(source: string, target: string, guarded: (path: string, entry: Dirent) => boolean, budget = 5_000): boolean {
    const stack = [""];
    let seen = 0;
    while (stack.length > 0) {
        const relative = stack.pop() as string;
        let entries;
        try {
            entries = readdirSync(join(source, relative), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const child = join(relative, entry.name);
            if (++seen > budget || guarded(join(target, child), entry)) { return true; }
            if (entry.isDirectory()) { stack.push(child); }
        }
    }
    return false;
}

/**
 * The paths the shell gates' write checks guard: protected, beneath a
 * runtime-protected directory, a credential, or an execution primitive.
 * Shared by the bash and PowerShell gates so a write is guarded the same way
 * whichever shell spells it.
 */
export function isGuardedWritePath(path: string, cwd: string, protectedDirs: readonly string[] = []): boolean {
    return isProtectedPath(path, cwd) || protectedDirs.some((dir) => isWithin(dir, path)) || isSensitivePath(path) || isExecutionPrimitivePath(path);
}

/**
 * Whether removing or moving away `resolved` (spelled `absolute`) loses what
 * git or the gate would keep: a working root, a `.git`, a directory holding
 * one at any depth, or a guarded path or a directory holding one (`rm -rf .`,
 * `mv .git x`, `rm -rf vendor` over `vendor/lib/.git`, `rm -rf .vscode`).
 * `resolved` is a {@link resolveForContainment} form, and so is each of
 * `roots` ({@link containmentRoots}): resolved through links and case-folded
 * where the filesystem folds case.
 */
export function removalLoses(absolute: string, resolved: string, roots: readonly string[], cwd: string, protectedDirs: readonly string[] = []): boolean {
    const lost = (path: string) => path.split(/[\\/]/).includes(".git") || isGuardedWritePath(path, cwd, protectedDirs);
    // Folded here too, so a root passed in its configured spelling still matches.
    return roots.some((root) => normalize(root) === resolved) || lost(absolute) || lost(resolved) || touchesGuardedPath(resolved, resolved, lost);
}

/**
 * Working roots in {@link resolveForContainment} form, the form `removalLoses`
 * compares: the gates get the scratchpad as configured, not case-folded.
 */
export function containmentRoots(roots: readonly string[]): string[] {
    return roots.map((root) => resolveForContainment(root) ?? normalize(root));
}
