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
 * @jest-environment node
 *
 * `bal pack` writes more than the bala into target/bala (a `.cdx.json` SBOM sorts ahead of it), and
 * older packs leave their balas behind, so the push step must pick the bala the pack just wrote.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getBalaPath } from "../rpc-managers/common/bala";

let projectDir: string;
let balaDir: string;
beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "bala-path-test-"));
    balaDir = path.join(projectDir, "target", "bala");
});
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

function writeFile(name: string, mtimeSeconds = 1_700_000_000): string {
    fs.mkdirSync(balaDir, { recursive: true });
    const filePath = path.join(balaDir, name);
    fs.writeFileSync(filePath, "");
    fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
}

describe("getBalaPath", () => {
    it("skips the SBOM that sorts ahead of the bala", () => {
        writeFile("alib1-0.1.0.cdx.json");
        const bala = writeFile("madusha-alib1-any-0.1.0.bala");
        expect(fs.readdirSync(balaDir)[0]).toBe("alib1-0.1.0.cdx.json");
        expect(getBalaPath(projectDir)).toBe(bala);
    });

    it("returns the most recently written bala when stale ones remain", () => {
        writeFile("madusha-alib1-any-0.1.0.bala", 1_700_000_000);
        const latest = writeFile("madusha-alib1-any-0.2.0.bala", 1_700_000_100);
        writeFile("madusha-alib1-java21-0.1.5.bala", 1_700_000_050);
        expect(getBalaPath(projectDir)).toBe(latest);
    });

    it("ignores directories named like a bala", () => {
        fs.mkdirSync(path.join(balaDir, "extracted.bala"), { recursive: true });
        const bala = writeFile("madusha-alib1-any-0.1.0.bala");
        expect(getBalaPath(projectDir)).toBe(bala);
    });

    it("returns null when there is no bala to push", () => {
        expect(getBalaPath(projectDir)).toBeNull();
        writeFile("alib1-0.1.0.cdx.json");
        expect(getBalaPath(projectDir)).toBeNull();
    });
});
