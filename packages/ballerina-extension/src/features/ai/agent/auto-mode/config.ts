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
 * The user's auto-mode customization, read from one
 * user-level file: `~/.ballerina/copilot/auto-mode.json`. Never from the
 * workspace: a checked-in file could otherwise hand the agent classifier
 * permissions, and the file itself is a safety-floor target.
 *
 * The keys follow Claude Code's `autoMode` schema:
 * - `environment`: replaces the Environment slot lines; `"$defaults"` splices
 *   the built-in lines at that position, so a user can extend rather than replace;
 * - `hard_deny` / `soft_deny` / `allow`: rules appended to the end of the
 *   matching built-in list. Append-only: `"$defaults"` is accepted and ignored,
 *   and the built-in rules always apply, so an extra rule can tighten or carve
 *   out but never rewrite the boundary;
 * - `logDecisions` (BI): the decision log, on unless set to `false`.
 *
 * Pure apart from the one file read. A malformed file falls back to the
 * defaults and says why in `diagnostics`.
 */

import { readFileSync } from "fs";
import { join } from "path";

export const DEFAULTS_TOKEN = "$defaults";

export interface AutoModeConfig {
    /** Environment slot lines spliced into the ruleset (prefix-less). */
    environment: string[];
    hardDeny: string[];
    softDeny: string[];
    allow: string[];
    logDecisions: boolean;
    /** Why part of the file was ignored, one line each. */
    diagnostics: string[];
}

/** The one file auto mode reads its customization from. */
export function autoModeConfigPath(home: string): string {
    return join(home, ".ballerina", "copilot", "auto-mode.json");
}

/** Splice `$defaults` into a user list; no list means the defaults. */
export function spliceDefaults(entries: string[] | undefined, defaults: string[]): string[] {
    if (!entries) { return [...defaults]; }
    const out: string[] = [];
    for (const entry of entries) {
        if (entry.trim() === DEFAULTS_TOKEN) { out.push(...defaults); } else { out.push(entry); }
    }
    return out;
}

function stringList(value: unknown, key: string, diagnostics: string[]): string[] | undefined {
    if (value === undefined) { return undefined; }
    if (!Array.isArray(value)) {
        diagnostics.push(`${key} is not a list of strings; ignored`);
        return undefined;
    }
    const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (strings.length !== value.length) { diagnostics.push(`${key} holds entries that are not non-empty strings; they were ignored`); }
    return strings;
}

const withoutDefaults = (entries: string[] | undefined) => (entries ?? []).filter((entry) => entry.trim() !== DEFAULTS_TOKEN);

/** Parse the file's text against the built-in environment. Exported for tests. */
export function parseAutoModeConfig(text: string | undefined, defaultEnvironment: string[]): AutoModeConfig {
    const diagnostics: string[] = [];
    let raw: Record<string, unknown> = {};
    if (text !== undefined) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                raw = parsed as Record<string, unknown>;
            } else {
                diagnostics.push("the file is not a JSON object; using the defaults");
            }
        } catch (error) {
            diagnostics.push(`the file is not valid JSON (${error instanceof Error ? error.message : String(error)}); using the defaults`);
        }
    }
    const environment = stringList(raw.environment, "environment", diagnostics);
    if (environment && !environment.some((entry) => entry.trim() === DEFAULTS_TOKEN)) {
        diagnostics.push(`environment omits "${DEFAULTS_TOKEN}", so it replaces the built-in environment lines instead of extending them`);
    }
    return {
        environment: spliceDefaults(environment, defaultEnvironment),
        hardDeny: withoutDefaults(stringList(raw.hard_deny, "hard_deny", diagnostics)),
        softDeny: withoutDefaults(stringList(raw.soft_deny, "soft_deny", diagnostics)),
        allow: withoutDefaults(stringList(raw.allow, "allow", diagnostics)),
        logDecisions: raw.logDecisions !== false,
        diagnostics,
    };
}

/** Load the user's file; a missing file is the defaults. */
export function loadAutoModeConfig(home: string, defaultEnvironment: string[]): AutoModeConfig {
    let text: string | undefined;
    try {
        text = readFileSync(autoModeConfigPath(home), "utf8");
    } catch {
        text = undefined;
    }
    return parseAutoModeConfig(text, defaultEnvironment);
}

/** Per-file cap, so a large AGENTS.md cannot crowd the rules out of the classifier's view. */
const AGENTS_MD_LIMIT = 6_000;

/**
 * The workspace's AGENTS.md for the classifier's untrusted framing block (the
 * same file the agent is shown), capped; undefined when absent or empty.
 */
export function loadAgentsMdForClassifier(workspaceRoot: string): string | undefined {
    try {
        const text = readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8").slice(0, AGENTS_MD_LIMIT).trim();
        return text.length > 0 ? text : undefined;
    } catch {
        return undefined;
    }
}
