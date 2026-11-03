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
 * Targets BI's own:
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
import { FIND_PATTERN_TESTS, findNegatedPatterns } from "./read-only-options";
import { analyzeShellCommand, globComponentRegex, hasReadOnlyShellWords, isUnknownTilde, LOOPS, movesDirectory, parseCommand, resolvePayload, scopedTracker, type ShellEvidence, type Token } from "./shell-analysis";
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
const FLOOR_CONTROL_NAMES = new Set(["skills.config.json", ".mcp.json", "settings.json", "mcp.json", "auto-mode.json", "config.toml"]);

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
    const names = [...FLOOR_CONTROL_NAMES];
    const spelled = names.filter((name) => regex.test(name) && !(dotRule && name.startsWith(".") && !leaf.startsWith(".")));
    if (spelled.length === 0) { return false; }
    // A glob directory could be `.vscode` or `.copilot`: stop.
    return GLOB_CHARS.test(dir) || dir.split("/").some((part) => part.startsWith("bal-proj-")) ||
        spelled.some((name) => isFloorTarget(`${dir}/${name}`, targets));
}

const reason = (token: string) =>
    `it touches ${token}, which holds the WSO2 Integrator Copilot's own configuration, credentials or state`;

/**
 * A find's negated pattern operands, by token index: those that only exclude
 * files (`findNegatedPatterns`), which name nothing, and the rest, which may
 * select every file but the ones they name. A find that is not read-only acts
 * on every file a negated pattern leaves in (`! -name keep -delete`), and its
 * expression is not read, so there every pattern after any `!`/`-not` selects.
 */
function negatedFindPatterns(tokens: readonly Token[], args: readonly Token[]): { excluding: Set<number>; selecting: Set<number> } {
    const offset = tokens.length - args.length;
    const shift = (indexes: Set<number>) => new Set([...indexes].map((index) => index + offset));
    const readOnly = findNegatedPatterns(args);
    if (readOnly) { return { excluding: shift(readOnly.excluding), selecting: shift(readOnly.selecting) }; }
    const selecting = new Set<number>();
    let negated = false;
    for (let index = 0; index + 1 < tokens.length; index++) {
        const word = tokens[index].value;
        if (word === "!" || word === "-not") { negated = true; }
        else if (negated && FIND_PATTERN_TESTS.has(word)) { selecting.add(index + 1); }
    }
    return { excluding: new Set(), selecting };
}

/**
 * A `{var}>f` redirect, which assigns the descriptor's number to var. The
 * grammar reads `{var}` as a word, or not at all after a compound command, so
 * it is matched in the line's text.
 */
const VAR_REDIRECT = /\{[A-Za-z_][A-Za-z0-9_]*\}[<>]/;

/**
 * `$_` (or `${_}`, `${#_}`, …) anywhere in the line: bash's last argument of
 * the previous command, which carries a proven read-only command's words into
 * a later one (`echo .mcp.json; rm "$_"`). Raw text, so heredoc bodies and
 * quoted spellings count too; a false positive costs one stop.
 */
