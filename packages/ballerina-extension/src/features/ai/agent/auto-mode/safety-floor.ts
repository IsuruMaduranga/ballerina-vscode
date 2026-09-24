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
 * The safety floor: a deterministic check that sends a
 * shell command to the user whatever mode is on, because it touches what the
 * gate is made of or what the WSO2 Integrator Copilot keeps for itself. A
 * floor hit never reaches the classifier and never gets a session rule.
 *
 * Mechanics from pincer-agent `extensions/auto-mode/safety-floor.ts` (tip
 * `3b290c8`), targets BI's own:
 * - gate-control files: any `.copilot/skills.config.json`, `.mcp.json` and
 *   `.vscode/settings.json`, plus `~/.ballerina/copilot/mcp.json` and the
 *   auto-mode configuration `~/.ballerina/copilot/auto-mode.json`;
 * - the Copilot's own state: everything under `~/.ballerina/copilot/workspaces/`
 *   (chat history, checkpoints, the decision log) and the review baselines
 *   `bal-proj-*` under the system temp directory;
 * - `Config.toml`, which holds the WSO2 LLM-proxy access token: any mention
 *   of it, read or write, stops the call (`file_read` refuses it outright).
 *
 * Deny-only, the mirror of the pre-gate: it may only ever say "stop". A gap
 * falls through to the classifier, which keeps its tampering rules, so the
 * lists need not be complete. Pure apart from path resolution.
 */

import { tmpdir } from "os";
import { join } from "path";
import { resolveForContainment, toAbsolute, toAbsoluteBash } from "./paths";
import { analyzeShellCommand, globComponentRegex, isUnknownTilde, parseCommand, resolvePayload } from "./shell-analysis";
import { comparablePath, tryRealpath } from "./shared-paths";

const fold = comparablePath;

/** Gate-control files wherever they live: another checkout's copy feeds another session. */
const CONTROL_TAILS = [/\/\.copilot\/skills\.config\.json$/, /\/\.mcp\.json$/, /\/\.vscode\/settings\.json$/];

