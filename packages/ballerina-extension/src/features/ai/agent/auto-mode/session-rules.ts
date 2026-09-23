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
 * follows Claude Code's allow semantics as pincer-agent ports them
 * (`permissions/matcher.ts findBashAllowRule`): an exact rule covers the
 * identical line; a prefix rule covers a line only when every subcommand of it
 * starts with some prefix rule's words, and never a line carrying injection or
 * other unmodelled syntax.
 *
 * BI narrows pincer in three ways, each toward asking more:
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
import { join } from "path";
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
 * never `npm run` or `python`). pincer's `INTERPRETERS_AND_RUNNERS`, trimmed to
 * the bash names.
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
    if (seg.redirects.some((target) => !HARMLESS_REDIRECT.test(target))) { return undefined; }
    const lead = leadTokens(seg);
    // leadTokens strips subshell parens and `do`/`then` keywords; a prefix covers neither.
    if (lead.length === 0 || lead.length !== seg.tokens.length || lead[0].value !== seg.tokens[0].value) { return undefined; }
    const payload = resolvePayload(lead);
    // A wrapper or a leading `VAR=value` changes what runs.
    if (payload.peeled.length > 0 || payload.command !== lead[0].value) { return undefined; }
    return lead.map((token) => (token.hadExpansion ? "\0" : token.value));
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
    const { segments, parseFailed } = parseCommand(trimmed);
    if (parseFailed || segments.length === 0) { return undefined; }
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
    if (segments.length !== 1 || hasUnmodelledSyntax(trimmed) || evidence.writes.length > 0 || evidence.network.length > 0) {
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
    if (prefixes.length === 0 || hasUnmodelledSyntax(trimmed) || touchesGuardedPaths(evidence)) { return undefined; }
    const { segments, parseFailed } = parseCommand(trimmed);
    if (parseFailed || segments.length === 0) { return undefined; }
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