const LAST_ARGUMENT = /\$(?:_|\{[#!]?_)(?![A-Za-z0-9_])/;

/**
 * The literal text every match of a find `-regex` pattern ends with (find
 * anchors the pattern to the whole path), or undefined when that is not
 * certain: no literal tail, or alternation anywhere (`|` or emacs `\|`).
 * Wildcards, groups, intervals and classes end the tail in either the emacs
 * or the POSIX spelling. Only `\` before one of `.*+?[]^$\/-` is a literal;
 * any other escape (emacs `\'` is an anchor, `\w` a class) ends the tail.
 */
export function regexLiteralTail(pattern: string): string | undefined {
    if (pattern.includes("|")) { return undefined; }
    const units: Array<{ literal: boolean; text: string }> = [];
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "\\" && i + 1 < pattern.length) {
            const next = pattern[++i];
            units.push({ literal: /[.*+?[\]^$\\/-]/.test(next), text: next });
        } else { units.push({ literal: !/[.[\]*+?^$(){}\\]/.test(char), text: char }); }
    }
    // A trailing unescaped `$` only re-anchors the end find anchors anyway.
    if (units.at(-1)?.text === "$" && !units.at(-1)!.literal) { units.pop(); }
    let tail = "";
    for (let i = units.length - 1; i >= 0 && units[i].literal; i--) { tail = units[i].text + tail; }
    return tail || undefined;
}

/**
 * The first word of a Bash line that names a floor target, or undefined.
 * Every word not proven read-only counts, plus the value after an `=` and the
 * words of a nested `sh -c '…'`, read from proven words too (`echo '…'` may
 * print a script to a file). Directories are tracked per shell scope so a `cd`
 * in a substitution does not move later commands in its parent shell. If a
 * `cd` is conditional, pipeline-scoped, looped, expanded, or otherwise
 * unknown, a later control-file basename stops by name alone. The floor may
 * only say "stop", so a false positive is the safe outcome.
 *
 * In a line the pre-gate escalated, the exact source ranges of each simple
 * command the analyzer proves read-only on its own (and of a top-level
 * pipeline whose every member is proven) are left out of the path match and
 * of the raw-text match. Anything that can change what a later command runs
 * or where its output goes withholds that proof for the whole line. An
 * unproven `find` stops when a selecting pattern could match a control
 * file's name, since find matches names beneath its search roots.
 */
export function shellNamesFloorTarget(command: string, ctx: FloorContext, depth = 0, targets = floorForms(ctx)): string | undefined {
    const { segments, parseFailed, unknownQuoting, unattributedExpansion, definesFunction, pipelines } = parseCommand(command);
    const dirs = scopedTracker(ctx.cwd);
    const ignoredRanges: { start: number; end: number }[] = [];
    // Functions/eval can replace a read-only command; loop headers, case
    // subjects and `{var}>` redirects can change shell state outside the
    // attributed words. A compound command's redirect (`{ …; } > f`,
    // `fi > f`) or an `exec` one sends a proven command's output, unquoted
    // words and all, to a file a later command can run; /dev/null and
    // descriptor dups capture nothing. Never use a partial parse, such a
    // construct, or a nested script to subtract evidence.
    const capturesOutput = segments.some((segment) =>
        segment.redirects.some((target) => target !== "/dev/null") && (segment.tokens.length === 0 || resolvePayload(segment.tokens).command === "exec"),
    );
    const canProveWords = depth === 0 && !parseFailed && !unknownQuoting && !unattributedExpansion && !definesFunction && !capturesOutput && !VAR_REDIRECT.test(command) && !segments.some((segment) =>
        segment.enclosing.some((construct) => LOOPS.has(construct) || construct === "case_statement") ||
        ["eval", "source", ".", "alias", "enable", "trap"].includes(resolvePayload(segment.tokens).command),
    ) && !LAST_ARGUMENT.test(command);

    // Decided before the walk: in a loop, a word read before the `cd` runs after it on the next pass.
    const unknownDir =
        parseFailed ||
        segments.some((segment) => {
            const payload = resolvePayload(segment.tokens);
            // These execute scripts in the current shell and may change its cwd.
            if (["eval", "source", "."].includes(payload.command)) { return true; }
            if (!movesDirectory(segment)) { return false; }
            const target = payload.args.find((token) => !token.value.startsWith("-"));
            const previous = payload.args.some((token) => token.value === "-");
            // Every pipeline member has a separate scope. The parser marks only
            // the last member as `pipelineShell`, but a cd in any member cannot
            // determine the parent shell's later cwd.
            return payload.command !== "cd" || previous || segment.scopes.length > 0 || segment.pipelineShell !== undefined ||
                !!segment.conditional || segment.enclosing.some((construct) => LOOPS.has(construct)) ||
                !!target?.dynamic || !!target?.glob || (!!target && isUnknownTilde(target.value));
        });
    const baseName = (path: string) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1).toLowerCase();
    const controlNames = new Set([...FLOOR_CONTROL_NAMES, ...targets.files].map(baseName));
    // First pass, in order: each segment's directory and whether its words
    // alone are proven read-only. The cd tracking runs here so the second pass
    // can look ahead at a whole pipeline.
    let shellChanged = false;
    const facts = segments.map((segment) => {
        const dir = dirs.get(segment);
        const payload = resolvePayload(segment.tokens);
        // A previous assignment or stateful builtin can change command lookup
        // (PATH, a hash entry, shell options, …). Arithmetic commands and
        // expansions can assign too. A standalone command proof cannot account
        // for that state. Even inert assignments/expansions forfeit it.
        shellChanged ||= !!segment.unknownTarget || !!segment.expandsIntoInput ||
            segment.tokens.some((word) => word.dynamic || /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word.value)) ||
            ["read", "readarray", "mapfile", "getopts", "printf", "export", "declare", "typeset", "local", "readonly", "unset", "set", "shopt", "hash", "let", "wait", "coproc"].includes(payload.command);
        const proven = canProveWords && !shellChanged && !unknownDir &&
            segment.wordRanges?.length === segment.tokens.length && hasReadOnlyShellWords(segment, dir, ctx.home);
        if (payload.command === "cd" && !unknownDir) {
            const target = payload.args.find((token) => !token.value.startsWith("-"));
            if (target) { dirs.set(segment, toAbsoluteBash(dir, target.value, ctx.home)); }
        }
        return { dir, payload, proven };
    });
    // Pipeline output may itself be a script (`echo '…' | sh`), so a pipeline
    // member keeps its words out of the scan only when the pipeline sits in the
    // top-level shell and every member is one proven read-only command: then
    // no member runs another's output (`find … | sort`). Substitutions and
    // `( … )` stay textual.
    const provenPipelineScopes = new Set<number>();
    for (const members of pipelines) {
        const inMember = members.map((scope) => segments.flatMap((segment, index) => (segment.scopes.length === 1 && segment.scopes[0] === scope ? [index] : [])));
        const nested = segments.some((segment) => segment.scopes.length > 1 && members.includes(segment.scopes[0]));
        if (!nested && inMember.every((indexes) => indexes.length === 1 && facts[indexes[0]].proven)) {
            for (const scope of members) { provenPipelineScopes.add(scope); }
        }
    }
    for (const [index, segment] of segments.entries()) {
        const { dir, payload, proven } = facts[index];
        const readOnly = proven && (segment.scopes.length === 0 || (segment.scopes.length === 1 && provenPipelineScopes.has(segment.scopes[0])));
        if (readOnly) { ignoredRanges.push(...segment.wordRanges!); }
        // -regex/-iregex match the whole path, which the file-name glob check
        // cannot model. An unproven find selecting by one stops unless the
        // pattern's fixed tail rules out every control file's name, and only a
        // plain conjunction can rely on that: `! -regex '.*\.orig'` or a `-o`
        // branch selects everything the pattern does not.
        if (!readOnly && payload.command === "find") {
            const uncertain = payload.args.some((token) => ["-regextype", "!", "-not", "-o", "-or", ","].includes(token.value));
            for (const [i, token] of payload.args.entries()) {
                if (token.value !== "-regex" && token.value !== "-iregex") { continue; }
                const pattern = payload.args[i + 1];
                if (!pattern || pattern.dynamic || uncertain) { return pattern?.value ?? token.value; }
                const tail = regexLiteralTail(pattern.value)?.toLowerCase();
                const name = tail?.slice(tail.lastIndexOf("/") + 1);
                if (tail === undefined || name === undefined || [...controlNames].some((control) => tail.includes("/") ? control === name : control.endsWith(name))) { return pattern.value; }
            }
        }
        const negated = payload.command === "find" && !readOnly ? negatedFindPatterns(segment.tokens, payload.args) : undefined;
        const words = [
            ...segment.tokens.map((token, index) => ({ value: token.value, index, exempt: readOnly })),
            ...[...segment.redirects, ...segment.inputs.map((token) => token.value)].map((value) => ({ value, index: -1, exempt: false })),
        ];
        for (const { value: word, index: at, exempt } of words) {
            // A proven command's words are still read as a script: its output can
            // reach a file it never names, through an enclosing redirect, an
            // `exec` or a descriptor (`{ echo '…'; } > s.sh; sh s.sh`). Only
            // their path match is exempt.
            if (depth < 3 && /\s/.test(word)) {
                const nested = shellNamesFloorTarget(word, { ...ctx, cwd: dir }, depth + 1, targets);
                if (nested) { return nested; }
            }
            if (exempt) { continue; }
            // find never opens or writes a pattern operand, and one that only
            // excludes files names nothing (a loop elsewhere in the line leaves
            // every word unproven). A negated pattern that may select everything
            // else may select a control file.
            if (negated?.excluding.has(at)) { continue; }
            if (negated?.selecting.has(at)) { return word; }
            const eq = word.indexOf("=");
            for (const candidate of eq >= 0 ? [word, word.slice(eq + 1)] : [word]) {
                if (!candidate || isUnknownTilde(candidate)) { continue; }
                const resolved = resolveForContainment(toAbsoluteBash(dir, candidate, ctx.home));
                if (resolved && namesFloorTarget(resolved, targets, true)) { return candidate; }
                if (unknownDir && controlNames.has(baseName(candidate))) { return candidate; }
                // find matches names beneath its search roots, not the shell's cwd.
                // An unproven expression may delete/execute on any such match.
                if (payload.command === "find") {
                    const pattern = globComponentRegex(baseName(candidate));
                    if (pattern && [...controlNames].some((name) => pattern.test(name))) { return candidate; }
                }
            }
        }
    }
    // Keep the raw-text fallback for syntax/words the walker cannot attribute,
    // heredoc bodies included. Only exact source ranges of proven command
    // words disappear; never use string replacement (the same text may also
    // occur in a redirect or in an unproven command).
    let unproven = "";
    let at = 0;
    for (const range of ignoredRanges.sort((a, b) => a.start - b.start)) {
        unproven += command.slice(at, range.start) + " ";
        at = range.end;
    }
    unproven += command.slice(at);
    const text = unproven.toLowerCase().replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
    return CONTROL_FILE_TEXT.exec(text)?.[2];
}

/**
 * Why this bash command must go to the user whatever the mode, or undefined.
 * `Config.toml` stops it on any mention. A write the pre-gate resolved onto a
 * target stops it. A command the pre-gate could not prove read-only stops on
 * any word naming a target, since it may write in ways the evidence does not
 * model; a proven read of a gate-control file (`cat .mcp.json`) does not stop,
 * alone or as one proven command of a longer line (`shellNamesFloorTarget`).
 * Callers that already analyzed this exact authorization call may provide that
 * evidence; standalone callers still analyze the command themselves.
 */
export function bashFloorReason(command: string, ctx: FloorContext, evidence?: ShellEvidence): string | undefined {
    const configToml = CONFIG_TOML_TEXT.exec(command);
    if (configToml) { return reason("Config.toml"); }
    const targets = floorForms(ctx);
    evidence ??= analyzeShellCommand({ command, cwd: ctx.cwd, home: ctx.home });
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
 * Path-looking tokens of a PowerShell line: quotes stripped,
 * `$env:USERPROFILE` / `$env:HOME` / `$HOME` / `~` expanded,
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
 * The PowerShell floor. There is no PowerShell write model, so it
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
