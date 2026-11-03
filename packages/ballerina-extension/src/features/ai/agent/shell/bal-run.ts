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
 * Whether a background shell command starts a Ballerina service: `bal run`, optionally after `cd` steps
 * (`cd pkg && bal run`, `cd pkg; bal run`, `bal run pkg`). Such a command becomes a service — project-wide,
 * kept across chats, listed in the running chip — instead of a chat task. Pure; concludes only on a
 * positive parse, so anything it cannot read stays an ordinary background command.
 */

import { delimiter, dirname, isAbsolute, resolve } from "path";
import { leadTokens, parseCommand, resolvePayload, type Token } from "../auto-mode/shell-analysis";

const BAL_NAMES = new Set(["bal", "bal.bat", "bal.cmd"]);
/** `cd` and PowerShell's spellings of it (resolvePayload lowercases the name). */
const CD_NAMES = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
/** `bal run` options that take a value, so the value is not read as the package path. */
const BAL_RUN_VALUE_OPTIONS = new Set(["--debug", "--target-dir"]);

/**
 * The directory the service runs in when `command` is a `bal run` (the package path or the last `cd`,
 * resolved against `cwd`), or undefined when it is not one.
 */
export function balRunDirectory(command: string, cwd: string): string | undefined {
    const { segments, parseFailed } = parseCommand(command);
    if (parseFailed || segments.length === 0) { return undefined; }
    let dir = cwd;
    for (let i = 0; i < segments.length; i++) {
        const { command: name, args } = resolvePayload(leadTokens(segments[i]));
        const last = i === segments.length - 1;
        if (!last && CD_NAMES.has(name)) {
            const target = cdTarget(args);
            if (target === undefined) { return undefined; }
            dir = resolveFrom(dir, target);
            continue;
        }
        if (!last || !BAL_NAMES.has(name) || args[0]?.value !== "run") { return undefined; }
        const pkg = packageArgument(args.slice(1));
        if (!pkg) { return dir; }
        // A single source file or an executable jar runs from the directory that holds it.
        const target = resolveFrom(dir, pkg);
        return /\.(bal|jar)$/i.test(pkg) ? dirname(target) : target;
    }
    return undefined;
}

/** The literal directory a `cd` names; undefined for anything a shell would expand. */
function cdTarget(args: Token[]): string | undefined {
    const operands = args.filter(a => !a.value.startsWith("-") || a.value === "-");
    if (operands.length !== 1) { return undefined; }
    const [target] = operands;
    if (!isLiteral(target) || target.value === "-" || target.value.startsWith("~")) { return undefined; }
    return target.value;
}

/** A token the shell passes as written: no quoting-with-expansion, glob, variable or command substitution. */
function isLiteral(token: Token): boolean {
    return !token.dynamic && !token.glob && !/[$`]/.test(token.value);
}

/** The package path `bal run` is given, if any: the first operand before `--`. */
function packageArgument(args: Token[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const value = args[i].value;
        if (value === "--") { return undefined; }
        if (value.startsWith("-")) {
            if (BAL_RUN_VALUE_OPTIONS.has(value)) { i++; }
            continue;
        }
        return isLiteral(args[i]) ? value : undefined;
    }
    return undefined;
}

function resolveFrom(dir: string, target: string): string {
    return isAbsolute(target) ? target : resolve(dir, target);
}

/**
 * The shell's environment with the extension's own `bal` first on PATH, so `bal run` and `bal test` in the
 * shell use the Ballerina the language server and diagnostics use, not whichever `bal` PATH finds first (or
 * none, where only the bundled distribution is installed). Unchanged when `balCmd` is a bare name.
 */
export function withBalOnPath(env: NodeJS.ProcessEnv, balCmd: string | undefined): NodeJS.ProcessEnv {
    const cmd = (balCmd ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (!cmd || !isAbsolute(cmd)) { return env; }
    // Windows spells the key `Path`; keep whichever spelling the environment has.
    const key = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
    const current = env[key];
    return { ...env, [key]: current ? `${dirname(cmd)}${delimiter}${current}` : dirname(cmd) };
}
