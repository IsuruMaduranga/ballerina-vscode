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
 * Semantic exit codes (pure apart from the shared Bash grammar): a nonzero exit that is not an error,
 * such as grep's "no match" or diff's "files differ". Claude Code reports these as plain output, and so
 * does the shell tool: a model that reads "Command failed (exit code 1)" after a search that found
 * nothing retries or works around a failure that never happened.
 *
 * Bash and PowerShell keep separate tables and separate rules for finding the final command. Either
 * way, an `&&` step right before the final command makes its exit untrusted: the failure may be the
 * earlier step's, not the search's.
 */

import type { Node as SyntaxNode } from "web-tree-sitter";
import { parseBash } from "../auto-mode/bash-parser";
import { EMPTY_OUTPUT_MARKER } from "./output";
import type { ExitJudge } from "./runner";

/** Which shell ran the command. */
export type ShellDialect = "bash" | "powershell";

const CONTAINERS = new Set(["program", "list", "pipeline"]);
const OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&", "\n"]);
const BASH_EXIT_ONE_SUCCESSES = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);

/** The longest command the Bash check parses; a longer one keeps its exit as a failure. */
const MAX_PARSED_COMMAND = 10_000;

function lastCommandChild(children: SyntaxNode[]): number {
    for (let i = children.length - 1; i >= 0; i--) {
        const type = children[i].type;
        if (!OPERATORS.has(type) && type !== "comment" && !type.endsWith("_redirect")) { return i; }
    }
    return -1;
}

/**
 * The rightmost command's text, or undefined when an `&&` comes right before it. Redirects and comments
 * are skipped, so `grep x f 2>/dev/null` is still a grep.
 */
function lastCommand(root: SyntaxNode): string | undefined {
    let node: SyntaxNode | undefined = root;
    while (node && (CONTAINERS.has(node.type) || node.type === "redirected_statement")) {
        const children = node.children;
        const last = lastCommandChild(children);
        if (last < 0) { return undefined; }
        if (node.type === "list" && children[last - 1]?.type === "&&") { return undefined; }
        node = children[last];
    }
    return node?.text;
}

/** git's global options that take their value as the next word (`--git-dir=x` is one word). */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

/** git's subcommand among the words after `git`: the first that is neither an option nor an option's value. */
export function gitSubcommandOf(args: readonly string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith("-")) { return args[i]; }
        if (GIT_VALUE_OPTIONS.has(args[i])) { i++; }
    }
    return undefined;
}

/**
 * Bash: whether exit 1 from this command is a success, because its final command is grep, rg, egrep,
 * fgrep, find, diff, test, `[`, `git grep` or `git diff`. False when the grammar is not loaded or the
 * command does not parse cleanly.
 */
export function bashExitOneIsSuccess(command: string): boolean {
    if (command.length > MAX_PARSED_COMMAND) { return false; }
    const tree = parseBash(command);
    if (!tree) { return false; }
    try {
        if (tree.rootNode.type !== "program" || tree.rootNode.hasError) { return false; }
        const last = lastCommand(tree.rootNode);
        if (last === undefined) { return false; }
        // The literal first word, as Claude Code matches it: no unwrapping of env, assignments or quotes.
        const [head, ...args] = last.trim().split(/\s+/);
        if (head !== "git") { return BASH_EXIT_ONE_SUCCESSES.has(head); }
        const sub = gitSubcommandOf(args);
        return sub === "grep" || sub === "diff";
    } finally {
        tree.delete();
    }
}

// PowerShell. The last segment splits on `;`, `|`, newlines, `&&` and a spaced `&`, outside quotes and
// comments; `&&` before it means an earlier step can explain the exit.
interface PowerShellSegment {
    text: string;
    andGated: boolean;
}

