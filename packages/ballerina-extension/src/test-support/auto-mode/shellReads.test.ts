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
 * A bash command that showed a whole file counts as a read (tools/shell-reads.ts): candidate
 * extraction, the directory a `cd` sets, the full-content check, and the snapshot around a command.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { ReadTracker } from "../../features/ai/agent/tools/read-tracker";
import { expandCandidate, recordShellReads, shellReadCandidates, shellReadPaths, shellReadSnapshot, shownInFull } from "../../features/ai/agent/tools/shell-reads";

const CWD = resolve("/work");
const HOME = resolve("/home/me");
/** The words a command may have printed, whatever directory they resolve in. */
const words = (command: string) => shellReadCandidates(command, CWD, HOME).map((candidate) => candidate.word);
/** The absolute paths a command may have printed, with no glob to expand. */
const paths = (command: string) => shellReadPaths(command, CWD, HOME, () => []);
const at = (...parts: string[]) => resolve(CWD, ...parts);

describe("shellReadCandidates", () => {
    it("takes the file arguments of cat, head, tail and sed", () => {
        expect(words("cat a.bal b.bal")).toEqual(expect.arrayContaining(["a.bal", "b.bal"]));
        expect(words("cat Ballerina.toml && git status --short")).toContain("Ballerina.toml");
        expect(words("head -n 50 modules/x/x.bal")).toContain("modules/x/x.bal");
        expect(words("sed -n '1,200p' notes.md")).toContain("notes.md");
        expect(words("/bin/cat a.txt")).toContain("a.txt");
        expect(words("LC_ALL=C cat a.txt")).toContain("a.txt");
    });

    it("takes the words a reader loops over, since the content check decides", () => {
        expect(words('for f in main.bal types.bal; do printf "%s" "$f"; cat "$f"; done')).toEqual(expect.arrayContaining(["main.bal", "types.bal"]));
        const absolute = words('for f in /tmp/a.txt; do cat "$f"; done');
        expect(absolute).toContain("/tmp/a.txt");
        expect(absolute).not.toContain("tmp/a.txt");
    });

    it("offers nothing without a reader command, or when the line does not parse", () => {
        expect(words("grep -n foo a.bal")).toEqual([]);
        expect(words("ls src && git diff a.bal")).toEqual([]);
        expect(words("cat 'unbalanced")).toEqual([]);
    });
});

describe("shellReadPaths: the directory a cd sets", () => {
    it("resolves a reader after a literal cd in the directory it moved to", () => {
        expect(paths("cd src && cat app.bal")).toContain(at("src", "app.bal"));
        expect(paths("cd src && cat app.bal")).not.toContain(at("app.bal"));
        expect(paths("cd src; cat app.bal")).toContain(at("src", "app.bal"));
        expect(paths("cd -- src && cat app.bal")).toContain(at("src", "app.bal"));
        expect(paths("cd /srv/repo && cat app.bal")).toContain(resolve("/srv/repo", "app.bal"));
        expect(paths("cd ~/proj && cat app.bal")).toContain(resolve(HOME, "proj", "app.bal"));
    });

    it("leaves a reader after a cd that runs only once an earlier step succeeded unresolved (no && list tracking)", () => {
        // The reference resolves it in src; a miss here costs one re-read, never a wrong certification.
        expect(paths("git pull && cd src && cat app.bal").filter((path) => path.endsWith("app.bal"))).toEqual([]);
        expect(paths("cd src/lib && cd .. && cat app.bal").filter((path) => path.endsWith("app.bal"))).toEqual([]);
    });

    it("resolves the words a reader loops over in the reader's directory", () => {
        const found = paths('cd src && for f in a.bal b.bal; do cat "$f"; done');
        expect(found).toEqual(expect.arrayContaining([at("src", "a.bal"), at("src", "b.bal")]));
        expect(found).not.toContain(at("a.bal"));
    });

    it("keeps a cd inside a subshell or a substitution out of the commands after it", () => {
        expect(paths("(cd src && cat a.bal); cat b.bal")).toEqual(expect.arrayContaining([at("src", "a.bal"), at("b.bal")]));
        expect(paths("(cd src && ls); cat b.bal")).toContain(at("b.bal"));
        expect(paths("(cd src && ls); cat b.bal")).not.toContain(at("src", "b.bal"));
        expect(paths('echo "$(cd src)"; cat b.bal')).toContain(at("b.bal"));
        expect(paths('echo "$(cd src)"; cat b.bal')).not.toContain(at("src", "b.bal"));
    });

    it.each([
        ["a variable target", 'cd "$DIR" && cat app.bal'],
        ["a substitution target", "cd $(git rev-parse --show-toplevel) && cat app.bal"],
        ["the previous directory", "cd - && cat app.bal"],
        ["a glob target", "cd sr* && cat app.bal"],
        ["another user's home", "cd ~root && cat app.bal"],
        ["an option", "cd -P src && cat app.bal"],
        ["two arguments", "cd src lib; cat app.bal"],
        ["an empty target", "cd '' && cat app.bal"],
        ["pushd", "pushd src && cat app.bal"],
        ["popd", "popd; cat app.bal"],
        ["a wrapper", "builtin cd src && cat app.bal"],
        ["an assignment prefix", "CDPATH=/srv cd src && cat app.bal"],
        ["a cd that may not run", "test -d src && cd src; cat app.bal"],
        ["a cd after ||", "true || cd src && cat app.bal"],
        ["a negated cd", "! cd src && cat app.bal"],
        ["a cd in an if branch", "if true; then cd src; fi; cat app.bal"],
        ["a cd last in a pipeline (lastpipe)", "echo | cd src; cat app.bal"],
        ["a cd in a loop", "for d in a b; do cat app.bal; cd src; done"],
        ["a backgrounded cd", "cd src & cat app.bal"],
        ["eval", "eval cd src; cat app.bal"],
        ["source", "source env.sh; cat app.bal"],
        ["a function that may replace cd", "cd() { :; }; cd src; cat app.bal"],
    ])("leaves a reader after %s unresolved, never guessed", (_, command) => {
        expect(paths(command).filter((path) => path.endsWith("app.bal"))).toEqual([]);
    });

    it("re-anchors on a later absolute cd", () => {
        expect(paths('cd "$DIR"; cd /srv/repo; cat app.bal')).toContain(resolve("/srv/repo", "app.bal"));
    });

    it("expands a glob in the reader's directory", () => {
        const readdir = (dir: string) => (dir === at("src") ? ["a.bal", "b.md"] : []);
        const found = shellReadPaths('cd src && for f in *.bal; do cat "$f"; done', CWD, HOME, readdir);
        expect(found).toContain(at("src", "a.bal"));
        expect(found).not.toContain(at("src", "b.md"));
    });
});

