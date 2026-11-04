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
import { forgetReads, ReadTracker, readTrackerFor } from "../features/ai/agent/tools/read-tracker";
import { createEditExecute, createMultiEditExecute, createReadExecute, createWriteExecute } from "../features/ai/agent/tools/text-editor";

describe("ReadTracker", () => {
    it("reports an existing file unread, fresh or stale by its content, under any spelling of its path", () => {
        const tracker = new ReadTracker();
        expect(tracker.status("/p/a.bal", "x")).toBe("unread");
        tracker.observe("/p/a.bal", "x");
        expect(tracker.status("/p/./a.bal", "x")).toBe("fresh");
        expect(tracker.status("/p/a.bal", "y")).toBe("stale");
        tracker.forget("/p/sub/../a.bal");
        expect(tracker.status("/p/a.bal", "x")).toBe("unread");
    });

    it("keeps at most 300 files, dropping the least recently seen", () => {
        const tracker = new ReadTracker();
        tracker.observe("/p/first.bal", "x");
        tracker.observe("/p/kept.bal", "x");
        for (let i = 0; i < 298; i++) { tracker.observe(`/p/${i}.bal`, "x"); }
        tracker.observe("/p/kept.bal", "x");
        tracker.observe("/p/last.bal", "x");
        expect(tracker.status("/p/first.bal", "x")).toBe("unread");
        expect(tracker.status("/p/kept.bal", "x")).toBe("fresh");
    });

    it("keeps one tracker per thread, forgotten on request", () => {
        readTrackerFor("t1").observe("/p/a.bal", "x");
        expect(readTrackerFor("t1").status("/p/a.bal", "x")).toBe("fresh");
        expect(readTrackerFor("t2").status("/p/a.bal", "x")).toBe("unread");
        forgetReads("t1");
        expect(readTrackerFor("t1").status("/p/a.bal", "x")).toBe("unread");
    });
});

describe("the file tools refuse to edit what the agent has not read", () => {
    const ORIGINAL = "function main() {\n}\n";
    let root: string;
    let mainPath: string;
    let reads: ReadTracker;

    function tools() {
        const ctx = { workspacePath: root, projectPath: root } as never;
        return {
            edit: createEditExecute(jest.fn(), root, [], new Set(), ctx, reads),
            batch: createMultiEditExecute(jest.fn(), root, [], new Set(), ctx, reads),
            write: createWriteExecute(jest.fn(), root, [], new Set(), ctx, reads),
            read: createReadExecute(jest.fn(), root, reads),
        };
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "read-before-edit-"));
        mainPath = path.join(root, "main.bal");
        fs.writeFileSync(mainPath, ORIGINAL);
        workspace.textDocuments = [];
        reads = new ReadTracker();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("refuses an edit of an unread file and leaves it unchanged, then applies it after a read", async () => {
        const { edit, read } = tools();
        const refused = await edit({ file_path: "main.bal", old_string: "main", new_string: "start" });
        expect(refused).toMatchObject({ success: false, error: "Error: File has not been read" });
        expect(refused.message).toContain("Read main.bal with file_read before using file_edit");
        expect(fs.readFileSync(mainPath, "utf-8")).toBe(ORIGINAL);

        await read({ file_path: "main.bal" });
        expect(await edit({ file_path: "main.bal", old_string: "main", new_string: "start" })).toMatchObject({ success: true });
        // Its own edit keeps the file read: a second edit needs no new read.
        expect(await edit({ file_path: "main.bal", old_string: "start", new_string: "begin" })).toMatchObject({ success: true });
    });

    it("refuses an edit of a file that changed since the read, until it is read again", async () => {
        const { edit, read } = tools();
        await read({ file_path: "main.bal" });
        fs.writeFileSync(mainPath, "function main() {\n    // the user's line\n}\n");
        const refused = await edit({ file_path: "main.bal", old_string: "main", new_string: "start" });
        expect(refused).toMatchObject({ success: false, error: "Error: File changed since it was read" });
        await read({ file_path: "main.bal", offset: 1, limit: 1 });
        expect(await edit({ file_path: "main.bal", old_string: "main", new_string: "start" })).toMatchObject({ success: true });
    });

    it("refuses a batch edit or an overwrite of an unread file, and lets a new file be edited after writing it", async () => {
        const { batch, write, edit } = tools();
        expect(await batch({ file_path: "main.bal", edits: [{ old_string: "main", new_string: "start" }] })).toMatchObject({ success: false, error: "Error: File has not been read" });
        expect(await write({ file_path: "main.bal", content: "x", overwrite: true })).toMatchObject({ success: false, error: "Error: File has not been read" });
        expect(fs.readFileSync(mainPath, "utf-8")).toBe(ORIGINAL);

        expect(await write({ file_path: "types.bal", content: "type Id int;\n" })).toMatchObject({ success: true });
        expect(await edit({ file_path: "types.bal", old_string: "int", new_string: "string" })).toMatchObject({ success: true });
    });
});
