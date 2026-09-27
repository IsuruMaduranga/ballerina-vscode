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

/** Regression corpus adapted from an earlier harness's shell and security tests. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeShellCommand, parseCommand } from "../../features/ai/agent/auto-mode/shell-analysis";

let root: string;
let cwd: string;
let home: string;
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-shell-corpus-")));
    cwd = join(root, "project");
    home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    writeFileSync(join(cwd, "a.txt"), "a\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const analyze = (command: string) => analyzeShellCommand({ command, cwd, home });

it.each([
    "printf '%n' PATH; ls", "printf %.0n PATH", "printf '%ln' PATH", "printf '%s%n' a PATH", "printf -- '%n' PATH",
    "jq -n '$ENV.X'", "jq -n '$ ENV.X'", "jq -n 'env.X'", "jq -n 'import \"a\" as a; 1'", "jq -n 'include \"a\"; 1'",
    "grep *", "jq *", "printf *",
    "cat < /etc/passwd", "< /etc/passwd wc -l", "cat <<< \"$TOKEN\"", "cat <<EOF\n$TOKEN\nEOF",
    "env -C/tmp cat a.txt", "env --chdir=/tmp cat a.txt", "TZ=:/etc/passwd date", "./cat a.txt",
    "grep -R a .", "rg --follow a .", "find -L . -type f", "tree -l .", "du -L .", "ls -LR .",
    "date $(echo -f /etc/passwd)", "printf $(echo -v) PATH ./bin",
])("never proves environment reads, unknown argument vectors or recursive symlink traversal safe: %s", (command) => {
    expect(analyze(command).verdict).toBe("escalate");
});

it.each([
    "printf '%s\\n' hello", "printf '100%%n done\\n'", "printf 'n=%d\\n' 3",
    "cat *.txt", "wc -l *.txt", "grep a *.txt", "ls *", "head -n 1 *.txt",
    "cat < a.txt", "cat <<'EOF' > notes.txt\n$TOKEN is literal data\nEOF",
    "echo $(printf hello)", "cat <(printf hello)", "ls\nwc -l a.txt",
])("keeps proved ordinary reads and contained literal redirects safe: %s", (command) => {
    expect(analyze(command).verdict).toBe("safe");
});

it("judges glob-expanded operands before deciding whether a command writes", () => {
    writeFileSync(join(cwd, "sample-a"), "a\n");
    writeFileSync(join(cwd, "sample-b"), "b\n");
    expect(analyze("uniq sample-*").verdict).toBe("escalate");
    writeFileSync(join(cwd, "--output=victim"), "");
    for (const command of ["sort *", "cat *", "git diff *"]) {
        expect(analyze(command).verdict).toBe("escalate");
    }
    expect(analyze("ls ./*").verdict).toBe("safe");
});

it.each([".env", "Config.toml", ".mcp.json", "AGENTS.md", ".git/config", ".vscode/tasks.json"])("keeps directories containing %s off the file-operation fast path", (file) => {
    const target = join(cwd, "nested", file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "protected\n");
    expect(analyze("rm -rf nested").containedNonNetwork).toBe(false);
    expect(analyze("mv nested moved").containedNonNetwork).toBe(false);
});

it("checks where a copy lands beneath an existing directory", () => {
    mkdirSync(join(cwd, "source", ".vscode"), { recursive: true });
    writeFileSync(join(cwd, "source", ".vscode", "settings.json"), "{}");
    mkdirSync(join(cwd, "target"));
    expect(analyze("cp -r source target").containedNonNetwork).toBe(false);
    writeFileSync(join(cwd, "safe.txt"), "safe\n");
    expect(analyze("cp safe.txt target").containedNonNetwork).toBe(true);
});

posixOnly("resolves symlinks before granting file operations or reads", () => {
    const outside = join(root, "outside");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(cwd, "link"));
    expect(analyze("cat link").verdict).toBe("escalate");
    expect(analyze("cp a.txt link").containedNonNetwork).toBe(false);
    expect(analyze("touch link").containedNonNetwork).toBe(false);
});

it.each([
    ["echo $(rm -f target)", ["echo", "rm"]],
    ["cat <<EOF\n$(rm -f target)\nEOF", ["cat", "rm"]],
    ["cat <<'EOF'\n$(rm -f target)\nEOF", ["cat"]],
    ["cat <(printf hello)", ["cat", "printf"]],
    ["ls\nwc -l a.txt", ["ls", "wc"]],
    ["cmd 2>/dev/null arg", ["cmd"]],
])("the syntax tree exposes executable nested commands: %s", (command, names) => {
    const parsed = parseCommand(command as string);
    expect(parsed.parseFailed).toBe(false);
    expect(parsed.segments.map((segment) => segment.tokens[0]?.value)).toEqual(names);
});

it("keeps words after redirects attached to their real command", () => {
    const [segment] = parseCommand("cmd 2>/dev/null arg").segments;
    expect(segment.tokens.map((token) => token.value)).toEqual(["cmd", "arg"]);
    expect(segment.redirects).toEqual(["/dev/null"]);
});

it.each(["if true; then rm a.txt; fi", "(rm a.txt)", "while true; do rm a.txt; done", "f() { rm a.txt; }", "rm {a,b}.txt"])("complex syntax never enters the file-operation fast path: %s", (command) => {
    expect(parseCommand(command).complex).toBeDefined();
    expect(analyze(command).containedNonNetwork).toBe(false);
});
