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
 * The safety floor with BI's targets: gate-control files, the
 * Copilot's own state, and Config.toml. Modelled on an earlier harness's
 * safety-floor test suites (bash and PowerShell).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashFloorReason, powershellFloorReason, powershellPathTokens, regexLiteralTail } from "../../features/ai/agent/auto-mode/safety-floor";
import { analyzeShellCommand } from "../../features/ai/agent/auto-mode/shell-analysis";
import { forwardSlashes as sh } from "../../features/ai/agent/auto-mode/shared-paths";
import { expectLabeled } from "./labeled";

let root: string;
let cwd: string;
let home: string;
let tmp: string;
const posixOnly = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bi-floor-")));
    cwd = join(root, "project");
    home = join(root, "home");
    tmp = join(root, "tmp");
    mkdirSync(join(cwd, ".vscode"), { recursive: true });
    mkdirSync(join(home, ".ballerina", "copilot", "workspaces", "abc"), { recursive: true });
    mkdirSync(join(tmp, "bal-proj-1234"), { recursive: true });
    writeFileSync(join(cwd, "main.bal"), "");
    writeFileSync(join(cwd, ".mcp.json"), "{}");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const bash = (command: string) => bashFloorReason(command, { cwd, home, tmpDir: tmp });
const pwsh = (command: string) => powershellFloorReason(command, { cwd, home, tmpDir: tmp });