function lastPowerShellSegment(command: string): PowerShellSegment {
    const segments: PowerShellSegment[] = [];
    let start = 0;
    let andGated = false;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (inSingle) {
            if (c === "'") { inSingle = false; }
            continue;
        }
        if (inDouble) {
            if (c === "`") {
                i++;
            } else if (c === '"') {
                inDouble = false;
            }
            continue;
        }
        if (c === "#" && (i === 0 || " \t\n\r".includes(command[i - 1]))) {
            segments.push({ text: command.slice(start, i), andGated });
            while (i + 1 < command.length && command[i + 1] !== "\n" && command[i + 1] !== "\r") { i++; }
            start = i + 1;
            continue;
        }
        if (c === "'") {
            inSingle = true;
            continue;
        }
        if (c === '"') {
            inDouble = true;
            continue;
        }
        if (c === ";" || c === "|" || c === "\n" || c === "\r") {
            segments.push({ text: command.slice(start, i), andGated });
            start = i + 1;
            if (c !== "|") { andGated = false; }
            continue;
        }
        if (c === "&") {
            if (command[i + 1] === "&") {
                segments.push({ text: command.slice(start, i), andGated });
                i++;
                start = i + 1;
                andGated = true;
                continue;
            }
            const before = command[i - 1];
            if ((before === " " || before === "\t") && command.slice(start, i).trim() !== "") {
                segments.push({ text: command.slice(start, i), andGated });
                start = i + 1;
                andGated = false;
            }
        }
    }
    segments.push({ text: command.slice(start), andGated });
    for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].text.trim()) { return segments[i]; }
    }
    return { text: command, andGated: false };
}

/** A segment's first word, unquoted, and the text after it; a leading `&` or `.` call operator is dropped. */
function splitFirstWord(segment: string): { word: string; rest: string } {
    const line = segment.trim().replace(/^[&.]\s+/, "");
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(line);
    if (quoted) { return { word: quoted[1] ?? quoted[2], rest: line.slice(quoted[0].length) }; }
    const raw = line.split(/\s+/)[0] ?? "";
    return { word: raw.replace(/^["']|["']$/g, ""), rest: line.slice(raw.length) };
}

/** The command's file name, lowercased, without a native .exe/.cmd/.bat extension. */
function baseCommand(word: string): { base: string; nativeExt: string | undefined } {
    const file = (word.split(/[\\/]/).pop() || word).toLowerCase();
    const nativeExt = ["exe", "cmd", "bat"].find((ext) => file.endsWith(`.${ext}`));
    return { base: nativeExt ? file.slice(0, -(nativeExt.length + 1)) : file, nativeExt };
}

const exitOneOk = (code: number) => code === 0 || code === 1;
const POWERSHELL_SEMANTICS = new Map<string, (code: number) => boolean>([
    ["grep", exitOneOk],
    ["rg", exitOneOk],
    ["egrep", exitOneOk],
    ["fgrep", exitOneOk],
    ["findstr", exitOneOk],
    // robocopy's exit code is a bit mask: below 8 means nothing failed.
    ["robocopy", (code) => code >= 0 && code < 8],
]);
// Only as `<name>.exe` with output: bare `where` is Where-Object and bare `fc` is Format-Custom.
const POWERSHELL_EXE_WITH_OUTPUT = new Map<string, (code: number) => boolean>([
    ["where", exitOneOk],
    ["fc", exitOneOk],
    ["diff", exitOneOk],
]);
const NOT_RECOGNIZED = /is not recognized as (a name of a cmdlet|the name of a cmdlet|an? internal)/i;

/**
 * PowerShell: whether a nonzero exit is a success by the final command's table. `output` is stdout and
 * stderr merged, empty when the command printed nothing.
 */
export function powershellExitIsSuccess(command: string, exitCode: number, output: string): boolean {
    if (exitCode === 0) { return true; }
    const { text, andGated } = lastPowerShellSegment(command);
    const { word, rest } = splitFirstWord(text);
    const { base, nativeExt } = baseCommand(word);
    const sub = base === "git" ? gitSubcommandOf(rest.trim().split(/\s+/).filter(Boolean)) : undefined;
    const ok = sub === "grep" || sub === "diff"
        ? exitOneOk
        : (nativeExt === "exe" && output.trim() !== "" ? POWERSHELL_EXE_WITH_OUTPUT.get(base) : undefined) ?? POWERSHELL_SEMANTICS.get(base);
    if (!ok?.(exitCode)) { return false; }
    // A command that never ran, or findstr's own error, is a failure after all.
    return !(andGated || NOT_RECOGNIZED.test(output) || /CommandNotFoundException/.test(output) || /^FINDSTR: /m.test(output));
}

/**
 * The exit judge for one command (`runner.ts shellFinish`): true when this nonzero exit code is a
 * success. `output` is what the command printed; the runner's empty-output marker counts as nothing.
 */
export function exitJudgeFor(dialect: ShellDialect, command: string): ExitJudge {
    if (dialect === "bash") {
        let exitOne: boolean | undefined;
        return (exitCode) => exitCode === 1 && (exitOne ??= bashExitOneIsSuccess(command));
    }
    return (exitCode, output) => powershellExitIsSuccess(command, exitCode, output === EMPTY_OUTPUT_MARKER ? "" : output);
}
