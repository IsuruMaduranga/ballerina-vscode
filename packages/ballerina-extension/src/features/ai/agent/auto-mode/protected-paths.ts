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
 * Protected paths (pure) — Claude Code's list of paths whose *writes* are never
 * auto-approved, in any mode except bypassPermissions. Ported from pincer-agent
 * `extensions/permissions/protected-paths.ts` (tip `5059966`, re-synced to `2602e3c`) with BI's own
 * agent-configuration paths in place of One Code's (design §7).
 *
 * These are not "secret" paths (that list lives in `auto-mode/sensitive.ts` and
 * is about credentials). These are paths that configure the tooling: a write to
 * `.git/hooks`, `.husky`, `.pre-commit-config.yaml`, a shell rc file, or an
 * `.npmrc` plants code that runs on the next commit, install, or shell — and a
 * write to `.claude` reconfigures the agent's own permissions. Being inside the
 * working directory says nothing about whether such a write is safe, which is
 * why containment does not clear them and why an `allow` rule does not either:
 * the check runs before allow rules are evaluated.
 */

import { relative, resolve, sep } from "path";

/** Directories whose entire contents are protected. */
const PROTECTED_DIRS = [
    ".git",
    ".config/git",
    ".vscode",
    ".idea",
    ".husky",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
    ".claude",
    // The WSO2 Integrator Copilot's own configuration: `.copilot/skills.config.json`
    // (which skills are enabled) and `.agents/skills/` (project skills, injected
    // into the prompt on demand).
    ".copilot",
    ".agents",
    // Run-at-login and on-PATH locations (pincer PERMISSIONS-REVIEW-2026-09-05 M7): a
    // launchd agent plist runs at the next login, a fish config at the next
    // shell, and `~/.local/bin` is where the `pi` shim and user tools live.
    // Lowercase — segments are compared case-folded.
    "library/launchagents",
    ".config/fish",
    ".local/bin",
];

/**
 * Protected directories whose subtree is ordinary working space rather than
 * configuration. None for BI: pincer's two (`.claude/worktrees`,
 * `.onecode/plans`) are One Code's own working directories.
 */
const PROTECTED_DIR_EXCEPTIONS: string[] = [];

const PROTECTED_FILES = new Set([
    // A `.git` FILE is a gitlink (`gitdir: <path>`): written into a subdirectory
    // it points an in-project `git -C sub …` at any repository, and that
    // repository's config (pincer SECURITY-REVIEW-2026-09-23 H2). The `.git`
    // directory is covered by PROTECTED_DIRS; this covers the file form.
    ".git",
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_aliases",
    ".bash_logout",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".profile",
    ".envrc",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".pnpmfile.cjs",
    "bunfig.toml",
    ".bunfig.toml",
    ".bazelrc",
    ".bazelversion",
    ".bazeliskrc",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "gradle-wrapper.properties",
    "maven-wrapper.properties",
    ".devcontainer.json",
    ".ripgreprc",
    "pyrightconfig.json",
    ".mcp.json",
    ".claude.json",
    // Claude Code's managed (organisation) settings: the highest-authority
    // permission and auto-mode configuration. Protected in every mode, not only
    // where the auto-mode safety floor covers it (review P9).
    "managed-settings.json",
    // Injected into every turn's prompt (agents-md/index.ts), so a write to it
    // steers the agent (design §7).
    "agents.md",
]);

// `isWritingTool` / `WRITING_TOOLS` live in ./paths (the shared lower layer) so
// the safety floor and this gate share one source of truth; re-exported here as
// in the pincer original.
export { isWritingTool } from "./paths";

/**
 * Whether a path is protected. Matched on path *segments* so the check works
 * for absolute paths, cwd-relative ones, and any depth of nesting — a
 * `packages/app/.vscode/settings.json` is as protected as a top-level one.
 * Directories only known at runtime are passed to the pre-gate as
 * `protectedDirs` instead.
 */
export function isProtectedPath(candidate: string, cwd?: string): boolean {
    const forward = candidate.replace(/\\/g, "/").toLowerCase();
    // Compare relative to cwd when given, so an absolute in-project path and the
    // relative form of the same path behave identically.
    const relativeForm = cwd
        ? relative(resolve(cwd), resolve(cwd, candidate)).split(sep).join("/").toLowerCase()
        : forward;
    const forms = [forward, relativeForm].filter(Boolean);

    for (const form of forms) {
        const segments = form.split("/").filter((segment) => segment && segment !== ".");
        if (segments.length === 0) { continue; }

        const basename = segments[segments.length - 1];
        if (PROTECTED_FILES.has(basename)) { return true; }

        for (const dir of PROTECTED_DIRS) {
            const dirSegments = dir.split("/");
            for (let i = 0; i + dirSegments.length <= segments.length; i++) {
                if (!dirSegments.every((part, offset) => segments[i + offset] === part)) { continue; }
                // The match is only protective if something lives *under* the
                // directory — the write target has to be inside it.
                if (i + dirSegments.length >= segments.length) { continue; }
                const tail = segments.slice(i).join("/");
                if (PROTECTED_DIR_EXCEPTIONS.some((exception) => tail.startsWith(`${exception}/`) || tail === exception)) {
                    continue;
                }
                return true;
            }
        }
    }

    return false;
}
