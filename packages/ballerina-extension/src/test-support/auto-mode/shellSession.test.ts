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

/** The per-run shell setup the prompt and the tool registry share. */

import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { shellPromptSection, shellRunSetup } from "../../features/ai/agent/shell/shell-session";

let root: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-shell-session-")));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("shellRunSetup", () => {
    it("has no shell tool on Windows or without a workspace root", () => {
        expect(shellRunSetup(join(root, "p"), "t", { platform: "win32" })).toBeUndefined();
        expect(shellRunSetup("", "t", { platform: "darwin" })).toBeUndefined();
    });

    it("creates the scratchpad and makes it the one writable root and a readable root", () => {
        const scratchpadDir = join(root, "scratch", "t");
        const home = join(root, "home");
        const setup = shellRunSetup(join(root, "p"), "t", { platform: "linux", home, env: {}, scratchpadDir });
        expect(setup).toBeDefined();
        expect(existsSync(scratchpadDir)).toBe(true);
        expect(setup!.scratchpadDir).toBe(scratchpadDir);
        expect(setup!.writableRoots).toEqual([scratchpadDir]);
        expect(setup!.readableRoots).toEqual([
            scratchpadDir,
            join(home, ".ballerina", "repositories"),
            join(home, ".ballerina", "copilot", "lib-docs"),
        ]);
        expect(setup!.cwd).toBe(join(root, "p"));
        expect(setup!.promptSection).toContain(scratchpadDir);
    });

    it("follows BALLERINA_HOME_DIR for the bala cache", () => {
        const home = join(root, "home");
        const setup = shellRunSetup(join(root, "p"), "t", { platform: "linux", home, env: { BALLERINA_HOME_DIR: join(root, "bh") }, scratchpadDir: join(root, "s") });
        expect(setup!.readableRoots).toContain(join(root, "bh", "repositories"));
    });
});

describe("shellPromptSection", () => {
    it("names the tool and leaves out the scratchpad section without one", () => {
        expect(shellPromptSection(undefined)).toContain("The shell tool runs bash commands");
        expect(shellPromptSection(undefined)).not.toContain("# Scratchpad directory");
        expect(shellPromptSection("/s")).toContain("# Scratchpad directory");
    });
});