/** The same names in command text, for the textual pass. */
const CONTROL_FILE_TEXT =
    /(^|[\s'"=/<>|;&(:])(\.copilot\/skills\.config\.json|\.mcp\.json|\.vscode\/settings\.json|copilot\/mcp\.json|copilot\/auto-mode\.json)(?=$|[\s'";|&)<>])/;

/** `Config.toml` anywhere in the line, any case: it holds the LLM-proxy token. */
const CONFIG_TOML_TEXT = /(^|[\s'"=/<>|;&(:\\])config\.toml(?=$|[\s'";|&)<>])/i;

export interface FloorContext {
    cwd: string;
    home: string;
    /** The system temp directory the review baselines live in (`temp-project.ts` uses `os.tmpdir()`). */
    tmpDir?: string;
}

interface FloorForms {
    files: Set<string>;
    dirs: string[];
    /** Comparable temp-directory forms; a `bal-proj-*` child of one is a review baseline. */
    tmpDirs: string[];
}

/** Both the resolved and the literal spelling of a path, so macOS `/var` vs `/private/var` agree. */
function forms(path: string): string[] {
    return [...new Set([fold(resolveForContainment(path) ?? path), fold(path), fold(tryRealpath(path) ?? path)])];
}

function floorForms({ home, tmpDir = tmpdir() }: FloorContext): FloorForms {
    const copilot = join(home, ".ballerina", "copilot");
    return {
        files: new Set([...forms(join(copilot, "mcp.json")), ...forms(join(copilot, "auto-mode.json"))]),
        dirs: forms(join(copilot, "workspaces")),
        tmpDirs: forms(tmpDir),
    };
}

/** Whether a resolved path is a floor target. */
function isFloorTarget(resolved: string, targets: FloorForms): boolean {
    const target = fold(resolved);
    if (targets.files.has(target) || CONTROL_TAILS.some((tail) => tail.test(target))) { return true; }
    if (/(^|\/)config\.toml$/i.test(target)) { return true; }
    if (targets.dirs.some((dir) => target === dir || target.startsWith(`${dir}/`))) { return true; }
    return targets.tmpDirs.some((dir) => target.startsWith(`${dir}/bal-proj-`));
}

const GLOB_CHARS = /[*?[]/;

/**
 * Whether a resolved path names a floor target, literally or as a glob the
 * shell expands onto one (`> .vscode/sett*.json`). A glob in a directory
 * component stops whenever the leaf could spell a target's name.
 */
function namesFloorTarget(resolved: string, targets: FloorForms, dotRule: boolean): boolean {
    if (isFloorTarget(resolved, targets)) { return true; }
    const target = fold(resolved);
    if (!GLOB_CHARS.test(target)) { return false; }
    const slash = target.lastIndexOf("/");
    const dir = target.slice(0, slash);
    const leaf = target.slice(slash + 1);
    const regex = globComponentRegex(leaf);
    if (!regex) { return false; }
    const names = ["skills.config.json", ".mcp.json", "settings.json", "mcp.json", "auto-mode.json", "config.toml"];
    const spelled = names.filter((name) => regex.test(name) && !(dotRule && name.startsWith(".") && !leaf.startsWith(".")));
    if (spelled.length === 0) { return false; }
    // A glob directory could be `.vscode` or `.copilot`: stop.
    return GLOB_CHARS.test(dir) || dir.split("/").some((part) => part.startsWith("bal-proj-")) ||
        spelled.some((name) => isFloorTarget(`${dir}/${name}`, targets));
}

const reason = (token: string) =>
    `it touches ${token}, which holds the WSO2 Integrator Copilot's own configuration, credentials or state`;

/**
 * The first word of a bash line that names a floor target, or undefined.
 * Every word counts, read or write, plus the value after an `=` and the words
 * of a nested `sh -c '…'`; `cd` is followed. False positives cost one prompt.
 */
export function shellNamesFloorTarget(command: string, ctx: FloorContext, depth = 0, targets = floorForms(ctx)): string | undefined {
    const text = command.toLowerCase().replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
    const match = CONTROL_FILE_TEXT.exec(text);
    if (match) { return match[2]; }
    const { segments, parseFailed } = parseCommand(command);
    if (parseFailed) { return undefined; }
    let dir = ctx.cwd;
    for (const segment of segments) {
        const payload = resolvePayload(segment.tokens);
        for (const word of [...segment.tokens.map((token) => token.value), ...segment.redirects]) {
            if (depth < 3 && /\s/.test(word)) {
                const nested = shellNamesFloorTarget(word, { ...ctx, cwd: dir }, depth + 1, targets);
                if (nested) { return nested; }
            }
            const eq = word.indexOf("=");
            for (const candidate of eq >= 0 ? [word, word.slice(eq + 1)] : [word]) {
                if (!candidate || isUnknownTilde(candidate)) { continue; }
                const resolved = resolveForContainment(toAbsoluteBash(dir, candidate, ctx.home));
                if (resolved && namesFloorTarget(resolved, targets, true)) { return candidate; }
            }
        }
        if (payload.command === "cd") {
            const target = payload.args.find((token) => !token.value.startsWith("-"))?.value;
            if (target && !isUnknownTilde(target)) { dir = toAbsoluteBash(dir, target, ctx.home); }
        }
    }
    return undefined;
}

/**
 * Why this bash command must go to the user whatever the mode, or undefined.
 * `Config.toml` stops it on any mention. A write the pre-gate resolved onto a
 * target stops it. A command the pre-gate could not prove read-only stops on
 * any word naming a target, since it may write in ways the evidence does not
 * model; a proven read of a gate-control file (`cat .mcp.json`) does not stop.
 */
export function bashFloorReason(command: string, ctx: FloorContext): string | undefined {
    const configToml = CONFIG_TOML_TEXT.exec(command);
    if (configToml) { return reason("Config.toml"); }
    const targets = floorForms(ctx);
    const evidence = analyzeShellCommand({ command, cwd: ctx.cwd, home: ctx.home });
    for (const write of evidence.writes) {
        if (write.resolved && namesFloorTarget(write.resolved, targets, true)) { return reason(write.token); }
    }
    if (evidence.verdict === "escalate" && !evidence.readOnlyOutside) {
        const named = shellNamesFloorTarget(command, ctx, 0, targets);
        if (named) { return reason(named); }
    }
    return undefined;
}

/**
 * Path-looking tokens of a PowerShell line (pincer `powershellPathTokens`):
 * quotes stripped, `$env:USERPROFILE` / `$env:HOME` / `$HOME` / `~` expanded,
 * backslashes forward-slashed, `-Path:value` unwrapped. Anything with a
 * separator or a `.json` / `.toml` name counts; the floor tolerates false positives.
 */
export function powershellPathTokens(command: string, home: string): string[] {
    const out: string[] = [];
    for (const raw of command.split(/[\s;|()]+/)) {
        let token = raw.replace(/^["']+|["',]+$/g, "");
        if (!token) { continue; }
        token = token
            .replace(/^\$env:(USERPROFILE|HOME)/i, home)
            .replace(/^\$HOME\b/i, home)
            .replace(/^~(?=[\\/]|$)/, home)
            .replace(/\\/g, "/");
        if (token.startsWith("-")) {
            const colon = token.indexOf(":");
            if (colon === -1) { continue; }
            token = token.slice(colon + 1);
        }
        if (/[\\/]/.test(token) || /\.(json|toml)$/i.test(token)) { out.push(token); }
    }
    return out;
}

/**
 * The PowerShell floor (Phase B2). There is no PowerShell write model, so it
 * is textual: any token resolving to a target stops the call, read or write.
 * PowerShell wildcards have no leading-dot rule.
 */
export function powershellFloorReason(command: string, ctx: FloorContext): string | undefined {
    if (CONFIG_TOML_TEXT.exec(command)) { return reason("Config.toml"); }
    const text = command.toLowerCase().replace(/\\/g, "/");
    const match = CONTROL_FILE_TEXT.exec(text);
    if (match) { return reason(match[2]); }
    const targets = floorForms(ctx);
    for (const token of powershellPathTokens(command, ctx.home)) {
        const absolute = toAbsolute(ctx.cwd, token, ctx.home);
        if (namesFloorTarget(resolveForContainment(absolute) ?? absolute, targets, false)) { return reason(token); }
    }
    return undefined;
}
