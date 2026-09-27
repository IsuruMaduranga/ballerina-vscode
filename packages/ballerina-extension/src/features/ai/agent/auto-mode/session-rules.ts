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
 * The "Allow for this session" rules of the shell approval banner (design
 * §10), for the bash tool. A rule is either the exact command the user
 * approved or a word prefix of it (`bal build`, `npm run test`). Matching
 * follows Claude Code's allow semantics: an exact rule covers the
 * identical line; a prefix rule covers a line only when every subcommand of it
 * starts with some prefix rule's words, and never a line carrying injection or
 * other unmodelled syntax.
 *
 * Three narrowings, each toward asking more:
 * - a prefix is matched word by word after quote removal, not by string, so
 *   `bal build` cannot cover `bal build-x` or the one word `"bal build"`;
 * - a prefix never covers a subcommand with a redirection, a wrapper
 *   (`env`, `timeout`, …), a leading assignment or a subshell, nor a line the
 *   pre-gate found touching a sensitive, protected or execution-primitive
 *   path or writing outside the workspace;
 * - no rule at all is offered for a destructive or outward-facing command
 *   (`rm`, `git push`, `bal push`, …), and only the exact command is offered
 *   for anything that writes, reaches the network, or runs an interpreter.
 *
 * Pure: the only I/O is an existence check that stops a prefix at an operand
 * naming a file in the working directory.
 */

import { existsSync } from "fs";
import { join, sep } from "path";
import { isProtectedPath } from "./protected-paths";
import {
    canonicalCommandName,
    powershellInjectionSyntax,
    powershellStatements,
    powershellWords,
    statementCommand,
} from "./powershell-rules";
import { isExecutionPrimitivePath, isSensitivePath } from "./sensitive";
import { isWithin, resolveForContainment, toAbsolute } from "./paths";
import { hasUnmodelledSyntax, leadTokens, parseCommand, resolvePayload, type Segment, type ShellEvidence } from "./shell-analysis";

export interface SessionRule {
    kind: "exact" | "prefix";
    /** The exact command line, or the prefix's words joined by single spaces. */
    command: string;
}

export interface SessionRuleGrant {
    rule: SessionRule;
    /** The banner option's label, naming what the rule covers. */
    label: string;
}

/** The most words a suggested prefix takes (`npm run test`). */
const MAX_PREFIX_WORDS = 3;

/** A word that can be a subcommand name: no path separator, dot, quote or flag. */
const PLAIN_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Redirections that write nowhere a rule could matter: the null device and fd duplication. */
const HARMLESS_REDIRECT = /^(\/dev\/null|&[0-9]+|&-)$/;

/**
 * Commands that delete, overwrite history, change permissions, stop processes,
 * escalate privileges or publish. No session rule is offered for them: each
 * run is its own decision.
 */
const DESTRUCTIVE_COMMANDS = new Set([
    "rm", "rmdir", "unlink", "shred", "dd", "truncate", "mkfs", "fdisk", "diskutil",
    "chmod", "chown", "chgrp", "kill", "pkill", "killall", "sudo", "su", "doas",
    "crontab", "launchctl", "systemctl", "gh",
]);

/** Subcommands that make these commands destructive or outward-facing. */
const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
    git: new Set([
        "push", "reset", "clean", "checkout", "restore", "switch", "rebase", "branch", "tag", "stash", "rm",
        "filter-branch", "filter-repo", "gc", "prune", "reflog", "update-ref", "worktree", "remote", "config",
    ]),
    bal: new Set(["push"]),
    npm: new Set(["publish", "unpublish", "deprecate", "owner", "access", "token"]),
    pnpm: new Set(["publish"]),
    yarn: new Set(["publish", "npm"]),
    docker: new Set(["push", "rm", "rmi", "prune", "system", "volume", "login"]),
};

/**
 * Interpreters and runners whose arguments are code. A prefix over one grants
 * whatever the next word runs, so they get a prefix only when it names a
 * script or subcommand past the runner's own escape hatch (`npm run test`,
 * never `npm run` or `python`). Trimmed to the bash names.
 */
const RUNNERS = new Set([
    "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "osascript", "bash", "sh", "zsh", "fish",
    "pwsh", "eval", "exec", "env", "xargs", "nohup", "setsid", "timeout", "make", "npx", "pnpx", "bunx",
    "yarn", "npm", "pnpm", "uv", "uvx", "pip", "pip3", "poetry", "cargo", "go", "dotnet", "java", "mvn",
    "gradle", "docker", "kubectl", "ssh",
]);

