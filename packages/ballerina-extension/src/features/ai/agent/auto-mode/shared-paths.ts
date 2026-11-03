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
 * Path helpers shared by the shell gate and the shell runner (pure apart from `tryRealpath`).
 *
 * No agent config-directory helpers are included here. Every containment check in the gate
 * compares {@link comparablePath} forms, so "under this directory" means one thing everywhere.
 * The MSYS helpers come along inert: no bash runs on Windows here, so `gitBashPathToNative`
 * never converts anything the Copilot passes it.
 */

import { realpathSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";

/**
 * Shell-style `~` expansion with one semantics everywhere: a bare `~` is `home`, `~/x` is under
 * it, and `~user` is left alone (no other user's home is ever guessed). Anything else is
 * returned unchanged.
 */
export function expandTilde(path: string, home: string): string {
    if (path === "~") { return home; }
    if (path.startsWith("~/")) { return join(home, path.slice(2)); }
    return path;
}

/**
 * A path with forward slashes, in Claude Code's POSIX shape on Windows: `C:\Users\x` becomes
 * `/c/Users/x`, a UNC `\\server\share` becomes `//server/share`, anything else only flips its
 * separators. Elsewhere the path is unchanged.
 */
export function toPosixPath(path: string): string {
    if (process.platform !== "win32") { return path; }
    if (path.startsWith("\\\\")) { return path.replace(/\\/g, "/"); }
    const drive = /^([A-Za-z]):[/\\]/.exec(path);
    if (drive) { return `/${drive[1].toLowerCase()}${path.slice(2).replace(/\\/g, "/")}`; }
    return path.replace(/\\/g, "/");
}

/**
 * The inverse conversion, for a path spelled the way Git Bash (MSYS2) spells it, on every
 * platform (pure; `gitBashPathToNative` is the win32-gated form): `/c/Users/x` is `C:\Users\x`,
 * `/cygdrive/c/x` is `C:\x`, and `/tmp/x` is `<tmp>\x` because Git for Windows mounts `/tmp` on
 * the user's temp dir. Every other POSIX absolute path and every non-POSIX path is returned as
 * given.
 */
export function msysPathToWindows(path: string, tmp: string): string {
    const drive = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(path);
    if (drive) { return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`; }
    const temp = /^\/tmp(?:\/(.*))?$/.exec(path);
    if (temp) { return temp[1] ? join(tmp, temp[1]) : tmp; }
    return path;
}

/**
 * A token from a bash command line as the path it reaches on this machine: on Windows a bash
 * would be Git Bash, so its MSYS spellings are converted ({@link msysPathToWindows}); elsewhere
 * the token is unchanged. For bash tokens only; never apply it to file-tool or PowerShell paths.
 */
export function gitBashPathToNative(token: string): string {
    return process.platform === "win32" ? msysPathToWindows(token, tmpdir()) : token;
}

/**
 * A Windows system executable by its canonical location, `%SystemRoot%\System32\<name>`
 * (defaulting to `C:\Windows`), so a PATH entry can never substitute it: `taskkill.exe`,
 * `cmd.exe`, Windows PowerShell's `powershell.exe`.
 */
export function system32Path(name: string, env: Record<string, string | undefined> = process.env): string {
    return join(env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/**
 * The real path of `target`, or undefined when nothing about it resolves: the native realpath
 * first (on Windows it also expands 8.3 short names and fixes the case), the JS one as a
 * fallback. Shared by every containment resolver so "resolved" means one thing.
 */
export function tryRealpath(target: string): string | undefined {
    try {
        return realpathSync.native(target);
    } catch {
        try {
            return realpathSync(target);
        } catch {
            return undefined;
        }
    }
}

/** `path` as given when absolute, else joined onto `base` (no `..` normalisation, so the spelling stays recognisable). */
export function absoluteFrom(base: string, path: string): string {
    return isAbsolute(path) ? path : join(base, path);
}

/** Separators as `/`, whatever the platform, for display and for `/`-spelled comparisons. */
export function forwardSlashes(path: string): string {
    return path.replace(/\\/g, "/");
}

/** Filesystems that fold case (darwin, win32): two spellings of one path compare equal. */
export function foldsCase(): boolean {
    return process.platform !== "linux";
}

/**
 * The one comparison form of a path: resolved, `/` separators on Windows, no trailing slash, case-folded
 * where the filesystem folds (darwin, win32).
 */
export function comparablePath(path: string): string {
    const absolute = resolve(path);
    // Backslashes separate Windows paths, but name literal sibling files on POSIX.
    const normalized = (process.platform === "win32" ? forwardSlashes(absolute) : absolute).replace(/\/+$/, "");
    return foldsCase() ? normalized.toLowerCase() : normalized;
}

/** Whether `path` is at or under `dir`, on {@link comparablePath} forms. No symlink resolution; resolve both sides first when that matters. */
export function isPathAtOrUnder(path: string, dir: string): boolean {
    const target = comparablePath(path);
    const base = comparablePath(dir);
    return target === base || target.startsWith(`${base}/`);
}

/** A `path.relative` result that stays inside its base: non-empty, no `..` hop, not another root or drive. */
export function isRelativeInside(rel: string): boolean {
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `~`-abbreviated display form of a path: the home dir itself is `~`, a path under it is
 * `~/rest` with forward slashes, anything else is returned as given.
 */
export function tildify(path: string, home: string): string {
    if (!home) { return path; }
    const rest = relative(resolve(home), resolve(path));
    if (rest === "") { return "~"; }
    return isRelativeInside(rest) ? `~/${forwardSlashes(rest)}` : path;
}