describe("bashFloorReason", () => {
    it("stops writes to gate-control files, in this project or anywhere", () => {
        const stopped = [
            "echo '{}' > .mcp.json",
            "echo '{}' > .vscode/settings.json",
            "cp /tmp/x.json .copilot/skills.config.json",
            `echo '{}' > ${sh(join(home, ".ballerina", "copilot", "mcp.json"))}`,
            "echo '{}' > ~/.ballerina/copilot/mcp.json",
            "echo '{}' > ~/.ballerina/copilot/auto-mode.json",
            `echo '{}' > ${sh(join(root, "other-checkout", ".vscode", "settings.json"))}`,
            "sed -i s/a/b/ .mcp.json",
            "echo '{}' > .vscode/sett*.json",
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("stops anything touching the Copilot's own state", () => {
        const stopped = [
            "rm -rf ~/.ballerina/copilot/workspaces",
            "echo x > ~/.ballerina/copilot/workspaces/abc/thread.json",
            `rm -rf ${sh(join(tmp, "bal-proj-1234"))}`,
            `echo x > ${sh(join(tmp, "bal-proj-1234", "main.bal"))}`,
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("stops any mention of Config.toml, read or write", () => {
        for (const command of ["cat Config.toml", "cat tests/Config.toml", "grep token ./Config.toml", "echo x >> config.toml", "cp Config.toml /tmp/c"]) {
            expectLabeled(bash(command), command).toContain("Config.toml");
        }
    });

    it("lets a proven read of a gate-control file through", () => {
        expect(bash("cat .mcp.json")).toBeUndefined();
        // The pre-gate escalates a read of .vscode/*.json (an execution primitive) so the
        // classifier sees it, but the read cannot write, so its words keep their proof.
        expect(bash("cat .vscode/settings.json")).toBeUndefined();
    });

    it("leaves ordinary work alone", () => {
        for (const command of ["bal build", "git status", "echo hi > out.txt", "cat main.bal", "ls ~/.ballerina/repositories", "cat Config.toml.example.md"]) {
            expectLabeled(bash(command), command).toBeUndefined();
        }
    });

    posixOnly("resolves a symlink onto a target rather than trusting the literal path", () => {
        symlinkSync(join(cwd, ".mcp.json"), join(cwd, "innocent.json"));
        expect(bash("echo '{}' > innocent.json")).toBeDefined();
    });

    it("names a target in a command it cannot model as a write", () => {
        expect(bash("python3 tool.py --out .vscode/settings.json")).toBeDefined();
        expect(bash("sh -c 'echo x > .mcp.json'")).toBeDefined();
    });

    it("tracks a literal cd by scope for redirect and input targets", () => {
        expect(bash("cd .copilot && python3 tool.py --out skills.config.json")).toBeDefined();
        expect(bash("cd .copilot && python3 tool.py < skills.config.json")).toBeDefined();
    });

    it("stops a control-file basename when a cd target is unknown or conditional", () => {
        const stopped = [
            'cd "$TARGET"; python3 tool.py --out skills.config.json',
            "false && cd .copilot; python3 tool.py --out skills.config.json",
            "cd .copilot | cat; python3 tool.py --out skills.config.json",
            "while false; do cd .copilot; done; python3 tool.py --out skills.config.json",
        ];
        for (const command of stopped) { expectLabeled(bash(command), command).toBeDefined(); }
    });

    it("does not leak a cd in command substitution into the parent shell", () => {
        expect(bash('cd .copilot; echo "$(cd /tmp; pwd)" > skills.config.json')).toBeDefined();
    });
});

describe("bashFloorReason: read-only words in escalated compound commands", () => {
    const observed = `git diff --check && git diff -- README.md CHANGELOG.md src/text_utils.py src/inventory.py && if rg --hidden --no-ignore -n --glob '!.git/**' --glob '!node_modules/**' --glob '!**/__pycache__/**' 'slugify' .; then echo 'Old name still present'; exit 1; else code=$?; if [ "$code" -eq 1 ]; then echo 'No old-name references found'; else exit "$code"; fi; fi && git status --short`;

    it.each([
        observed,
        `rg -g '!**/__pycache__/**' slugify . && exit 0`,
        `rg -g'!**/x/**' slugify . && exit 0`,
        `grep -r --include='**/x/**' slugify . && exit 0`,
        `grep -r --exclude-dir '**/x/**' slugify . && exit 0`,
        `git diff -- ':!**/x/**' && exit 0`,
        `cat .vscode/settings.json && exit 0`,
        `rg 2>/dev/null -g '!**/x/**' slugify . && exit 0`,
        `find . -name 'settings*' -print && exit 0`,
        `rg -g '!**/.vscode/settings.json' slugify . && exit 0`,
        `grep --exclude-dir '.vscode/settings.json' slugify . && exit 0`,
        `git diff -- ':!.vscode/settings.json' && exit 0`,
        `npm test && rg -g '!**/x/**' slugify .`,
        `echo '😀'; rg -g '!**/x/**' slugify . && exit 0`,
        // A -regex whose fixed tail no control file's name can end with.
        `find src -regex '.*\\.orig' -delete`,
        `find . -iregex '.*/node_modules/.*\\.LOG$' -delete`,
        `find . -regex '.*/build/' -exec rm -rf {} +`,
        // A pipeline of proven read-only commands runs no member's output.
        `pwd; ls -la; git status --short; cat Makefile; find . -maxdepth 3 -type f -not -path './.git/*' | sort`,
        `cat Makefile; find . -path './.git/*' | sort | head -n 5`,
        `cat Makefile; cat .vscode/settings.json | jq .`,
        // A read that names a credential or execution-primitive path escalates for the classifier but cannot write.
        `grep -rnIE "(sk_[A-Za-z0-9_]{8,}|-----BEGIN)" . 2>/dev/null | grep -v node_modules | head -30; echo "=== keys ==="; find . -not -path './.git/*' -not -path './node_modules/*' \\( -name "*.pem" -o -name "*.key" -o -name "*.env*" \\) 2>/dev/null`,
        `find . -not -path './.git/*' -name '*.pem' && exit 0`,
        `cat Makefile && find . -path './.git/*' -name Makefile`,
        // A negated find pattern excludes files; it never selects one.
        `find . -type f -not -path './.git/*' | head -50 && echo '---' && wc -l $(find . -type f \\( -name '*.bal' -o -name '*.md' \\) -not -path './.git/*' -not -path './target/*')`,
        `find . -not \\( -path './.git/*' -o -path './target/*' \\) -name '*.bal' | xargs wc -l && exit 0`,
        // A loop anywhere leaves every word unproven; a negated glob pattern still names nothing.
        `find src tests -type f -not -path '*/target/*' | sort && for f in tests/*.bal; do echo "--- $f ---"; cat "$f"; done`,
        `for f in a b; do echo "$f"; done; find . ! -path '*/.vscode/*' -name '*.bal'`,
        `for f in a b; do echo "$f"; done; find . -not \\( -path './.git/*' -o -path './target/*' \\) \\( -name '*.bal' -o -name '*.md' \\) | sort`,
        // A redirect to /dev/null or a descriptor dup captures nothing a later command runs.
        `{ cat .vscode/settings.json; } 2>/dev/null`,
        `exec 2>&1; cat .vscode/settings.json`,
        // A proven read of the Copilot's own state, as the same read alone already passes.
        `cat ~/.ballerina/copilot/workspaces/abc/thread.json && exit 0`,
    ])("does not floor proven read-only words: %s", (command) => {
        expect(analyzeShellCommand({ command, cwd, home }).verdict).toBe("escalate");
        expect(bash(command)).toBeUndefined();
    });

    it.each([
        `uniq a .vscode/settings.json`,
        `echo x >&.vscode/settings.json`,
        `cp x .vscode/settings.json`,
        `find .vscode -name 'settings*' -delete`,
        `rsync --delete src/ .vscode/settings.json`,
        `echo x > .vscode/settings.*`,
        `rg -g '!**/x/**' slugify . > .vscode/settings.*`,
        `rg --pre='cp x .vscode/settings.json' slugify .`,
        `git diff --output=.vscode/settings.json`,
        `sh -c 'cp x .vscode/settings.json'`,
        `echo "$(cp x .vscode/settings.json)"`,
        `cat <(cp x .vscode/settings.json)`,
        `unknown --output=.vscode/settings.json`,
        `rg -g '!**/x/**' slugify .; cp x .vscode/settings.json`,
        `cp x .vscode/settings.json; rg -g '!**/x/**' slugify .`,
        `cat .vscode/settings.json > .vscode/settings.json`,
        `cat < .vscode/settings.json && exit 0`,
        `echo '😀'; cat .vscode/settings.json; cp x .vscode/settings.json`,
        `cat .vscode/settings.json > .vscode/settings.*`,
        `{ rg -g '!**/x/**' slugify .; } > .vscode/settings.*`,
        `rg -g '!**/x/**' slugify . && mystery '**/x/**'`,
        `rg -g '!**/x/**' slugify . && fd --exclude '**/x/**' slugify .`,
        `rg --unmodelled-option -g '!**/x/**' slugify .`,
        `rg -g '!**/x/**' slugify . && sh -c 'cat .vscode/settings.json'`,
        `rg -g '!**/x/**' slugify . && echo "$(cat .vscode/settings.json)"; exit 0`,
        `echo 'cp x .vscode/settings.json' | sh`,
        `cat Makefile; find . -path './.git/*' | sh`,
        `cat Makefile; find . -path './.git/*' | mystery`,
        `cat Makefile; find . -path './.git/*' -delete | sort`,
        `cat Makefile; find . -path './.git/*' | { sort; mystery; }`,
        `cat Makefile; (find . -path './.git/*' | sort)`,
        `cat Makefile; echo "$(find . -path './.git/*' | sort)"`,
        `cat Makefile; find . -path "$(mystery)/*" | sort`,
        `find . -path './.git/*' -name '*.key' -exec mystery {} + && exit 0`,
        `find . -not -path './.git/*' -name 'settings*' -delete && exit 0`,
        `find . -not \\( -path './x/*' \\) -name '*' -delete && exit 0`,
        `find . -not -path './x/*' -o -name 'settings.json' -delete && exit 0`,
        `rm $(find .vscode -name 'settings*')`,
        // A negated pattern selects everything else under `-o`, a second negation or a negated conjunction, and a find that acts may act on any file it leaves in.
        `find .vscode -not -name settings.json -o -exec cp evil.json {} \;`,
        `find .vscode -not -name settings.json -o -delete`,
        `find . -not -not -name settings.json -exec cp evil.json {} \;`,
        `find . ! ! -name settings.json -delete`,
        `find . -not \\( -not -name settings.json \\) -delete`,
        `find .vscode -not \\( -name settings.json -empty \\) -exec cp evil.json {} \;`,
        `find .vscode -not \\( -name settings.json -empty \\) | xargs -I{} cp evil.json {}`,
        `find . -not -regex '.*settings\\.json' -o -delete`,
        `find . -maxdepth 1 -not -name '.mcp.j*' -o -exec cp evil.json {} \;`,
        `find . -not -name settings.json -o -print | xargs -I{} cp evil.json {}`,
        `find ~/.ballerina/copilot -not -path '*/mcp.json' -o -exec cp evil.json {} \;`,
        `find . -not -path '*/.vscode/settings*' -o -exec cp evil.json {} \;`,
        `find . -not -path '*/settings.json' -o -delete`,
        `find . ! -name keep -delete`,
        `find . ! \\( -name ')' -name keep \\) -delete`,
        `find .vscode -printf ! -name settings.json -print | xargs -I{} cp evil.json {}`,
        // find's actions are not read, so a negation there is not trusted to exclude, whatever the action runs.
        `find . ! -path './.git/*' -exec wc -l {} + && exit 0`,
        `find . -not \\( -path './.git/*' -o -path './target/*' \\) -name '*.bal' -exec wc -l {} + && exit 0`,
        // A proven command's output can still reach a script file through an enclosing redirect, an `exec` or an fd dup.
        `{ echo 'cp evil.json .vscode/settings.json'; } > s.sh; sh s.sh`,
        `if true; then echo 'cp evil.json .vscode/settings.json'; fi > s.sh && sh s.sh`,
        `exec 3>s.sh; echo 'cp evil.json .vscode/settings.json' >&3; sh s.sh`,
        `exec > s.sh; echo 'cp evil.json .vscode/settings.json'; sh s.sh`,
        `{ echo 'cp evil.json .vscode/settings.json' | sort; } > s.sh; sh s.sh`,
        // Unquoted, the script is spread over separate words, none of which looks like a script.
        `{ echo cp evil.json .vscode/settings.json; } > s.sh; sh s.sh`,
        `if true; then echo cp evil.json .vscode/settings.json; fi > s.sh && sh s.sh`,
        `exec > s.sh; echo cp evil.json .vscode/settings.json; sh s.sh`,
        `exec 3>s.sh; echo cp evil.json .vscode/settings.json >&3; sh s.sh`,
        `sh <<'EOF'\ncp x .vscode/settings.json\nEOF`,
        `cat <<'EOF' | sh\ncp x .vscode/settings.json\nEOF`,
        `sh <<< 'cp x .vscode/settings.json'`,
        `for f in .vscode/settings.json; do mystery "$f"; done`,
        `case .vscode/settings.json in *) mystery;; esac`,
        `cat .vscode/settings.json; echo "unterminated`,
        `cat() { cp x "$1"; }; cat .vscode/settings.json`,
        `alias cat=cp; cat .vscode/settings.json`,
        `eval "$setup"; cat .vscode/settings.json`,
        `source setup; cat .vscode/settings.json`,
        `PATH=./bin; cat .vscode/settings.json`,
        `printf -v PATH ./bin; cat .vscode/settings.json`,
        `read PATH; cat .vscode/settings.json`,
        `for PATH in ./bin; do true; done; cat .vscode/settings.json`,
        `(( PATH = 0 )); cat .vscode/settings.json`,
        `echo "$((PATH = 0))"; cat .vscode/settings.json`,
        `PATH[0]=./bin; cat .vscode/settings.json`,
        'echo "${PATH:=./bin}"; cat .vscode/settings.json',
        `case $((PATH=0)) in *) true;; esac; cat .vscode/settings.json`,
        'echo x > "${PATH:=./bin}"; cat .vscode/settings.json',
        'cat <<< "${PATH:=./bin}"; cat .vscode/settings.json',
        // A later command can reuse an earlier one's words through $_.
        `echo .vscode/settings.json; rm "$_"`,
        `echo .vscode/settings.json; sed -i 's/x/y/' "$_"`,
        `ls ~/.ballerina/copilot/mcp.json && cp /tmp/evil "$_"`,
        'echo .vscode/settings.json; rm "${_}"',
        'echo .vscode/settings.json; rm "${_%.json}.json"',
        `echo .vscode/settings.json; sh <<EOF\nrm "$_"\nEOF`,
        // -regex/-iregex match the whole path, which a file-name glob cannot model.
        `find . -regex '.*settings.json' -delete`,
        `find . -iregex '.*SETTINGS.JSON' -delete`,
        `find . -regex '.*/\\.vscode/.*' -exec rm {} +`,
        `find . -regex '.*\\.json' -delete`,
        `find . -regex '.*settings.json\\'"'"'' -delete`,
        `find . -regex '.*\\(orig\\|json\\)' -delete`,
        `find . -regextype posix-extended -regex '.*\\.orig' -delete`,
        `find . -regex "$pattern" -delete`,
        `find . -regex '.*' -delete`,
        `find . ! -regex '.*\\.orig' -delete`,
        `find . -not -regex '.*\\.orig' -delete`,
        `find . -regex '.*\\.orig' -o -delete`,
        `find . \\( -regex '.*\\.orig' -or -name x \\) -delete`,
        `find . -regex '.*\\.orig' , -delete`,
        // Shell state changes that withhold every proof on the line.
        `: {PATH}>/dev/null; cat .vscode/settings.json && cp x y`,
        `{ :; } {PATH}>/dev/null; cat .vscode/settings.json && cp x y`,
        `exec {PATH}>&2; cat .vscode/settings.json && cp x y`,
        `coproc { :; }; cat .vscode/settings.json && cp x y`,
        `coproc PATH { :; }; cat .vscode/settings.json && cp x y`,
        `cat .vscode/settings.json; wait -p PATH; cat .vscode/settings.json && cp x y`,
        `cat() ((1)); cat .vscode/settings.json; cp x y`,
    ])("keeps writes and unproven commands on the floor: %s", (command) => {
        expect(bash(command)).toBeDefined();
    });
});

describe("bashFloorReason: the Copilot's own names in a find", () => {
    it.each([
        // Config.toml stops on any mention, proven reads included.
        `rg -g '!**/target/**' token Config.toml && exit 0`,
        `cat Makefile; cat Config.toml | sort`,
        `find . -name Config.toml -print && exit 0`,
        // An unproven find whose selecting pattern could match one of BI's control names.
        `find . -name '*.toml' -delete`,
        `find . -name '*.json' -delete`,
        `find src -iname 'MCP*' -exec rm {} +`,
        `find ~/.ballerina/copilot -name 'auto-mode*' -delete`,
        `find .copilot -name 'skills.*' -delete`,
        `find . -regex '.*\\.toml' -delete`,
        // In a substitution the find is unproven, and `*.toml` could spell Config.toml.
        `wc -l $(find . -type f \\( -name '*.bal' -o -name '*.toml' \\) -not -path './.git/*')`,
    ])("stops: %s", (command) => {
        expect(bash(command)).toBeDefined();
    });

    it("keeps the review baselines and the chat state on the floor for anything but a proven read", () => {
        for (const command of [`rm -rf ${sh(join(tmp, "bal-proj-1234"))} && exit 0`, "cat Makefile; rm -rf ~/.ballerina/copilot/workspaces/abc"]) {
            expectLabeled(bash(command), command).toBeDefined();
        }
    });

    it.each([
        `find . -name '*.bal' -delete`,
        `find . -name '*.json' -not -path './target/*' | sort`,
        `find . -regex '.*\\.bal' -delete`,
    ])("lets through: %s", (command) => {
        expect(bash(command)).toBeUndefined();
    });
});

describe("regexLiteralTail", () => {
    it("reads the literal text every match ends with", () => {
        expect(regexLiteralTail(".*\\.orig")).toBe(".orig");
        expect(regexLiteralTail(".*/build/")).toBe("/build/");
        expect(regexLiteralTail(".*\\.LOG$")).toBe(".LOG");
    });

    it("gives up on alternation, a non-literal escape or no literal tail", () => {
        expect(regexLiteralTail(".*\\(orig\\|json\\)")).toBeUndefined();
        expect(regexLiteralTail("a|b")).toBeUndefined();
        expect(regexLiteralTail(".*settings.json\\'")).toBeUndefined();
        expect(regexLiteralTail(".*")).toBeUndefined();
    });
});

describe("powershellPathTokens", () => {
    it("extracts path-shaped tokens, expanding $env:USERPROFILE, $HOME and ~, forward-slashed", () => {
        expect(powershellPathTokens(`Set-Content -Path "$env:USERPROFILE\\.ballerina\\copilot\\mcp.json" '{}'`, "/h")).toEqual(["/h/.ballerina/copilot/mcp.json"]);
        expect(powershellPathTokens("Get-Content ~/.ballerina/copilot/auto-mode.json | Out-Null", "/h")).toEqual(["/h/.ballerina/copilot/auto-mode.json"]);
        expect(powershellPathTokens("Set-Content -Path:.vscode\\settings.json x", "/h")).toEqual([".vscode/settings.json"]);
        expect(powershellPathTokens("git status; bal build", "/h")).toEqual([]);
    });
});

describe("powershellFloorReason", () => {
    it("stops any line naming a target, read or write", () => {
        const stopped = [
            `Set-Content -Path "$env:USERPROFILE\\.ballerina\\copilot\\mcp.json" -Value '{}'`,
            "Add-Content .vscode/settings.json '{}'",
            "Get-Content .mcp.json",
            "Get-Content Config.toml",
            "Remove-Item -Recurse ~/.ballerina/copilot/workspaces",
        ];
        for (const command of stopped) { expectLabeled(pwsh(command), command).toBeDefined(); }
    });

    it("lets ordinary work through", () => {
        for (const command of ["git status; bal build", "Set-Content src/config.json '{}'", "Get-Content package.json"]) {
            expectLabeled(pwsh(command), command).toBeUndefined();
        }
    });
});