/** A runner's words that hand the next word to it as code or a package to fetch and run. */
const RUNNER_ESCAPES = new Set(["run", "exec", "x", "dlx", "-c", "-e"]);

/** The words a segment starts with, when it is a plain command a prefix may cover; undefined otherwise. */
function plainWords(seg: Segment): string[] | undefined {
    if (
        seg.redirects.some((target) => !HARMLESS_REDIRECT.test(target)) ||
        seg.inputs.length > 0 ||
        seg.enclosing.length > 0 ||
        seg.substitution !== undefined ||
        seg.unknownTarget ||
        seg.expandsIntoInput
    ) { return undefined; }
    const lead = leadTokens(seg);
    // A prefix covers only a visible, top-level command. `leadTokens` peels
    // wrappers for analysis, so a changed head proves the syntax was not plain.
    if (lead.length === 0 || lead.length !== seg.tokens.length || lead[0].value !== seg.tokens[0].value) { return undefined; }
    const payload = resolvePayload(lead);
    if (payload.peeled.length > 0 || payload.command !== lead[0].value) { return undefined; }
    // The tree walker distinguishes literal quoted words from values that are
    // unknown until bash runs. Quoted `"--offline"` remains a normal argument;
    // `$flag`, `$(command)` and `<(command)` do not inherit a standing prefix.
    if (lead.some((token) => token.dynamic !== undefined)) { return undefined; }
    return lead.map((token) => token.value);
}

function isDestructive(words: string[]): boolean {
    const [head, ...rest] = words;
    if (!head) { return false; }
    if (DESTRUCTIVE_COMMANDS.has(head) || /^mkfs\./.test(head)) { return true; }
    const subcommands = DESTRUCTIVE_SUBCOMMANDS[head];
    if (!subcommands) { return false; }
    // Any later word counts, so `git -C x push` is caught; a false hit only drops the offer.
    return rest.some((word) => subcommands.has(word));
}

/** Whether the pre-gate saw anything a standing rule must never cover. */
function touchesGuardedPaths(evidence: ShellEvidence): boolean {
    return (
        evidence.sensitivePaths.length > 0 ||
        evidence.protectedPaths.length > 0 ||
        evidence.executionPrimitives.length > 0 ||
        evidence.writes.some((write) => write.outsideCwd)
    );
}

/**
 * The rule the banner offers for a command the user is being asked about, or
 * undefined when none should be offered. `evidence` is the pre-gate's analysis
 * of the same command.
 */
export function suggestSessionRule(command: string, evidence: ShellEvidence, cwd: string): SessionRuleGrant | undefined {
    const trimmed = command.trim();
    if (!trimmed) { return undefined; }
    const parsed = parseCommand(trimmed);
    const { segments, parseFailed, complex, unknownQuoting, background } = parsed;
    if (parseFailed || complex || unknownQuoting || background || segments.length === 0) { return undefined; }
    // Destructive anywhere in the line, however it is spelled: no rule.
    for (const seg of segments) {
        const payload = resolvePayload(leadTokens(seg));
        if (isDestructive([payload.command, ...payload.args.map((token) => token.value)])) { return undefined; }
    }
    if (touchesGuardedPaths(evidence)) { return undefined; }

    const exact: SessionRuleGrant = {
        rule: { kind: "exact", command: trimmed },
        label: "Allow this exact command for this session",
    };
    if (segments.length !== 1 || hasUnmodelledSyntax(trimmed, parsed) || evidence.writes.length > 0 || evidence.network.length > 0) {
        return exact;
    }
    const words = plainWords(segments[0]);
    if (!words) { return exact; }

    const prefix: string[] = [];
    for (const word of words) {
        if (prefix.length === MAX_PREFIX_WORDS || !PLAIN_WORD.test(word)) { break; }
        // An operand naming a file or directory here is an argument, not a subcommand.
        if (prefix.length > 0 && existsSync(join(cwd, word))) { break; }
        prefix.push(word);
    }
    // One word would cover every subcommand of a CLI (`bal` covers `bal push`).
    if (prefix.length < 2) { return exact; }
    if (RUNNERS.has(prefix[0])) {
        // `npm run test` names the script; `npm run` or `python -c` would hand over code.
        const last = prefix[prefix.length - 1];
        if (RUNNER_ESCAPES.has(last)) { return exact; }
    }
    const text = prefix.join(" ");
    return { rule: { kind: "prefix", command: text }, label: `Allow \`${text}\` commands for this session` };
}

/**
 * The session rule that lets this command run, or undefined. An exact rule
 * covers the identical line. Prefix rules cover the line only when every
 * subcommand is a plain command starting with some rule's words and the
 * pre-gate saw no guarded path.
 */
