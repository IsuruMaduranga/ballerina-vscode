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

import { isWritingTool, pathArgument } from "../../features/ai/agent/auto-mode/paths";

/**
 * pathArgument is the single place that knows which input field carries a file
 * tool's target path — it feeds the read-before-write guard, the permission-rule
 * subject, the auto-mode classifier transcript, and worktree redirection. It
 * must recognise Claude Code's field names, including `notebook_path`, or a
 * CC-shaped notebook_edit slips past every path-based gate (code-review).
 */
describe("pathArgument recognises every path field name", () => {
    it("reads pi's `path`", () => {
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
