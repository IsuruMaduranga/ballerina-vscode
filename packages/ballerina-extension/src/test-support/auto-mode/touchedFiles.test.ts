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
 * The touched-file scan around a shell command, against real
 * commands: an in-place `sed -i`, a `git checkout --`, a new package, a delete.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    createdPackages,
    diffSnapshots,
    hasTouchedFiles,
    snapshotWorkspace,
} from "../../features/ai/agent/shell/touched-files";

let cwd: string;
const posixOnly = process.platform === "win32" ? it.skip : it;
const bash = (command: string) => execFileSync("/bin/bash", ["-c", command], { cwd, stdio: "ignore" });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });

/** Pushes a file's mtime into the past so a rewrite within the same tick still reads as a change. */
const age = (file: string) => utimesSync(join(cwd, file), new Date(0), new Date(0));

beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "bi-touched-")));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "main.bal"), "import ballerina/io;\n");
    writeFileSync(join(cwd, "src", "b.bal"), "b\n");
    age("main.bal");
    age("src/b.bal");
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
});

const around = (command: () => void) => {
    const before = snapshotWorkspace(cwd);
    command();
    return diffSnapshots(before, snapshotWorkspace(cwd));
};

describe("snapshotWorkspace / diffSnapshots", () => {
    it("reports nothing for a command that writes nothing", () => {
        const touched = around(() => bash("ls; cat main.bal"));
        expect(hasTouchedFiles(touched)).toBe(false);
    });

    posixOnly("sees an in-place sed edit", () => {
        const touched = around(() => bash("sed -i.bak 's/io/log/' main.bal && rm main.bal.bak"));
        expect(touched).toEqual({ created: [], changed: ["main.bal"], deleted: [] });
    });

    posixOnly("sees a git checkout -- that restores a dirty file", () => {
        git("init", "-q");
        git("add", ".");
        git("commit", "-q", "-m", "init");
        writeFileSync(join(cwd, "src", "b.bal"), "changed\n");
        age("src/b.bal");
        const touched = around(() => git("checkout", "--", "src/b.bal"));
        expect(touched.changed).toEqual(["src/b.bal"]);
    });

    it("sees created and deleted files, and skips .git, target and node_modules", () => {
        const touched = around(() => {
            mkdirSync(join(cwd, "target", "bin"), { recursive: true });
            writeFileSync(join(cwd, "target", "bin", "app.jar"), "x");
            mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
            writeFileSync(join(cwd, "node_modules", "x", "i.js"), "x");
            writeFileSync(join(cwd, "types.bal"), "type T record {};\n");
            rmSync(join(cwd, "src", "b.bal"));
        });
        expect(touched).toEqual({ created: ["types.bal"], changed: [], deleted: ["src/b.bal"] });
    });

    it("does not call files past a truncated first walk new, nor call missing files deleted after a truncated second walk", () => {
        const before = snapshotWorkspace(cwd, 1);
        expect(before.truncated).toBe(true);
        writeFileSync(join(cwd, "z.bal"), "z\n");
        expect(diffSnapshots(before, snapshotWorkspace(cwd)).created).toEqual([]);
        const full = snapshotWorkspace(cwd);
        expect(diffSnapshots(full, snapshotWorkspace(cwd, 1)).deleted).toEqual([]);
    });
});

describe("createdPackages", () => {
    it("names each new package and its .bal files relative to it", () => {
        expect(createdPackages({
            created: ["Ballerina.toml", "main.bal", "orders/Ballerina.toml", "orders/main.bal", "orders/modules/db/db.bal", "notes.md"],
            changed: [],
            deleted: [],
        })).toEqual([
            { packageDir: "", balFiles: ["main.bal", "orders/main.bal", "orders/modules/db/db.bal"] },
            { packageDir: "orders", balFiles: ["main.bal", "modules/db/db.bal"] },
        ]);
    });

    it("finds none when no Ballerina.toml was created", () => {
        expect(createdPackages({ created: ["main.bal"], changed: ["Ballerina.toml"], deleted: [] })).toEqual([]);
    });
});