export function matchSessionRule(rules: readonly SessionRule[], command: string, evidence: ShellEvidence): SessionRule | undefined {
    const trimmed = command.trim();
    if (!trimmed) { return undefined; }
    const exact = rules.find((rule) => rule.kind === "exact" && rule.command === trimmed);
    if (exact) { return exact; }

    const prefixes = rules.filter((rule) => rule.kind === "prefix");
    if (prefixes.length === 0 || touchesGuardedPaths(evidence)) { return undefined; }
    const parsed = parseCommand(trimmed);
    const { segments, parseFailed, complex, unknownQuoting, background } = parsed;
    if (parseFailed || complex || unknownQuoting || background || segments.length === 0 || hasUnmodelledSyntax(trimmed, parsed)) { return undefined; }
    let first: SessionRule | undefined;
    for (const seg of segments) {
        const words = plainWords(seg);
        if (!words || isDestructive(words)) { return undefined; }
        const rule = prefixes.find((candidate) => {
            const ruleWords = candidate.command.split(" ");
            return ruleWords.length <= words.length && ruleWords.every((word, index) => words[index] === word);
        });
        if (!rule) { return undefined; }
        first ??= rule;
    }
    return first;
}

/** Add a rule unless an identical one is already there. Returns the new list. */
export function addSessionRule(rules: readonly SessionRule[], rule: SessionRule): SessionRule[] {
    return rules.some((existing) => existing.kind === rule.kind && existing.command === rule.command) ? [...rules] : [...rules, rule];
}

// ---------------------------------------------------------------------------
// PowerShell

/**
 * The path context that makes a standing PowerShell prefix safe. The gate owns
 * these values and resolves any scratchpad roots once per run. A caller that
 * omits it gets an exact-only grant; a prefix never falls back to an assumed
 * current directory.
 */
export interface PowerShellSessionRuleContext {
    cwd: string;
    home: string;
    /** Resolved directories a command may write to besides the workspace. */
    writableRoots?: readonly string[];
}

/**
 * Cmdlets that delete, stop, overwrite state or run other code; no session
 * rule is offered for a line containing one, however it is aliased.
 */
const DESTRUCTIVE_CMDLETS = new Set([
    "remove-item", "remove-itemproperty", "clear-content", "clear-item", "clear-recyclebin", "stop-process", "stop-service",
    "stop-computer", "restart-computer", "format-volume", "clear-disk", "set-executionpolicy", "invoke-expression",
    "invoke-command", "start-process", "start-job", "new-service", "register-scheduledtask", "set-mppreference", "add-mppreference",
]);

/** These change where later statements resolve relative paths; prefix matching does not track that state. */
const DIRECTORY_CMDLETS = new Set(["set-location", "push-location", "pop-location"]);

/** The command words PowerShell passes to a native command, canonical at index zero. */
function powerShellWords(statement: string): string[] | undefined {
    const words = powershellWords(statement);
    if (!words || words.length === 0) { return undefined; }
    return [canonicalCommandName(words[0]).toLowerCase(), ...words.slice(1)];
}

/**
 * A session prefix is never allowed to reach a target outside the workspace or
 * designated scratchpad roots, nor a secret, protected configuration or an
 * execution primitive. PowerShell's command metadata is too broad to model
 * safely, so each static argument is treated as a possible target. This only
 * withholds a prefix; the user can still approve the exact command.
 */
