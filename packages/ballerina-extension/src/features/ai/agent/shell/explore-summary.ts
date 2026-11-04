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
 * What a shell command that only looked at the project did, in the file tools' terms: the directories
 * it listed, the patterns it searched for and the files it read. The transcript shows such a command
 * as a compact row ("Read 9 files", "Searched for TicketRecord") instead of a terminal card.
 *
 * Display only. The shell tool attaches it to a result only when the pre-gate proved the command
 * writes nothing, so this module names commands; it does not judge them. It reads options with the
 * gate's own tables (`auto-mode/read-only-options.ts`, `auto-mode/powershell-cmdlets.ts`), and any
 * command it cannot name gives undefined, which keeps the terminal card.
 *
 * Pure apart from the bash grammar (`auto-mode/bash-parser.ts`); undefined while it is not loaded.
 */

import { canonicalCommandName, powershellStatements, powershellWords } from "../auto-mode/powershell-rules";
import { isSwitchSpelling, parameterKind, READ_CMDLETS } from "../auto-mode/powershell-cmdlets";
import { checkFind, checkOptions, GIT_SUBCOMMAND_SPECS, PATTERN_OPTIONS, READ_ONLY_SPECS } from "../auto-mode/read-only-options";
import { gitSubcommand } from "../auto-mode/shell-analysis";
import { parseCommand, type Segment, type Token } from "../auto-mode/shell-parse";
import { expandCandidate } from "../tools/shell-reads";

/** Mirrored by the webview's `toolDisplay.ts ShellExploreSummary`. */
export interface ShellExploreSummary {
    /** Directories listed, as written; "." for the working directory. */
    listed: string[];
    /** Patterns searched for, as written. */
    searched: string[];
    /** Files read, as written, a glob in the last component expanded. */
    read: string[];
}

/** At most this many names per action reach the UI. */
const MAX_NAMES = 50;

// ── bash ──────────────────────────────────────────────────────────────────────

const LISTERS = new Set(["ls", "tree"]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg"]);
const READERS = new Set(["cat", "head", "tail", "nl"]);
/** Commands whose operands are not files: a label between the real steps. */
const LABELS = new Set(["echo", "printf", "pwd", "true"]);
const RECURSIVE = ["-r", "-R", "--recursive", "--dereference-recursive"];
/** head's and tail's value options: the gate's table for them accepts any option, so it does not say which take a value. */
const HEAD_TAIL_VALUES = new Set(["-n", "-c", "--lines", "--bytes"]);

/**
 * The summary of a bash command that only lists, searches and reads, or undefined for any other
 * command. `readdir` lists a directory relative to the working directory, to name the files a glob read.
 */
export function bashExploreSummary(command: string, readdir: (dir: string) => string[]): ShellExploreSummary | undefined {
    const parsed = parseCommand(command);
    if (parsed.parseFailed || parsed.background || parsed.definesFunction || parsed.substitutions.length > 0) { return undefined; }
    const summary = emptySummary();
    for (const segment of parsed.segments) {
        if (!describeBashSegment(segment, summary, readdir)) { return undefined; }
    }
    return finish(summary);
}

/** Adds what one simple command did to `summary`; false when the command is not a look. */
function describeBashSegment(segment: Segment, summary: ShellExploreSummary, readdir: (dir: string) => string[]): boolean {
    // Only a discarded stream may be redirected: `2>/dev/null`.
    if (segment.unknownTarget || segment.redirects.some((target) => target !== "/dev/null")) { return false; }
    if (segment.inputs.length > 0 || segment.stdin?.length) { return false; }
    const [head, ...args] = segment.tokens;
    // A redirect on a compound command gets a segment with no words.
    if (!head) { return true; }
    if (head.dynamic || head.glob || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head.value) || args.some((arg) => arg.dynamic)) { return false; }
    const name = head.value.split("/").pop() ?? "";
    if (LABELS.has(name)) { return true; }
    if (name === "git") { return describeGit(args, summary); }
    if (name === "find") {
        const find = checkFind(args);
        if (!find.ok) { return false; }
        summary.listed.push(...valuesOr(find.paths, "."));
        return true;
    }
    const spec = READ_ONLY_SPECS[name];
    if (!spec) { return false; }
    const check = checkOptions(spec, args);
    if (!check.ok) { return false; }
    const { positionals, seen } = check.parsed;
    if (SEARCHERS.has(name)) {
        // `rg --files` lists files and takes no pattern.
        if (name === "rg" && seen.has("--files")) {
            summary.listed.push(...valuesOr(positionals, "."));
            return true;
        }
        const fromOption = [...seen].some((option) => PATTERN_OPTIONS.has(option));
        const patterns = fromOption ? optionPatterns(args) : positionals.slice(0, 1).map((token) => token.value);
        const files = fromOption ? positionals : positionals.slice(1);
        // grep with no file and no recursion searches the pipe: a filter.
        if (name !== "rg" && files.length === 0 && !RECURSIVE.some((option) => seen.has(option))) { return true; }
        if (patterns.length === 0) { return false; }
        summary.searched.push(...patterns);
        return true;
    }
    if (LISTERS.has(name)) {
        summary.listed.push(...valuesOr(positionals, "."));
        return true;
    }
    if (READERS.has(name)) {
        // A reader with no file reads the pipe: a filter.
        const files = name === "head" || name === "tail" ? positionals.filter((token) => !HEAD_TAIL_VALUES.has(args[args.indexOf(token) - 1]?.value ?? "")) : positionals;
        for (const operand of files) {
            summary.read.push(...(operand.glob ? expandCandidate(operand.value, readdir) : [operand.value]));
        }
        return true;
    }
    // Any other read-only command (sort, wc, cut) is a filter on a pipe, but not on files of its own.
    return positionals.length === 0;
}

