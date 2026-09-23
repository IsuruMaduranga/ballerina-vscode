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

import { isProtectedPath, isWritingTool } from "../../features/ai/agent/auto-mode/protected-paths";

describe("isProtectedPath", () => {
    it("protects tooling and agent configuration directories", () => {
        for (const path of [
            ".git/hooks/pre-commit",
            ".git/config",
            ".claude/settings.json",
            ".vscode/tasks.json",
            ".husky/pre-push",
            ".mvn/wrapper/maven-wrapper.properties",
            ".devcontainer/devcontainer.json",
            ".idea/workspace.xml",
            ".yarn/releases/yarn.cjs",
            ".cargo/config.toml",
        ]) {
            expect(isProtectedPath(path)).toBe(true);
        }
    });

    it("protects shell, package-manager, and hook files by basename", () => {
        for (const path of [
            ".zshrc",
            "deep/nested/.bashrc",
            ".envrc",
            ".npmrc",
            ".pre-commit-config.yaml",
            "gradle-wrapper.properties",
            ".mcp.json",
            ".gitconfig",
            "lefthook.yml",
            "pyrightconfig.json",
        ]) {
            expect(isProtectedPath(path)).toBe(true);
        }
    });

    it("protects nested occurrences, not just top-level ones", () => {
        expect(isProtectedPath("packages/app/.vscode/settings.json")).toBe(true);
        expect(isProtectedPath("/abs/repo/.git/hooks/post-merge")).toBe(true);
    });

    it("leaves ordinary project files alone", () => {
        for (const path of ["src/index.ts", "README.md", "package.json", "docs/.gitkeep", "gitconfig"]) {
            expect(isProtectedPath(path)).toBe(false);
        }
    });

    it("protects all of .claude, with no worktree exception (that was One Code's own working space)", () => {
        expect(isProtectedPath(".claude/worktrees/feature/src/a.ts")).toBe(true);
        expect(isProtectedPath(".claude/settings.local.json")).toBe(true);
    });

    it("protects the WSO2 Integrator Copilot's own configuration and AGENTS.md (design §7)", () => {
        for (const path of [
            ".copilot/skills.config.json",
            ".agents/skills/my-skill/SKILL.md",
            "AGENTS.md",
            "agents.md",
            "packages/app/AGENTS.md",
            "/abs/repo/.mcp.json",
        ]) {
            expect(isProtectedPath(path)).toBe(true);
        }
        for (const path of ["Ballerina.toml", "main.bal", "tests/main_test.bal", "docs/agents.txt"]) {
            expect(isProtectedPath(path)).toBe(false);
        }
    });

    it("treats the directory itself as not-yet-a-write-target", () => {
        // A protected match only counts when something lives under the directory.
        expect(isProtectedPath(".vscode")).toBe(false);
        expect(isProtectedPath(".vscode/x")).toBe(true);
    });

    it("protects a .git file, the gitlink that retargets git (pincer SECURITY-REVIEW-2026-09-23 H2)", () => {
        // `gitdir: <path>` written into a subdirectory points `git -C sub …` at any repository.
        expect(isProtectedPath("sub/.git")).toBe(true);
        expect(isProtectedPath(".git/x")).toBe(true);
    });

    it("matches an absolute in-project path the same as its relative form", () => {
        const cwd = "/repo";
        expect(isProtectedPath("/repo/.claude/settings.json", cwd)).toBe(true);
        expect(isProtectedPath(".claude/settings.json", cwd)).toBe(true);
    });

    it("names the tools this check applies to", () => {
        expect(isWritingTool("file_write")).toBe(true);
        expect(isWritingTool("file_edit")).toBe(true);
        expect(isWritingTool("file_batch_edit")).toBe(true);
        expect(isWritingTool("file_read")).toBe(false);
        expect(isWritingTool("shell")).toBe(false);
    });
});

describe("run-at-login locations (PERMISSIONS-REVIEW-2026-09-05 M7)", () => {
    it("protects launchd agents, fish config and ~/.local/bin", () => {
        for (const path of [
            "/Users/x/Library/LaunchAgents/com.evil.plist",
            "~/.config/fish/config.fish",
            "/home/x/.local/bin/pi",
            ".local/bin/tool",
        ]) {
            expect(isProtectedPath(path)).toBe(true);
        }
        expect(isProtectedPath("/Users/x/Library/Preferences/x.plist")).toBe(false);
        expect(isProtectedPath("/home/x/.local/share/data.db")).toBe(false);
    });
});