function powerShellTargetsAreGuarded(words: readonly string[], context: PowerShellSessionRuleContext): boolean {
    const roots = [resolveForContainment(context.cwd) ?? context.cwd, ...(context.writableRoots ?? [])];
    for (const word of words.slice(1)) {
        const colon = word.startsWith("-") ? word.indexOf(":") : -1;
        const equals = word.startsWith("-") ? word.indexOf("=") : -1;
        // Both `-Path:value` and native-style `--output=value` bind a value
        // in one token. Treat either as a potential target rather than letting
        // a prefix carry an unexamined absolute path.
        const value = word.startsWith("-")
            ? (colon > 0 ? word.slice(colon + 1) : equals > 0 ? word.slice(equals + 1) : "")
            : word;
        if (!value) { continue; }
        // Command flags do not name targets. A wildcard can expand onto a
        // protected or secret file, so no prefix vouches for one.
        if (value.startsWith("-")) { continue; }
        if (/[*?[]/.test(value) || /^[A-Za-z]:(?![\\/])/.test(value) || value.startsWith("\\\\") || value.startsWith("//")) { return true; }
        const spelled = sep === "/" ? value.replaceAll("\\", "/") : value;
        const absolute = toAbsolute(context.cwd, spelled, context.home);
        const resolved = resolveForContainment(absolute);
        if (
            isSensitivePath(value) ||
            isSensitivePath(resolved ?? absolute) ||
            isProtectedPath(value, context.cwd) ||
            isProtectedPath(resolved ?? absolute, context.cwd) ||
            isExecutionPrimitivePath(value) ||
            isExecutionPrimitivePath(resolved ?? absolute) ||
            resolved === undefined ||
            !roots.some((root) => isWithin(root, resolved))
        ) { return true; }
    }
    return false;
}

/** The prefix portion of a single, static PowerShell statement, if it is narrow enough. */
function powerShellPrefix(words: readonly string[], context: PowerShellSessionRuleContext): string | undefined {
    if (powerShellTargetsAreGuarded(words, context)) { return undefined; }
    const prefix: string[] = [];
    for (const word of words) {
        if (prefix.length === MAX_PREFIX_WORDS || !PLAIN_WORD.test(word)) { break; }
        if (prefix.length > 0 && existsSync(join(context.cwd, word))) { break; }
        prefix.push(word);
    }
    if (prefix.length < 2) { return undefined; }
    if (RUNNERS.has(prefix[0]) && RUNNER_ESCAPES.has(prefix[prefix.length - 1])) { return undefined; }
    return prefix.join(" ");
}

/**
 * The session rule offered for a PowerShell command. A destructive or dynamic
 * line gets no rule. A safe one-statement line gets a canonical, per-statement
 * prefix only when the caller supplies containment context; all other lines
 * retain the exact-command grant.
 */
export function suggestPowerShellSessionRule(command: string, context?: PowerShellSessionRuleContext): SessionRuleGrant | undefined {
    const trimmed = command.trim();
    if (!trimmed || powershellInjectionSyntax(trimmed)) { return undefined; }
    const statements = powershellStatements(trimmed);
    if (!statements || statements.length === 0) { return undefined; }
    const wordsByStatement = statements.map(powerShellWords);
    if (wordsByStatement.some((words) => !words)) { return undefined; }
    for (const [index, statement] of statements.entries()) {
        const cmd = statementCommand(statement);
        const words = wordsByStatement[index] as string[];
        if (DESTRUCTIVE_CMDLETS.has(cmd) || isDestructive(words)) { return undefined; }
    }
    const exact: SessionRuleGrant = { rule: { kind: "exact", command: trimmed }, label: "Allow this exact command for this session" };
    if (!context || statements.length !== 1 || DIRECTORY_CMDLETS.has(statementCommand(statements[0]))) { return exact; }
    const prefix = powerShellPrefix(wordsByStatement[0] as string[], context);
    return prefix ? { rule: { kind: "prefix", command: prefix }, label: `Allow \`${prefix}\` commands for this session` } : exact;
}

/**
 * A PowerShell prefix matches every visible statement, after canonicalizing
 * aliases and casing. Exact grants remain literal user approvals. Prefixes
 * refuse dynamic syntax and guarded targets even when an earlier command in
 * the same line has a matching rule.
 */
export function matchPowerShellSessionRule(rules: readonly SessionRule[], command: string, context?: PowerShellSessionRuleContext): SessionRule | undefined {
    const trimmed = command.trim();
    if (!trimmed) { return undefined; }
    const exact = rules.find((rule) => rule.kind === "exact" && rule.command === trimmed);
    if (exact) { return exact; }
    if (!context || powershellInjectionSyntax(trimmed)) { return undefined; }
    const prefixes = rules.filter((rule) => rule.kind === "prefix");
    const statements = powershellStatements(trimmed);
    if (prefixes.length === 0 || !statements || statements.length === 0) { return undefined; }
    let first: SessionRule | undefined;
    for (const statement of statements) {
        const words = powerShellWords(statement);
        if (!words || DIRECTORY_CMDLETS.has(statementCommand(statement)) || DESTRUCTIVE_CMDLETS.has(statementCommand(statement)) || isDestructive(words) || powerShellTargetsAreGuarded(words, context)) { return undefined; }
        const rule = prefixes.find((candidate) => {
            const ruleWords = candidate.command.split(" ");
            return ruleWords.length <= words.length && ruleWords.every((word, index) =>
                index === 0 ? words[index].toLowerCase() === word.toLowerCase() : words[index] === word,
            );
        });
        if (!rule) { return undefined; }
        first ??= rule;
    }
    return first;
}
