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
 * The one sensitive-path denylist (pure). Ported from pincer-agent
 * `extensions/auto-mode/sensitive.ts` (tip `5059966`) with BI's `Config.toml`
 * added (design §7).
 *
 * The upstream sandbox this is derived from kept three divergent copies of this
 * list (one for the shell classifier, one for file tools, one for PowerShell);
 * they drifted, and the drift *was* the vulnerability — the shell path blocked
 * `~/.kube/config` while the file path did not (review findings F3, F10, N13,
 * N25). There is exactly one list here, it is case-folded, and every consumer
 * calls these functions rather than re-deriving membership.
 */

import { basename } from "path";

/**
 * Directory names that mean "credentials live under here". Matched as a *path
 * segment*, so `~/.aws/credentials`, `/Users/x/.aws`, and a bare `.aws` in a
 * command all hit. `.config/gcloud` is two segments and handled separately.
 */
const SENSITIVE_DIR_SEGMENTS = new Set([
    ".aws",
    ".azure",
    ".docker",
    ".gnupg",
    ".kube",
    ".m2", // Maven settings.xml holds plaintext repository credentials
    ".npm",
    ".ssh",
    ".terraform.d",
    "gcloud", // under .config/
    ".gcloud",
    ".config/gcloud",
]);

/** Two-segment sensitive suffixes, checked against the resolved path tail. */
const SENSITIVE_DIR_PAIRS = [
    [".config", "gcloud"],
    [".config", "gh"],
    [".local", "share"],
    [".huggingface", "token"],
    ["library", "keychains"], // macOS keychain databases
    [".ballerina", "settings.toml"], // Ballerina Central access token (design §7)
] as const;

const SENSITIVE_BASENAMES = new Set([
    // BI's `Config.toml`: `addConfigFile()` (features/ai/utils.ts) writes the
    // WSO2 LLM-proxy access token into it, and `file_read` refuses it
    // (`RESTRICTED_READ_FILES` in tools/text-editor.ts).
    "config.toml",
    // Other agents' credential stores on the same machine: pi's `agent/auth.json`
    // and Claude Code's `~/.claude/.credentials.json`.
    "auth.json",
    ".credentials.json",
    "credentials.json",
    "credentials.toml", // cargo
    ".vault-token",
    ".gitconfig", // credential helpers, embedded tokens
    ".bash_history",
    ".bash_profile",
    ".bashrc",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pgpass",
    ".profile",
    ".pypirc",
    ".zprofile",
    ".zsh_history",
    ".zshrc",
    "authorized_keys",
    "credentials",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
    "settings.xml",
]);

/**
 * Windows roots (design §7 restriction 4, BI): the Windows directory, and the
 * per-user AppData trees where credential stores, browser profiles and tool
 * tokens live. `AppData\Local\Temp` is carved out: it is `%TEMP%`, which
 * holds the thread's scratchpad, and a rule covering it would send every
 * scratchpad write to the classifier.
 */
function isSensitiveWindowsPath(folded: string, segments: string[]): boolean {
    if (/^[a-z]:\/windows(\/|$)/.test(folded)) { return true; }
    const appData = segments.indexOf("appdata");
    if (appData < 0) { return false; }
    const next = segments[appData + 1];
    if (next === "roaming" || next === "locallow") { return true; }
    return next === "local" && segments[appData + 2] !== undefined && segments[appData + 2] !== "temp";
}

/**
 * Filesystem roots that expose process state — `/proc/self/environ` hands over
 * every environment variable, which defeats any path-based secret protection
 * (review finding N23). Anything under these is sensitive regardless of name.
 */
const SENSITIVE_ROOTS = ["/proc", "/sys"];

function fold(value: string): string {
    return value.trim().toLowerCase().replace(/\\/g, "/");
}

/** Whether a basename names a secret file (`.env`, `.env.local`, keys, …). */
export function isSensitiveBasename(name: string): boolean {
    const folded = fold(name);
    if (!folded) { return false; }
    if (folded === ".env" || folded.startsWith(".env.")) { return true; }
    if (SENSITIVE_BASENAMES.has(folded)) { return true; }
    // Private keys and certificates by extension, plus the id_* key family.
    if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(folded)) { return true; }
    if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(folded)) { return true; }
    return false;
}

/**
 * Whether a path (resolved or not) touches anything on the denylist. Callers
 * pass resolved paths where they have them; the raw-token form is still checked
 * so a bare `.kube` argument is caught before resolution.
 */
export function isSensitivePath(candidate: string): boolean {
    const folded = fold(candidate);
    if (!folded) { return false; }

    for (const root of SENSITIVE_ROOTS) {
        if (folded === root || folded.startsWith(`${root}/`)) { return true; }
    }

    const segments = folded.split("/").filter(Boolean);
    for (const segment of segments) {
        if (SENSITIVE_DIR_SEGMENTS.has(segment)) { return true; }
    }
    for (const [first, second] of SENSITIVE_DIR_PAIRS) {
        for (let i = 0; i + 1 < segments.length; i++) {
            if (segments[i] === first && segments[i + 1] === second) { return true; }
        }
    }
    if (isSensitiveWindowsPath(folded, segments)) { return true; }

    return isSensitiveBasename(basename(folded));
}

/**
 * Paths inside the project that are code-execution primitives: writing them
 * plants code that runs later without any further approval (review finding
 * N20 — `.git/hooks/pre-commit` fires on the next commit, `.git/config` can
 * carry an `[alias]` shelling out). Containment inside the working directory
 * says nothing about whether a write is safe, so these are called out as
 * evidence for the classifier even when they are in-project.
 */
export function isExecutionPrimitivePath(candidate: string): boolean {
    const folded = fold(candidate);
    if (!folded) { return false; }
    const segments = folded.split("/").filter(Boolean);
    const hasGitDir = segments.includes(".git");
    if (hasGitDir) {
        const gitIndex = segments.lastIndexOf(".git");
        const tail = segments.slice(gitIndex + 1);
        if (tail[0] === "hooks" || tail[0] === "config") { return true; }
    }
    // Editor/tooling auto-run configuration.
    if (segments.includes(".vscode") && /\.json$/.test(segments[segments.length - 1] ?? "")) { return true; }
    if (/^(\.envrc|makefile|dockerfile|\.mvn)$/.test(segments[segments.length - 1] ?? "")) { return true; }
    if (segments.includes(".mvn") || segments.includes(".github")) { return true; }
    if (/^mvnw(\.cmd)?$/.test(segments[segments.length - 1] ?? "")) { return true; }
    return false;
}
