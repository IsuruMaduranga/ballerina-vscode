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

import { join, resolve } from "path";
import { absoluteFrom, comparablePath, gitBashPathToNative, isPathAtOrUnder, msysPathToWindows, system32Path, tryRealpath } from "../../features/ai/agent/auto-mode/shared-paths";

/**
 * Git Bash spells absolute paths the MSYS way; a bash command line on Windows
 * carries them (`echo x > /c/proj/out`), and `path.resolve` misreads them as
 * `<drive>:\c\proj\out`. The converter is pure so its shapes are pinned on
 * every platform; the win32 gate around it is pinned per platform.
 */
describe("msysPathToWindows", () => {
    const TMP = "C:\\Users\\x\\AppData\\Local\\Temp";

    it("maps a drive-letter root, with or without a tail", () => {
        expect(msysPathToWindows("/c/Users/x/proj/a.ts", TMP)).toBe("C:\\Users\\x\\proj\\a.ts");
        expect(msysPathToWindows("/d/", TMP)).toBe("D:\\");
        expect(msysPathToWindows("/d", TMP)).toBe("D:\\");
    });

    it("maps the cygdrive form Claude Code also accepts", () => {
        expect(msysPathToWindows("/cygdrive/c/proj", TMP)).toBe("C:\\proj");
    });

    it("maps /tmp onto the user's temp dir (Git for Windows' usertemp mount)", () => {
        expect(msysPathToWindows("/tmp/out.txt", TMP)).toBe(join(TMP, "out.txt"));
        expect(msysPathToWindows("/tmp", TMP)).toBe(TMP);
    });

    it("leaves every other spelling alone", () => {
        for (const p of ["/usr/bin/env", "/etc/hosts", "/tmpfile", "/cc/x", "C:/proj/a.ts", "C:\\proj\\a.ts", "rel/a.ts", "~/x", "//server/share/x"]) {
            expect(msysPathToWindows(p, TMP)).toBe(p);
        }
    });

    it("is gated to win32", () => {
        const converted = gitBashPathToNative("/c/proj/a.ts");
        if (process.platform === "win32") expect(converted).toBe("C:\\proj\\a.ts");
        else expect(converted).toBe("/c/proj/a.ts");
    });
});

describe("absoluteFrom", () => {
    it("keeps an absolute path and joins a relative one onto the base", () => {
        const abs = resolve("/repo/src/a.ts");
        expect(absoluteFrom("/elsewhere", abs)).toBe(abs);
        expect(absoluteFrom(resolve("/repo"), join("src", "a.ts"))).toBe(join(resolve("/repo"), "src", "a.ts"));
    });
});

describe("containment forms", () => {
    it("treats a path as at or under itself and its ancestors, never a sibling prefix", () => {
        const root = resolve("/repo");
        expect(isPathAtOrUnder(root, root)).toBe(true);
        expect(isPathAtOrUnder(join(root, "src", "a.bal"), root)).toBe(true);
        expect(isPathAtOrUnder(resolve("/repo-other/a.bal"), root)).toBe(false);
        expect(isPathAtOrUnder(resolve("/"), root)).toBe(false);
    });

    it("drops trailing separators and folds case where the filesystem does", () => {
        expect(comparablePath(join(resolve("/repo"), "src") + "/")).toBe(comparablePath(join(resolve("/repo"), "src")));
        const folded = comparablePath(resolve("/Repo/SRC")) === comparablePath(resolve("/repo/src"));
        expect(folded).toBe(process.platform !== "linux");
    });

    it("resolves a real path and reports an unresolvable one as undefined", () => {
        expect(tryRealpath(process.cwd())).toBeDefined();
        expect(tryRealpath(join(process.cwd(), "no-such-dir-for-this-test"))).toBeUndefined();
    });

    it("addresses Windows system binaries under SystemRoot, never through PATH", () => {
        expect(system32Path("taskkill.exe", { SystemRoot: "D:\\Win" })).toBe(join("D:\\Win", "System32", "taskkill.exe"));
        expect(system32Path("cmd.exe", {})).toBe(join("C:\\Windows", "System32", "cmd.exe"));
    });
});