describe("expandCandidate", () => {
    const readdir = (dir: string) => (dir === "src" ? ["a.bal", "b.bal", "notes.md", ".hidden.bal"] : dir === "." ? ["Ballerina.toml", "x.bal"] : []);

    it("expands a glob in the last component against that directory", () => {
        expect(expandCandidate("src/*.bal", readdir)).toEqual(["src/a.bal", "src/b.bal"]);
        expect(expandCandidate("*.bal", readdir)).toEqual(["x.bal"]);
    });

    it("passes a plain word through and expands no glob in a directory component", () => {
        expect(expandCandidate("src/a.bal", readdir)).toEqual(["src/a.bal"]);
        expect(expandCandidate("*/a.bal", readdir)).toEqual([]);
    });
});

describe("shownInFull", () => {
    it("needs the whole content in the output, trailing whitespace aside", () => {
        expect(shownInFull("line one\nline two", "line one\nline two\n")).toBe(true);
        expect(shownInFull("==> a <==\nline one\nline two\n\nexit 0", "line one\nline two\n")).toBe(true);
        expect(shownInFull("line one", "line one\nline two\n")).toBe(false);
        expect(shownInFull("     1\tline one\n     2\tline two", "line one\nline two\n")).toBe(false);
    });

    it("never counts an empty or tiny one-line file, whose text turns up by chance", () => {
        expect(shownInFull("anything", "")).toBe(false);
        expect(shownInFull("anything", "\n")).toBe(false);
        expect(shownInFull("Command failed (exit code 1).", "1\n")).toBe(false);
        expect(shownInFull("cat: x: No such file or directory", "No such file or directory\n")).toBe(false);
    });

    it("counts a short multi-line file and a long one-line file", () => {
        expect(shownInFull("[package]\norg = \"a\"", "[package]\norg = \"a\"\n")).toBe(true);
        const line = "public const string VERSION = \"1.2.3\"; // bumped by release";
        expect(shownInFull(line, `${line}\n`)).toBe(true);
    });
});

describe("shellReadSnapshot and recordShellReads", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bi-shell-reads-")));
    const content = "public function add(int a, int b) returns int {\n    return a + b;\n}\n";
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("counts a file the command printed whole and did not change", () => {
        writeFileSync(join(dir, "functions.bal"), content);
        const reads = new ReadTracker();
        const snapshot = shellReadSnapshot("cat functions.bal", dir, HOME);
        expect(recordShellReads(reads, snapshot, content.trimEnd())).toEqual([join(dir, "functions.bal")]);
        expect(reads.status(join(dir, "functions.bal"), content)).toBe("fresh");
    });

    it("does not count a partial read, a file the same command rewrote, or a device", () => {
        writeFileSync(join(dir, "partial.bal"), content);
        const reads = new ReadTracker();
        expect(recordShellReads(reads, shellReadSnapshot("head -n 1 partial.bal", dir, HOME), "public function add(int a, int b) returns int {")).toEqual([]);

        writeFileSync(join(dir, "rewritten.bal"), content);
        const snapshot = shellReadSnapshot("cat rewritten.bal; cp other.bal rewritten.bal", dir, HOME);
        writeFileSync(join(dir, "rewritten.bal"), "// replaced\n");
        expect(recordShellReads(reads, snapshot, content)).toEqual([]);

        expect(shellReadSnapshot("head -c 1 /dev/zero", dir, HOME).size).toBe(0);
        expect(reads.status(join(dir, "partial.bal"), content)).toBe("unread");
    });
});
