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
 * The per-command read-only proof the safety floor's textual scan relies on
 * (`hasReadOnlyShellWords`), and the parse facts it reads: each word's source
 * range, expansions outside command words, and pipelines.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findNegatedPatterns } from "../../features/ai/agent/auto-mode/read-only-options";
import { analyzeShellCommand, hasReadOnlyShellWords, parseCommand } from "../../features/ai/agent/auto-mode/shell-analysis";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "bi-read-only-words-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const proven = (command: string) => hasReadOnlyShellWords(parseCommand(command).segments[0], cwd, cwd);

describe("hasReadOnlyShellWords", () => {
    it.each([
        `rg -g '!**/x/**' slugify .`,
        `grep --include='**/x/**' --exclude-dir='**/y/**' slugify .`,
        `git diff -- ':!**/x/**'`,
        `find . -name 'settings*' -print`,
        `uniq a`,
        `cat ~/.ballerina/copilot/mcp.json`,
        `echo '.vscode/settings.json'`,
        `rg -g '!**/x/**' slugify . 2>/dev/null`,
        `find . -not -path './.git/*' -name '*.pem'`,
        `cat Makefile`,
        `cat .env`,
    ])("uses the pre-gate's option/operand proof: %s", (command) => {
        expect(proven(command)).toBe(true);
    });

    it.each([
        `uniq a .vscode/settings.json`,
        `uniq sample-*`,
        `rg --pre=prog -g '!**/x/**' slugify .`,
        `git diff --output=.vscode/settings.json`,
        `git -c diff.external=prog diff`,
        `find .vscode -name 'settings*' -delete`,
        `sort --output=.vscode/settings.json a`,
        `cp x .vscode/settings.json`,
        `fd --exclude '**/x/**' slugify .`,
        `./rg -g '!**/x/**' slugify .`,
        `env rg -g '!**/x/**' slugify .`,
        `RIPGREP_CONFIG_PATH=config rg -g '!**/x/**' slugify .`,
        `rg -g "$pattern" slugify .`,
        `echo "$(cp x .vscode/settings.json)"`,
        `cat <(cp x .vscode/settings.json)`,
        `echo x > .vscode/settings.*`,
        `echo x > out.txt`,
        `printf -v PATH ./bin`,
        `printf '%n' PATH`,
        `cat <<'EOF'\ncp x .vscode/settings.json\nEOF`,
        `find . -name '*.pem' -delete`,
        `sort -o Makefile a`,
        `cp .env x`,
    ])("does not substitute a command name for a proof: %s", (command) => {
        expect(proven(command)).toBe(false);
    });

    it("does not exempt read-only words within a substitution", () => {
        const inner = parseCommand(`echo "$(cat .vscode/settings.json)"`).segments[1];
        expect(hasReadOnlyShellWords(inner, cwd, cwd)).toBe(false);
    });

    it("retains git's checkout-program veto", () => {
        mkdirSync(join(cwd, ".git"));
        writeFileSync(join(cwd, ".git", "config"), "[diff]\nexternal = prog\n");
        expect(proven(`git diff -- ':!**/x/**'`)).toBe(false);
    });
});

describe("ShellEvidence.readsOnly", () => {
    it("is set when every escalation is a read, a named credential or execution-primitive path included", () => {
        for (const command of [`cat Makefile`, `cat .env`, `find . -name '*.pem'`, `cat /etc/hosts`]) {
            const evidence = analyzeShellCommand({ command, cwd, home: cwd });
            expect([command, evidence.verdict, evidence.readsOnly]).toEqual([command, "escalate", true]);
        }
    });

    it("is not set for a write, a mutation, an unknown command or a safe verdict", () => {
        for (const command of [`sort -o Makefile a`, `cp .env x`, `find . -name '*.pem' -delete`, `mystery Makefile`, `cat main.bal`]) {
            expect([command, analyzeShellCommand({ command, cwd, home: cwd }).readsOnly]).toEqual([command, false]);
        }
    });
});

