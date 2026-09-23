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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ballerinaHomeFromEnv, readableRoots } from "../../features/ai/agent/auto-mode/readable-roots";
import { analyzeShellCommand } from "../../features/ai/agent/auto-mode/shell-analysis";
import { forwardSlashes as sh } from "../../features/ai/agent/auto-mode/shared-paths";
import {
    ensureScratchpadDir,
    projectSlug,
    resolveTmpRoot,
    scratchpadDir,
    scratchpadPromptSection,
    threadScratchpadDir,
} from "../../features/ai/agent/shell/scratchpad";

const posixOnly = process.platform === "win32" ? it.skip : it;

let root: string;
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-roots-")));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("scratchpad", () => {
    it("builds Claude Code's shape under the WSO2 Integrator Copilot's owner directory", () => {
        const tmp = join(root, "tmp");
        const project = join(root, "work", "my proj");
        expect(scratchpadDir(tmp, 501, project, "t-1")).toBe(join(tmp, "wso2-integrator-copilot-501", projectSlug(project), "t-1", "scratchpad"));
        expect(scratchpadDir(tmp, undefined, project, "t-1")).toBe(join(tmp, "wso2-integrator-copilot", projectSlug(project), "t-1", "scratchpad"));
    });

    it("slugs the project and the thread id, so neither can add a path segment", () => {
        expect(projectSlug("/Users/me/my proj")).toBe("-Users-me-my-proj");
        expect(projectSlug("C:\\Users\\me\\proj")).toBe("C--Users-me-proj");
        const tmp = join(root, "tmp");
        expect(scratchpadDir(tmp, 1, "/p", "../../etc")).toBe(join(tmp, "wso2-integrator-copilot-1", "-p", "------etc", "scratchpad"));
    });

    posixOnly("resolves the temp root through its symlink", () => {
        expect(resolveTmpRoot()).toBe(realpathSync("/tmp"));
        expect(threadScratchpadDir("/p", "t").startsWith(realpathSync("/tmp"))).toBe(true);
    });

    posixOnly("creates the directory owner-only and returns it", () => {
        const dir = join(root, "a", "b", "scratchpad");
        expect(ensureScratchpadDir(dir)).toBe(dir);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        // A path under a file cannot be created.
        expect(ensureScratchpadDir(join("/dev/null", "x"))).toBeUndefined();
    });

    it("names the directory in the prompt section", () => {
        expect(scratchpadPromptSection("/s/p")).toContain("`/s/p`");
    });
});

describe("readable roots", () => {
    it("lists the scratchpad, the bala cache and the Librarian's docs", () => {
        const home = join(root, "home");
        expect(readableRoots({ home, scratchpadDir: join(root, "s") })).toEqual([
            join(root, "s"),
            join(home, ".ballerina", "repositories"),
            join(home, ".ballerina", "copilot", "lib-docs"),
        ]);
        expect(readableRoots({ home })).toHaveLength(2);
    });

    it("takes the bala cache from the Ballerina home", () => {
        const home = join(root, "home");
        expect(ballerinaHomeFromEnv(home, {})).toBe(join(home, ".ballerina"));
        expect(ballerinaHomeFromEnv(home, { BALLERINA_HOME_DIR: "" })).toBe(join(home, ".ballerina"));
        expect(ballerinaHomeFromEnv(home, { BALLERINA_HOME_DIR: join(root, "bal") })).toBe(join(root, "bal"));
        expect(readableRoots({ home, ballerinaHome: join(root, "bal") })[0]).toBe(join(root, "bal", "repositories"));
    });

    posixOnly("resolves each root to its realpath, so the gate's comparison holds", () => {
        const real = join(root, "real-home");
        mkdirSync(join(real, ".ballerina", "repositories"), { recursive: true });
        const link = join(root, "home");
        symlinkSync(real, link);
        expect(readableRoots({ home: link })[0]).toBe(join(real, ".ballerina", "repositories"));
    });

    posixOnly("clears a read in the bala cache through a symlinked home", () => {
        const real = join(root, "real-home");
        const cache = join(real, ".ballerina", "repositories", "central.ballerina.io");
        mkdirSync(cache, { recursive: true });
        const home = join(root, "home");
        symlinkSync(real, home);
        const cwd = join(root, "project");
        mkdirSync(cwd);
        const command = `grep -rn Client ${sh(home)}/.ballerina/repositories/central.ballerina.io`;
        expect(analyzeShellCommand({ command, cwd, home, readableRoots: readableRoots({ home }) }).verdict).toBe("safe");
    });
});
