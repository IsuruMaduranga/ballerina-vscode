/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * file_write clears a file with empty content (the agent's "start fresh") and reaches the project
 * dotfiles in its allowlist; `.env` stays out.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const addToIntegration = jest.fn(async (root: string, changes: { filePath: string; content: string }[]) => {
    for (const change of changes) {
        fs.writeFileSync(path.join(root, change.filePath), change.content);
    }
});
jest.mock("../rpc-managers/ai-panel/utils", () => ({ addToIntegration }));
jest.mock("../rpc-managers/diagram-validity", () => ({ recordAiTouchedFile: jest.fn() }));
jest.mock("../features/ai/utils/project/ls-schema-notifications", () => ({ seedNewPackageBaseline: jest.fn() }));

import { workspace } from "./__mocks__/vscode";
import { ReadTracker } from "../features/ai/agent/tools/read-tracker";
import { createReadExecute, createWriteExecute } from "../features/ai/agent/tools/text-editor";

describe("file_write", () => {
    let root: string;
    let reads: ReadTracker;
    const tools = () => {
        const ctx = { workspacePath: root, projectPath: root } as never;
        return { write: createWriteExecute(jest.fn(), root, [], new Set(), ctx, reads), read: createReadExecute(jest.fn(), root, reads) };
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "file-write-clear-"));
        fs.writeFileSync(path.join(root, "main.bal"), "function main() {\n}\n");
        workspace.textDocuments = [];
        reads = new ReadTracker();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("clears a file it has read when asked to overwrite it with empty content", async () => {
        const { write, read } = tools();
        await read({ file_path: "main.bal" });
        expect(await write({ file_path: "main.bal", content: "", overwrite: true })).toMatchObject({ success: true, action: "updated" });
        expect(fs.readFileSync(path.join(root, "main.bal"), "utf-8")).toBe("");
    });

    it("still refuses to clear an existing file without overwrite", async () => {
        const { write, read } = tools();
        await read({ file_path: "main.bal" });
        expect(await write({ file_path: "main.bal", content: "" })).toMatchObject({ success: false, error: "Error: File already exists with content" });
        expect(fs.readFileSync(path.join(root, "main.bal"), "utf-8")).toBe("function main() {\n}\n");
    });

    it("creates an empty new file", async () => {
        expect(await tools().write({ file_path: "types.bal", content: "" })).toMatchObject({ success: true, action: "created" });
        expect(fs.readFileSync(path.join(root, "types.bal"), "utf-8")).toBe("");
    });

    it("writes the allowed dotfiles but not .env", async () => {
        const { write } = tools();
        expect(await write({ file_path: ".gitignore", content: "target/\n" })).toMatchObject({ success: true });
        expect(await write({ file_path: ".env", content: "KEY=x\n" })).toMatchObject({ success: false, error: "Error: Invalid file path" });
    });
});