describe("shell command word source ranges", () => {
    it("marks expansions outside simple-command words as unattributed", () => {
        expect(parseCommand("(( PATH = 0 )); cat file").unattributedExpansion).toBe(true);
        expect(parseCommand("case $((PATH=0)) in *) true;; esac; cat file").unattributedExpansion).toBe(true);
        expect(parseCommand("if rg needle .; then code=$?; fi").unattributedExpansion).toBe(false);
    });

    it("attributes only words, including words after redirects and repeated spellings", () => {
        const command = `if rg 2>/dev/null -g '!**/x/**' slugify .; then cat .vscode/settings.json > .vscode/settings.json; fi`;
        const { segments } = parseCommand(command);
        expect(segments.map((segment) => segment.wordRanges?.map(({ start, end }) => command.slice(start, end)))).toEqual([
            ["rg", "-g", "'!**/x/**'", "slugify", "."],
            ["cat", ".vscode/settings.json"],
        ]);
    });

    it("keeps heredoc bodies and here-strings out of command word ranges", () => {
        for (const command of [`cat <<'EOF'\n.vscode/settings.json\nEOF`, `cat <<< '.vscode/settings.json'`]) {
            const [segment] = parseCommand(command).segments;
            expect(segment.wordRanges?.map(({ start, end }) => command.slice(start, end))).toEqual(["cat"]);
            expect(segment.stdin?.length).toBe(1);
        }
    });

    it("does not reuse backtick-body offsets as offsets into the whole line", () => {
        const { segments } = parseCommand("cat <<EOF\n`cat .vscode/settings.json`\nEOF");
        expect(segments[1].substitution).toBeDefined();
        expect(segments[1].wordRanges).toBeUndefined();
    });

    it("reports each multi-command pipeline's member scopes and any function definition", () => {
        const { segments, pipelines } = parseCommand("cat a | sort | head; ls");
        expect(pipelines).toHaveLength(1);
        expect(pipelines[0]).toEqual(segments.slice(0, 3).map((segment) => segment.scopes[0]));
        expect(parseCommand("cat() ((1)); cat a").definesFunction).toBe(true);
        expect(parseCommand("cat a").definesFunction).toBe(false);
    });
});

describe("findNegatedPatterns", () => {
    const words = (line: string) => line.split(" ").map((value) => ({ value }));
    const negated = (line: string) => {
        const args = words(line);
        const result = findNegatedPatterns(args);
        return result && { excluding: [...result.excluding].map((i) => args[i].value), selecting: [...result.selecting].map((i) => args[i].value) };
    };

    it("trusts a single top-level negation of a pattern, or of a disjunction of patterns, to exclude", () => {
        expect(negated(". -not -path ./.git/* -name *.py")).toEqual({ excluding: ["./.git/*"], selecting: [] });
        expect(negated(". ! ( -path a -o -path b ) -type f")).toEqual({ excluding: ["a", "b"], selecting: [] });
    });

    it("treats a negation under -o, a double negation or a negated conjunction as selecting", () => {
        expect(negated(". -not -name settings.json -o -print")).toEqual({ excluding: [], selecting: ["settings.json"] });
        expect(negated(". ! ! -name settings.json")).toEqual({ excluding: [], selecting: ["settings.json"] });
        expect(negated(". -not ( -name settings.json -empty )")).toEqual({ excluding: [], selecting: ["settings.json"] });
        expect(negated(". -not -name a , -print")).toEqual({ excluding: [], selecting: ["a"] });
    });

    it("does not read the expression of a find that acts", () => {
        expect(negated(". ! -name keep -delete")).toBeUndefined();
        expect(negated(". ! -path ./.git/* -exec wc -l {} +")).toBeUndefined();
    });

    it("never takes an operand for an operator", () => {
        expect(negated(".vscode -printf ! -name settings.json -print")).toEqual({ excluding: [], selecting: [] });
    });
});
