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
 * auto-mode/sensitive.ts, the one credential denylist. pincer tests it only
 * through its shell-analysis suite; these pin the list directly, including
 * BI's `Config.toml` (design §7: it holds the WSO2 LLM-proxy token).
 */
import { isExecutionPrimitivePath, isSensitiveBasename, isSensitivePath } from "../../features/ai/agent/auto-mode/sensitive";

describe("isSensitiveBasename", () => {
    it("names BI's Config.toml in any case, like file_read's restriction", () => {
        for (const name of ["Config.toml", "config.toml", "CONFIG.TOML"]) {
            expect(isSensitiveBasename(name)).toBe(true);
        }
        for (const name of ["Ballerina.toml", "Dependencies.toml", "Cloud.toml", "main.bal"]) {
            expect(isSensitiveBasename(name)).toBe(false);
        }
    });

    it("names env files, keys and credential stores", () => {
        for (const name of [".env", ".env.local", "id_rsa", "id_ed25519.pub", "server.pem", "store.p12", "auth.json", ".netrc", ".npmrc"]) {
            expect(isSensitiveBasename(name)).toBe(true);
        }
        expect(isSensitiveBasename("environment.bal")).toBe(false);
        expect(isSensitiveBasename("")).toBe(false);
    });
});

describe("isSensitivePath", () => {
    it("matches credential directories as path segments, in both separator spellings", () => {
        for (const path of ["~/.aws/credentials", "/Users/x/.ssh", ".kube", "/home/u/.config/gcloud/x", "C:\\Users\\x\\.ssh\\id_rsa"]) {
            expect(isSensitivePath(path)).toBe(true);
        }
    });

    it("matches a Config.toml anywhere in a workspace", () => {
        expect(isSensitivePath("/repo/pkg/Config.toml")).toBe(true);
        expect(isSensitivePath("Config.toml")).toBe(true);
    });

    it("matches ~/.ballerina/Settings.toml, which holds the Central access token, but not the bala cache beside it", () => {
        expect(isSensitivePath("/Users/x/.ballerina/Settings.toml")).toBe(true);
        expect(isSensitivePath("~/.ballerina/Settings.toml")).toBe(true);
        expect(isSensitivePath("/repo/Settings.toml")).toBe(false);
    });

    it("treats /proc and /sys as sensitive roots", () => {
        expect(isSensitivePath("/proc/self/environ")).toBe(true);
        expect(isSensitivePath("/sys")).toBe(true);
        expect(isSensitivePath("/process/x")).toBe(false);
    });

    it("leaves ordinary project and library paths alone", () => {
        for (const path of ["/repo/main.bal", "Ballerina.toml", "/Users/x/.ballerina/repositories/central.ballerina.io/bala/x", ""]) {
            expect(isSensitivePath(path)).toBe(false);
        }
    });
});

describe("isExecutionPrimitivePath", () => {
    it("flags git hooks and config, editor run configuration and build entry points", () => {
        for (const path of [".git/hooks/pre-commit", "/repo/.git/config", ".vscode/tasks.json", ".github/workflows/ci.yml", "Makefile", ".envrc"]) {
            expect(isExecutionPrimitivePath(path)).toBe(true);
        }
        for (const path of ["main.bal", ".git/HEAD", ".vscode/notes.md"]) {
            expect(isExecutionPrimitivePath(path)).toBe(false);
        }
    });
});
