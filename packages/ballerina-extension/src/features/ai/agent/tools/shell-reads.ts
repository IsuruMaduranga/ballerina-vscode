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
 * Files a bash command showed the agent in full, which then count as read for the read-before-edit
 * guard (`read-tracker.ts`); without this, an edit after `cat main.bal` is refused although the
 * whole file is in the transcript. A file counts when a line that runs a reader (`cat`, `head`,
 * `tail`, `sed`) names it, the command did not change it, and the model-facing output holds the
 * file's entire current content. That one check covers every way the agent could have seen less: a
 * pipe into `head`, `cat -n`, a slice, an output cut for size, a write later in the same command.
 * The stale-edit guard is unchanged, since the file is observed with that content.
 *
 * Pure apart from the bash grammar, which the caller's gate already awaited, and the file reads of
 * `shellReadSnapshot` and `recordShellReads`.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { toAbsoluteBash } from "../auto-mode/paths";
import { globComponentRegex, isUnknownTilde, movesDirectory, resolvePayload } from "../auto-mode/shell-analysis";
import { LOOPS, parseCommand, type ParseResult, scopedTracker, type Segment, type Token } from "../auto-mode/shell-parse";
import type { ReadTracker } from "./read-tracker";

/** Commands whose file arguments may print a whole file. */
const READERS = new Set(["cat", "head", "tail", "sed"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A word a reader may have printed, with the absolute directory the shell resolves it in. */
export interface ShellReadCandidate {
    word: string;
    dir: string;
}

/**
 * The files `command` may have printed, as written: the plain arguments of its reader commands,
 * plus every path-like word of a line that runs a reader at all. Candidates only, each still to be
 * checked with {@link shownInFull}. Each comes with the directory its reader runs in, starting from
 * `cwd` and following a literal `cd` ({@link segmentDirectories}); a reader whose directory cannot be
 * known offers nothing. Empty when no reader runs or the command does not parse.
 */
export function shellReadCandidates(command: string, cwd: string, home: string): ShellReadCandidate[] {
    const parsed = parseCommand(command);
    if (parsed.parseFailed) { return []; }
    const readers = parsed.segments.flatMap((segment, index) => {
        const first = segment.tokens.findIndex((token) => !ASSIGNMENT.test(token.value));
        if (first === -1) { return []; }
        const [head, ...args] = segment.tokens.slice(first);
        return head && !head.dynamic && READERS.has(head.value.split("/").pop() ?? "") ? [{ segment, index, args }] : [];
    });
    // Most commands run no reader: skip the directory walk for them.
    if (readers.length === 0) { return []; }
    const dirs = segmentDirectories(parsed, cwd, home);
    const candidates = new Map<string, ShellReadCandidate>();
    const add = (word: string, dir: string) => candidates.set(`${dir}\0${word}`, { word, dir });
    const readerDirs = new Set<string>();
    for (const { segment, index, args } of readers) {
        const dir = dirs[index];
        if (dir === undefined) { continue; }
        readerDirs.add(dir);
        if (segment.substitution !== undefined) { continue; }
        for (const arg of args) {
            if (isPlainPath(arg)) { add(arg.value, dir); }
        }
    }
    // A reader fed from a variable (`for f in a.bal b.bal; do cat "$f"; done`) names its files
    // elsewhere in the line. Every plain path-like word is a candidate then, in each directory a
    // reader ran in: the full-content check, not the parse, decides.
    if (readerDirs.size > 0) {
        const words = new Set<string>();
        for (const word of [...(command.match(PATH_WORD) ?? []), ...(command.match(GLOB_WORD) ?? [])]) {
            if (words.size < MAX_CANDIDATES) { words.add(word); }
        }
        for (const dir of [...readerDirs].slice(0, MAX_READER_DIRS)) {
            for (const word of words) { add(word, dir); }
        }
    }
    return [...candidates.values()];
}

/**
 * The absolute paths `command` may have printed: its candidates resolved as the shell resolves
 * them, from the directory each one's reader runs in, with a glob in the last component expanded
 * through `readdir`.
 */
export function shellReadPaths(command: string, cwd: string, home: string, readdir: (dir: string) => string[]): string[] {
    const paths = new Set<string>();
    for (const { word, dir } of shellReadCandidates(command, cwd, home)) {
        for (const name of expandCandidate(word, (sub) => readdir(toAbsoluteBash(dir, sub, home)))) {
            paths.add(toAbsoluteBash(dir, name, home));
        }
    }
    return [...paths];
}

/**
 * The directory each segment runs in, or undefined where it cannot be known. Only a plain
 * `cd <literal>` (or `cd -- <literal>`) that surely ran moves the commands after it in its own
 * subshell scope. Anything else that may change the directory makes the commands after it
 * unknown, never guessed: a dynamic, glob, `-` or `~user` target, an option, `pushd` and `popd`, a
 * `cd` that may not run (an `if` branch, after `&&` or `||`), a `cd` last in a pipeline, a
 * backgrounded line, `eval` and `source`, and a line that defines a function. A loop body runs
 * more than once, so after a move in any loop every command in a loop is unknown too. A miss costs
 * one re-read; a wrong directory would certify a read that never happened. (The reference also
 * follows a `cd` that may not run into the later members of its own `&&` list; this parse does not
 * record `&&` lists, so a read after such a `cd` is a miss here.)
 */
function segmentDirectories(parsed: ParseResult, cwd: string, home: string): (string | undefined)[] {
    const { segments } = parsed;
    const dirs = scopedTracker<string | undefined>(cwd);
    const inLoop = (segment: Segment) => segment.enclosing.some((construct) => LOOPS.has(construct));
    const moves = segments.map(mayMove);
    const loopMoves = segments.some((segment, index) => moves[index] && inLoop(segment));
    return segments.map((segment, index) => {
        const dir = loopMoves && inLoop(segment) ? undefined : dirs.get(segment);
        if (!moves[index]) { return dir; }
        const certain = !parsed.background && !parsed.definesFunction && !segment.pipelineShell && !segment.enclosing.includes("negated_command");
        const target = certain ? literalCdTarget(segment) : undefined;
        // A relative target from an unknown directory stays unknown; an absolute one re-anchors.
        const next = target === undefined ? undefined : dir === undefined && !isAbsoluteTarget(target) ? undefined : toAbsoluteBash(dir ?? cwd, target, home);
        if (segment.pipelineShell) { dirs.set({ scopes: segment.pipelineShell }, undefined); }
        dirs.set(segment, segment.conditional ? undefined : next);
        return dir;
    });
}

/** Whether a segment may change the shell's directory: a `cd`/`pushd`/`popd` in any spelling, or a script run in this shell. */
function mayMove(segment: Segment): boolean {
    return movesDirectory(segment) || ["eval", "source", "."].includes(resolvePayload(segment.tokens).command);
}

/** The target of `cd <word>` or `cd -- <word>` written plainly, or undefined for any other form. */
function literalCdTarget(segment: Segment): string | undefined {
    const [head, ...args] = segment.tokens;
    if (head?.value !== "cd" || head.dynamic) { return undefined; }
    const rest = args[0]?.value === "--" ? args.slice(1) : args;
    if (rest.length > 1) { return undefined; }
    const target = rest[0];
    // A bare `cd` goes home.
    if (!target) { return "~"; }
    if (target.dynamic || target.glob || target.value === "" || target.value.startsWith("-") || isUnknownTilde(target.value)) { return undefined; }
    return target.value;
}

/** Whether a `cd` target lands in the same place from any directory. */
function isAbsoluteTarget(target: string): boolean {
    return isAbsolute(target) || target === "~" || target.startsWith("~/");
}

/**
 * The files a candidate names: itself, or for a glob in its last component (`modules/*.bal`, a
 * loop's word list), the matching entries of that directory, listed through `readdir` (no shell).
 * Globs in a directory component are not expanded.
 */
export function expandCandidate(word: string, readdir: (dir: string) => string[]): string[] {
    if (!/[*?[]/.test(word)) { return [word]; }
    const slash = word.lastIndexOf("/");
    const dir = slash === -1 ? "" : word.slice(0, slash);
    if (/[*?[]/.test(dir)) { return []; }
    const pattern = globComponentRegex(word.slice(slash + 1));
    if (!pattern) { return []; }
    let names: string[];
    try {
        names = readdir(dir || ".");
    } catch {
        return [];
    }
    return names.filter((name) => !name.startsWith(".") && pattern.test(name)).map((name) => (dir ? `${dir}/${name}` : name)).slice(0, MAX_CANDIDATES);
}

/** A word that could be a file path as written, absolute or relative: no quoting, expansion or glob characters. */
const PATH_WORD = /(?<![\w$\-/])\/?[\w.@+~][\w.@+~/,-]*/g;
/** A word with a glob character, which the shell would expand (`modules/*.bal`). */
const GLOB_WORD = /(?<![\w$\-])[\w.@+~/,-]*[*?[][\w.@+~/,*?[\]-]*/g;
const MAX_CANDIDATES = 50;
/** The path-like words of a line are tried in at most this many reader directories. */
const MAX_READER_DIRS = 4;

function isPlainPath(token: Token): boolean {
    return !token.dynamic && !token.glob && token.value !== "" && !token.value.startsWith("-");
}

/**
 * Whether `output` shows the whole of `content`. Trailing whitespace is ignored because the shell
 * tool trims it. A tiny one-line file is never counted: its text turns up in outputs by chance (an
 * exit code, an error line), so the match would not show that the file was printed. A larger match
 * under another file's name still means every byte of the file was in front of the agent.
 */
export function shownInFull(output: string, content: string): boolean {
    const body = content.trimEnd();
    if (body.length < MIN_SHOWN_CHARS && !(body.includes("\n") && body.length >= MIN_SHOWN_LINES_CHARS)) { return false; }
    return output.includes(body);
}

/** A one-line file shorter than this is never counted as shown. */
const MIN_SHOWN_CHARS = 40;
/** A multi-line file shorter than this is never counted as shown. */
const MIN_SHOWN_LINES_CHARS = 16;
/** Above this a shell read's output is spilled to a file, not shown, so the file cannot have been seen whole. */
const MAX_SHELL_READ_BYTES = 256 * 1024;

/**
 * Before a bash command runs: the content of each regular file it may print, by absolute path.
 * Regular files only: a device or FIFO reports size 0 and a read of it never ends.
 */
export function shellReadSnapshot(command: string, cwd: string, home: string): Map<string, string> {
    const snapshot = new Map<string, string>();
    for (const path of shellReadPaths(command, cwd, home, (dir) => readdirSync(dir))) {
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > MAX_SHELL_READ_BYTES) { continue; }
            snapshot.set(resolve(path), readFileSync(path, "utf8"));
        } catch {
            // Gone or unreadable: nothing to count.
        }
    }
    return snapshot;
}

/**
 * After it ran: count as read each file of the snapshot the command did not change and whose whole
 * content the model-facing `output` holds. Returns the paths counted.
 */
export function recordShellReads(reads: ReadTracker, snapshot: Map<string, string>, output: string): string[] {
    const observed: string[] = [];
    for (const [path, before] of snapshot) {
        let current: string;
        try {
            current = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        if (current !== before || !shownInFull(output, current)) { continue; }
        reads.observe(path, current);
        observed.push(path);
    }
    return observed;
}
