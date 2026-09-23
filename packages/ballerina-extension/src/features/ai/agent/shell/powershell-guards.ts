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
 * Pre-execution guards for the `powershell` tool (pure): the PowerShell
 * spelling of `guards.ts`, ported from pincer-agent
 * `extensions/powershell/guards.ts` (`3b290c8`) with BI's tool names.
 * Steering, not security; a guard concludes only on a positive parse.
 *
 * - interactive guard (foreground and background): `Read-Host`,
 *   `Get-Credential`, `Out-GridView`, `pause` and interactive git wait on a
 *   prompt this -NonInteractive shell cannot answer;
 * - wait guard (foreground): a line that leads with `Start-Sleep` (or `sleep`)
 *   of 2 s or more exists only to wait.
 */

import { gitSubcommand } from "../auto-mode/shell-analysis";
import { powershellStatements, powershellWords, statementCommand } from "../auto-mode/powershell-rules";
import { leadingSleepReason } from "./guards";

/** Seconds a `Start-Sleep` statement provably lasts, or undefined when its argument is not a literal. */
export function startSleepSeconds(statement: string): number | undefined {
    const tokens = statement.trim().split(/\s+/).slice(1);
    if (tokens.length === 0) { return undefined; }
    let unit: "s" | "ms" = "s";
    let value: number | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const named = /^-(s|sec|seconds|ms|milliseconds)(?::(.+))?$/i.exec(token);
        if (named) {
            unit = named[1].toLowerCase().startsWith("m") ? "ms" : "s";
            const inline = named[2] ?? tokens[++i];
            if (inline === undefined || !/^\d+(\.\d+)?$/.test(inline)) { return undefined; }
            value = Number(inline);
            continue;
        }
        if (/^-d(uration)?$/i.test(token)) { return undefined; }
        if (!/^\d+(\.\d+)?$/.test(token)) { return undefined; }
        value = Number(token);
    }
    if (value === undefined) { return undefined; }
    return unit === "ms" ? value / 1000 : value;
}

const INTERACTIVE = new Set(["read-host", "get-credential", "out-gridview", "pause"]);

export function powershellGuardReason(command: string, opts: { background: boolean }): string | undefined {
    const statements = powershellStatements(command);
    if (!statements || statements.length === 0) { return undefined; }

    for (const statement of statements) {
        const cmd = statementCommand(statement);
        if (INTERACTIVE.has(cmd)) {
            return (
                `Blocked: \`${cmd}\` waits for someone to answer a prompt, and this shell runs -NonInteractive with no console, so it would fail or hang until the timeout. ` +
                "Ask the user with the Clarify tool instead, or pass the value on the command line."
            );
        }
        if (cmd === "git") {
            // gitSubcommand skips git's value-taking global flags, so `git -C x rebase -i` still finds "rebase".
            const words = (powershellWords(statement) ?? statement.trim().split(/\s+/)).slice(1);
            const { sub, rest } = gitSubcommand(words.map((value) => ({ value, hadExpansion: false })));
            const flags = new Set(rest.map((token) => token.value));
            if (sub === "rebase" && (flags.has("-i") || flags.has("--interactive"))) {
                return (
                    "Blocked: `git rebase -i` opens an editor this shell does not have, so it would hang until the timeout. " +
                    "Run it without one: `$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …` keeps the todo list as it is, or use `git rebase --onto`, `git commit --amend` or `git cherry-pick`."
                );
            }
            if (sub === "add" && ["-i", "--interactive", "-p", "--patch"].some((flag) => flags.has(flag))) {
                return (
                    "Blocked: interactive `git add` needs a terminal this shell does not have; it would stage nothing and look as if it worked. " +
                    "Stage whole files with `git add <paths>`, or a partial change with `git apply --cached` and a diff."
                );
            }
        }
    }
    if (opts.background) { return undefined; }

    return leadingSleepReason(
        statements,
        (statement) => (statementCommand(statement) === "start-sleep" ? startSleepSeconds(statement) : null),
        (statement) => statement,
        { sleepName: "Start-Sleep", joiner: "; " },
    );
}