function describeGit(args: Token[], summary: ShellExploreSummary): boolean {
    const { sub, rest } = gitSubcommand(args);
    // A global `git -C dir` runs elsewhere: its paths are not the workspace's.
    const global = args.slice(0, args.length - rest.length - 1);
    if (global.some((arg) => arg.value === "-C") || (sub !== "ls-files" && sub !== "grep")) { return false; }
    const check = checkOptions(GIT_SUBCOMMAND_SPECS[sub], rest);
    if (!check.ok) { return false; }
    if (sub === "ls-files") {
        summary.listed.push(...valuesOr(check.parsed.positionals, "."));
        return true;
    }
    const fromOption = [...check.parsed.seen].some((option) => PATTERN_OPTIONS.has(option));
    const patterns = fromOption ? optionPatterns(rest) : valuesOr(check.parsed.positionals.slice(0, 1), "");
    if (patterns.length === 0 || patterns[0] === "") { return false; }
    summary.searched.push(...patterns);
    return true;
}

/** The patterns the `-e PAT`, `-ePAT`, `--regexp PAT` and `--regexp=PAT` options give; none for `-f FILE`. */
function optionPatterns(args: readonly Token[]): string[] {
    const patterns: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const { value } = args[i];
        if ((value === "-e" || value === "--regexp") && i + 1 < args.length) { patterns.push(args[++i].value); }
        else if (value.startsWith("--regexp=")) { patterns.push(value.slice("--regexp=".length)); }
        else if (/^-e./.test(value)) { patterns.push(value.slice(2)); }
    }
    return patterns;
}

function valuesOr(tokens: readonly { value: string }[], fallback: string): string[] {
    return tokens.length > 0 ? tokens.map((token) => token.value) : [fallback];
}

// ── PowerShell ────────────────────────────────────────────────────────────────

const PS_ROLES: Readonly<Record<string, "list" | "search" | "read">> = {
    "get-childitem": "list",
    "select-string": "search",
    "get-content": "read",
};

/** Cmdlets that only shape or count what the pipe carries. */
const PS_FILTERS = new Set(["select-object", "sort-object", "measure-object", "out-string", "format-table", "format-list", "format-wide", "get-location"]);

/** The summary of a PowerShell command that only lists, searches and reads, or undefined. */
export function powershellExploreSummary(command: string): ShellExploreSummary | undefined {
    // A subexpression, script block or redirect is more than a look.
    if (/[{}>]|\$\(/.test(command)) { return undefined; }
    const statements = powershellStatements(command);
    if (!statements || statements.length === 0) { return undefined; }
    const summary = emptySummary();
    for (const statement of statements) {
        const words = powershellWords(statement);
        if (!words || words.length === 0) { return undefined; }
        const cmdlet = canonicalCommandName(words[0]).toLowerCase();
        if (PS_FILTERS.has(cmdlet)) { continue; }
        const role = PS_ROLES[cmdlet];
        const operands = role && powershellOperands(cmdlet, words.slice(1));
        if (!operands) { return undefined; }
        // Select-String's first positional is the pattern; Get-ChildItem's second is its -Filter.
        const pattern = role === "search" ? operands.pattern ?? operands.positional.shift() : undefined;
        const positional = role === "list" ? operands.positional.slice(0, 1) : operands.positional;
        const paths = [...operands.named, ...positional];
        if (role === "list") {
            summary.listed.push(...(paths.length > 0 ? paths : ["."]));
        } else if (role === "search") {
            if (pattern === undefined) { return undefined; }
            summary.searched.push(pattern);
        } else {
            // Get-Content with no path reads the pipe.
            summary.read.push(...paths);
        }
    }
    return finish(summary);
}

/** A cmdlet's path and pattern operands, read with the gate's parameter table; undefined for a parameter it lacks. */
function powershellOperands(cmdlet: string, words: readonly string[]): { named: string[]; positional: string[]; pattern?: string } | undefined {
    const spec = READ_CMDLETS[cmdlet];
    const named: string[] = [];
    const positional: string[] = [];
    let pattern: string | undefined;
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!word.startsWith("-")) { positional.push(word); continue; }
        const colon = word.indexOf(":");
        const parameter = word.slice(1, colon === -1 ? undefined : colon);
        const kind = parameterKind(spec, parameter) ?? (isSwitchSpelling(spec, parameter) ? "switch" : undefined);
        if (!kind || kind === "scriptBlock") { return undefined; }
        if (kind === "switch") { continue; }
        const value = colon !== -1 ? word.slice(colon + 1) : words[++i];
        if (value === undefined) { return undefined; }
        if (kind === "path") { named.push(value); }
        if (parameter.toLowerCase() === "pattern") { pattern = value; }
    }
    return { named, positional, pattern };
}

// ── shared ────────────────────────────────────────────────────────────────────

function emptySummary(): ShellExploreSummary {
    return { listed: [], searched: [], read: [] };
}

/** Undefined when the command did none of the three; names deduplicated and capped. */
function finish(summary: ShellExploreSummary): ShellExploreSummary | undefined {
    const unique = (names: string[]) => [...new Set(names)].slice(0, MAX_NAMES);
    const result = { listed: unique(summary.listed), searched: unique(summary.searched), read: unique(summary.read) };
    return result.listed.length + result.searched.length + result.read.length > 0 ? result : undefined;
}
