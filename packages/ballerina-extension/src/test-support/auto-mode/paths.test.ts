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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparablePath } from "../../features/ai/agent/auto-mode/shared-paths";
import {
    containmentRoots,
    isGuardedWritePath,
    isWritingTool,
    pathArgument,
    removalLoses,
    resolveForContainment,
    resolveThroughLinks,
    touchesGuardedPath,
} from "../../features/ai/agent/auto-mode/paths";

/**
 * pathArgument is the single place that knows which input field carries a file
 * tool's target path — it feeds the read-before-write guard, the permission-rule
 * subject, the auto-mode classifier transcript, and worktree redirection. It
 * must recognise Claude Code's field names, including `notebook_path`, or a
 * CC-shaped notebook_edit slips past every path-based gate (code-review).
 */
describe("pathArgument recognises every path field name", () => {
    it("reads a `path` field", () => {
        expect(pathArgument({ path: "src/a.ts" })).toBe("src/a.ts");
    });

    it("reads Claude Code's `file_path`", () => {
        expect(pathArgument({ file_path: "src/b.ts" })).toBe("src/b.ts");
    });

    it("reads notebook_edit's `notebook_path`", () => {
        expect(pathArgument({ notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
    });

    it("prefers `path` when several are present", () => {
        expect(pathArgument({ path: "p", file_path: "f", notebook_path: "n" })).toBe("p");
    });

    it("returns undefined when no path field is set or it is not a string", () => {
        expect(pathArgument({})).toBeUndefined();
        expect(pathArgument(undefined)).toBeUndefined();
        expect(pathArgument({ notebook_path: 42 })).toBeUndefined();
    });
});

describe("isWritingTool names BI's file tools", () => {
    it("covers file_write, file_edit and file_batch_edit, not file_read or the shell", () => {
        for (const name of ["file_write", "file_edit", "file_batch_edit"]) {
            expect(isWritingTool(name)).toBe(true);
        }
        for (const name of ["file_read", "shell", "powershell", "edit", "write"]) {
            expect(isWritingTool(name)).toBe(false);
        }
    });
});

describe("resolveForContainment and resolveThroughLinks", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bi-paths-")));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    (process.platform === "win32" ? it.skip : it)("stops a symlink cycle after a bounded number of hops instead of overflowing the stack", () => {
        const path = join(dir, "cycle.md");
        symlinkSync(path, path);
        const started = Date.now();
        expect(resolveThroughLinks(path)).toBe(join(dir, "cycle.md"));
        expect(resolveForContainment(path)).toBe(comparablePath(join(dir, "cycle.md")));
        expect(Date.now() - started).toBeLessThan(1_000);
        const a = join(dir, "a");
        const b = join(dir, "b");
        symlinkSync(b, a);
        symlinkSync(a, b);
        expect(resolveForContainment(a)).toBeDefined();
    });

    (process.platform === "win32" ? it.skip : it)("keeps the filesystem's own spelling in resolveThroughLinks and the comparison form in resolveForContainment", () => {
        mkdirSync(join(dir, "Mixed"));
        expect(resolveThroughLinks(join(dir, "Mixed", "New.txt"))).toBe(join(dir, "Mixed", "New.txt"));
        expect(resolveForContainment(join(dir, "Mixed", "New.txt"))).toBe(comparablePath(join(dir, "Mixed", "New.txt")));
    });
});

describe("the shared write guards", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bi-guards-")));
    const cwd = join(dir, "project");
    for (const sub of [join(cwd, "src"), join(cwd, "vendor", "lib", ".git"), join(cwd, ".vscode")]) { mkdirSync(sub, { recursive: true }); }
    writeFileSync(join(cwd, ".vscode", "settings.json"), "{}");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const resolved = (path: string) => resolveForContainment(path) as string;

    it("guards protected, credential and execution-primitive paths, and runtime-protected directories", () => {
        expect(isGuardedWritePath(join(cwd, ".vscode", "settings.json"), cwd)).toBe(true);
        expect(isGuardedWritePath(join(cwd, ".env"), cwd)).toBe(true);
        expect(isGuardedWritePath(join(cwd, "Config.toml"), cwd)).toBe(true);
        expect(isGuardedWritePath(join(cwd, ".git", "hooks", "pre-commit"), cwd)).toBe(true);
        expect(isGuardedWritePath(join(cwd, "src", "main.bal"), cwd)).toBe(false);
        expect(isGuardedWritePath(join(cwd, "src", "main.bal"), cwd, [join(cwd, "src")])).toBe(true);
    });

    it("counts removing a working root, a directory holding a .git, or one holding a guarded path as a loss", () => {
        const roots = [resolved(cwd)];
        expect(removalLoses(cwd, resolved(cwd), roots, cwd)).toBe(true);
        expect(removalLoses(join(cwd, "vendor"), resolved(join(cwd, "vendor")), roots, cwd)).toBe(true);
        expect(removalLoses(join(cwd, ".vscode"), resolved(join(cwd, ".vscode")), roots, cwd)).toBe(true);
        expect(removalLoses(join(cwd, "src"), resolved(join(cwd, "src")), roots, cwd)).toBe(false);
    });

    it("recognises a working root given in its raw spelling once the roots are in comparison form", () => {
        // The gates get writable roots (the scratchpad) as configured; `resolved` is case-folded on macOS and Windows.
        const scratch = join(dir, "Scratch-Pad");
        mkdirSync(scratch);
        const roots = containmentRoots([cwd, scratch]);
        expect(removalLoses(scratch, resolved(scratch), roots, cwd)).toBe(true);
        expect(removalLoses(join(scratch, "out"), resolved(join(scratch, "out")), roots, cwd)).toBe(false);
    });

    it("hands the guard each directory entry and counts an exhausted walk as touching one", () => {
        const seen: string[] = [];
        expect(touchesGuardedPath(cwd, cwd, (_path, entry) => { seen.push(entry.name); return false; })).toBe(false);
        expect(seen).toEqual(expect.arrayContaining(["src", "vendor", ".vscode", "settings.json"]));
        expect(touchesGuardedPath(cwd, cwd, () => false, 2)).toBe(true);
    });
});
