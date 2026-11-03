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
 * The classifier transcript's `{"meta":{"resolvedPaths":…}}` line (pure apart
 * from filesystem reads): where a path the command names really lands, when a
 * symlink takes it out of the working directories.
 *
 * The classifier judges the command's text. `echo key >> notes.txt` reads as
 * an in-project write even when `notes.txt` is a symlink to
 * `~/.ssh/authorized_keys`, and the ruleset allows local file operations in
 * the project. So, just before the classifier runs, every constant word of
 * the command that names a path inside a working directory is resolved, and
 * each one that lands outside all of them is put directly above the command,
 * as the gitStatus line is (git-status-meta.ts). A command whose paths all
 * stay inside gets no line, so the payload of ordinary calls does not change.
 * The fact is measured here, never read from tool input.
 *
 * Only words the command spells are judged: a link inside a listed directory,
 * or a path computed at run time, is not seen.
 */

import { lstatSync, readlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { isWithin, resolveForContainment, toAbsolute, toAbsoluteBash } from "./paths";
import type { PowerShellParse } from "./powershell-parser";
import { powershellSeparators, powershellUnescaped } from "./powershell-paths";
import { powershellPathTokens } from "./safety-floor";
import { comparablePath, tryRealpath } from "./shared-paths";
import { parseCommand } from "./shell-parse";

/** One path the command names that resolves outside every working directory. */
export interface ResolvedPathFact {
    /** The word as the command spells it (quotes and escapes resolved). */
    path: string;
    /** Where it resolves through symlinks, in the filesystem's own spelling. */
    resolvesTo: string;
}

/** The line's own explanation: the ruleset has no sentence for it. */
export const RESOLVED_PATHS_NOTE =
    "Measured by the WSO2 Integrator Copilot, not written by the agent: the command under review names each path below as if it were " +
    "inside the working directory, but a symbolic link takes it to resolvesTo, outside every working directory. " +
    "Judge the command as reading or writing resolvesTo.";

/** The most words one command has resolved: a huge command must not stall the gate. */
const MAX_CANDIDATES = 256;
/** A longer word is not worth resolving; this also bounds the line, whose words the agent wrote. */
export const MAX_RESOLVED_WORD = 1_024;
/** The most paths the line reports: enough to show the command escapes, bounded so it cannot swell the prompt. */
export const MAX_RESOLVED_PATHS = 16;
/** A link cycle (`a -> a`) stops after the kernel's usual 40 hops. */
const MAX_LINK_HOPS = 40;

/**
 * Where `target` resolves through symlinks, in the filesystem's own spelling
 * (not case-folded), or undefined when no part of it resolves. A dangling
 * link leaf is followed to its target, and a path that does not exist yet is
 * resolved through its nearest existing ancestor. The same walk as
 * `paths.ts resolveForContainment`, which case-folds for comparison.
 */
export function resolveThroughLinks(target: string, hops = 0): string | undefined {
    const absolute = resolve(target);
    const direct = tryRealpath(absolute);
    if (direct) { return direct; }
    try {
        if (lstatSync(absolute).isSymbolicLink() && hops < MAX_LINK_HOPS) {
            const linkTarget = readlinkSync(absolute);
            const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(absolute), linkTarget);
            return resolveThroughLinks(resolvedTarget, hops + 1) ?? resolvedTarget;
        }
    } catch {
        // Does not exist yet: resolve through the nearest existing ancestor below.
    }
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

/** The constant words of a bash command line: every known token value, input and redirect target, and the value of `--opt=value`. */
export function bashPathCandidates(command: string): string[] {
    const words: string[] = [];
    for (const segment of parseCommand(command).segments) {
        for (const token of [...segment.tokens, ...segment.inputs]) {
            if (token.dynamic) { continue; }
            words.push(token.value);
            const eq = token.value.indexOf("=");
            if (token.value.startsWith("-") && eq > 0) { words.push(token.value.slice(eq + 1)); }
        }
        if (!segment.unknownTarget) { words.push(...segment.redirects); }
    }
    return words;
}

/**
 * The words of a parsed PowerShell command that may name a path: every
 * constant string value as PowerShell resolved it, also in the spelling
 * `-Path` unescapes, in this platform's separators.
 */
export function powershellParsePathCandidates(parse: PowerShellParse): string[] {
    const words: string[] = [];
    for (const node of parse.nodes) {
        if (node.type !== "StringConstantExpressionAst" || typeof node.value !== "string" || !node.value) { continue; }
        words.push(powershellSeparators(node.value));
        const unescaped = powershellUnescaped(node.value);
        if (unescaped !== node.value) { words.push(powershellSeparators(unescaped)); }
    }
    return words;
}

/**
 * The words of a PowerShell command line that may name a path, when there is
 * no parse (no PowerShell, a timeout, Constrained Language Mode). It is a
 * text split: the safety floor's path tokens (home expanded, `-Param:value`
 * unwrapped, `\` forward-slashed), plus every other word with its quotes
 * stripped, so a bare in-project name such as `notes.txt` is resolved too. A
 * quoted path with a space in it is split, so it is not seen.
 */
export function powershellPathCandidates(command: string, home: string): string[] {
    const words = powershellPathTokens(command, home);
    for (const raw of command.split(/[\s;|()]+/)) {
        const word = raw.replace(/^["']+|["',]+$/g, "");
        if (word && !word.startsWith("-") && !word.startsWith("$")) { words.push(word.replace(/\\/g, "/")); }
    }
    return words;
}

export interface ResolvedPathsOptions {
    /** The command's working directory. */
    cwd: string;
    home: string;
    /** Every working directory: the cwd and any other root the agent may write (the thread's scratchpad). */
    roots: readonly string[];
    /** How the words spell a path: `bash` reads Git Bash's `/c/…` on Windows; otherwise the platform's own. */
    spelling?: "bash";
}

/**
 * The words that name a path inside a working directory but resolve outside
 * all of them, or undefined when none does. A word that is outside as spelled
 * (`/etc/hosts`, `../x`) is left to the classifier's own reading of the text.
 */
export function resolvedPathFacts(words: readonly string[], opts: ResolvedPathsOptions): ResolvedPathFact[] | undefined {
    const roots = opts.roots.map((root) => resolveForContainment(root) ?? comparablePath(root));
    // A word may spell a root through the alias it was given as (`/var/…` for
    // `/private/var/…`): it names a path inside when it sits under either spelling.
    const spelledRoots = [...opts.roots, ...roots];
    const facts: ResolvedPathFact[] = [];
    const seen = new Set<string>();
    for (const word of words) {
        if (seen.size >= MAX_CANDIDATES || facts.length >= MAX_RESOLVED_PATHS) { break; }
        if (!word || word.length > MAX_RESOLVED_WORD || word.includes("\0") || seen.has(word)) { continue; }
        seen.add(word);
        const lexical = opts.spelling === "bash" ? toAbsoluteBash(opts.cwd, word, opts.home) : toAbsolute(opts.cwd, word, opts.home);
        if (!spelledRoots.some((root) => isWithin(root, lexical))) { continue; }
        const resolvesTo = resolveThroughLinks(lexical);
        if (resolvesTo === undefined || roots.some((root) => isWithin(root, comparablePath(resolvesTo)))) { continue; }
        facts.push({ path: word, resolvesTo });
    }
    return facts.length > 0 ? facts : undefined;
}

/** The facts for one shell command under review, or undefined when every path it names stays inside. */
export function shellResolvedPaths(
    tool: "shell" | "powershell",
    command: string,
    opts: Omit<ResolvedPathsOptions, "spelling">,
    powershellParse?: PowerShellParse,
): ResolvedPathFact[] | undefined {
    if (!command) { return undefined; }
    return tool === "powershell"
        ? resolvedPathFacts(powershellParse ? powershellParsePathCandidates(powershellParse) : powershellPathCandidates(command, opts.home), opts)
        : resolvedPathFacts(bashPathCandidates(command), { ...opts, spelling: "bash" });
}
