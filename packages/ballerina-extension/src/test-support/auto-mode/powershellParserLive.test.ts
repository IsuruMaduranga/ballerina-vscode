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
 * The parse server against a real PowerShell: the walker script, the
 * bootstrap on each platform's command line, and the model a gate reads.
 * The lines are the ones a tree-sitter grammar for PowerShell got wrong, so
 * each assertion is a place where the model must show what PowerShell runs.
 *
 * Runs against the local PowerShell (`powershellParse.ts`), and on Windows
 * also against Windows PowerShell 5.1. Skips when neither exists.
 */

import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { type PowerShellAstNode, type PowerShellParse, PowerShellParser } from "../../features/ai/agent/auto-mode/powershell-parser";
import { system32Path } from "../../features/ai/agent/auto-mode/shared-paths";
import { spawnLaunch } from "../../features/ai/agent/shell/runner";
import { POWERSHELL_ARGS, powerShellParser, shellLaunch, type ShellSpawn, withPowerShellUtf8 } from "../../features/ai/agent/shell/shell-spawn";
import { expectLabeled } from "./labeled";
import { LOCAL_POWERSHELL, liveParse, POWERSHELL_TEST_TIMEOUT, readRecording, testParser } from "./powershellParse";

/** Windows PowerShell 5.1 (`powershell.exe`), present on every Windows install; undefined elsewhere. */
function windowsPowerShell(): ShellSpawn | undefined {
    if (process.platform !== "win32") { return undefined; }
    const exe = system32Path(join("WindowsPowerShell", "v1.0", "powershell.exe"));
    return existsSync(exe) ? { shell: exe, args: [...POWERSHELL_ARGS] } : undefined;
}

const EXECUTABLES = [LOCAL_POWERSHELL, windowsPowerShell()].filter((spec): spec is ShellSpawn => spec !== undefined);
const parsers: PowerShellParser[] = [];

afterAll(() => {
    for (const parser of parsers) { parser.stop(); }
});

function commands(parse: PowerShellParse): string[] {
    return parse.nodes.filter((n) => n.type === "CommandAst").map((n) => n.name ?? "<dynamic>");
}

function ofType(parse: PowerShellParse, type: string): PowerShellAstNode[] {
    return parse.nodes.filter((n) => n.type === type);
}

(EXECUTABLES.length === 0 ? describe.skip : describe)("PowerShell parse server (live)", () => {
    for (const spec of EXECUTABLES) {
        describe(spec.shell, () => {
            // A cold start can be slow; the gate uses 5 s.
            const parser = testParser(spec);
            parsers.push(parser);

            const parse = async (command: string): Promise<PowerShellParse> => {
                const outcome = await parser.parse(command);
                if (!outcome.ok) { throw new Error((outcome as { reason: string }).reason); }
                return outcome.parse;
            };

            it("parses a pipeline into commands, parameters and resolved arguments", async () => {
                const result = await parse("Get-ChildItem -Recurse 'src dir' | Where-Object { $_.Length -gt 1kb }");
                expect(result.errors).toEqual([]);
                expect(commands(result)).toEqual(["Get-ChildItem", "Where-Object"]);
                expect(ofType(result, "CommandParameterAst").map((n) => n.name)).toEqual(["Recurse"]);
                expect(ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")?.value).toBe("src dir");
                expect(ofType(result, "ScriptBlockExpressionAst")).toHaveLength(1);
            }, 90_000);

            it("looks command names up on the PATH the request carries, then restores its own", async () => {
                const dir = realpathSync(mkdtempSync(join(tmpdir(), "bi-ps-path-")));
                try {
                    const file = join(dir, process.platform === "win32" ? "zz-bi-probe.cmd" : "zz-bi-probe");
                    writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
                    chmodSync(file, 0o755);
                    const found = await parser.parse("zz-bi-probe", dir);
                    if (!found.ok) { throw new Error((found as { reason: string }).reason); }
                    const node = found.parse.nodes.find((n) => n.type === "CommandAst");
                    expect(node).toMatchObject({ commandType: "Application", resolvedName: file });
                    expect(found.parse.lookupPath).toBe(dir);
                    const after = await parse("zz-bi-probe");
                    expect(after.nodes.find((n) => n.type === "CommandAst")?.resolvedName).toBeUndefined();
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            }, 90_000);

            it("keeps the tree consistent: pre-order, parents before children, extents nested", async () => {
                const command = "ls a; if ($x) { rm \"b$(Get-Date)\" } else { cat c }";
                const result = await parse(command);
                expect(result.nodes[0].parent).toBe(-1);
                expect(result.nodes[0].type).toBe("ScriptBlockAst");
                result.nodes.forEach((node, i) => {
                    if (i === 0) { return; }
                    expect(node.parent).toBeGreaterThanOrEqual(0);
                    expect(node.parent).toBeLessThan(i);
                    const parent = result.nodes[node.parent];
                    expect(node.start).toBeGreaterThanOrEqual(parent.start);
                    expect(node.end).toBeLessThanOrEqual(parent.end);
                });
                expect(commands(result)).toEqual(["ls", "rm", "Get-Date", "cat"]);
            }, 90_000);

            it("reports offsets in JS string units, through non-ASCII text", async () => {
                const command = "Get-Content '日本語 ✓ 😀.txt' -Tail 3";
                const result = await parse(command);
                const quoted = ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")!;
                expect(quoted.value).toBe("日本語 ✓ 😀.txt");
                expect(command.slice(quoted.start, quoted.end)).toBe("'日本語 ✓ 😀.txt'");
            }, 90_000);

            it("reads an en dash, em dash or horizontal bar as a parameter dash", async () => {
                for (const dash of ["\u2013", "\u2014", "\u2015"]) {
                    const result = await parse(`Get-Content ${dash}LiteralPath C:\\secret`);
                    expect(ofType(result, "CommandParameterAst").map((n) => n.name)).toEqual(["LiteralPath"]);
                }
            }, 90_000);

            it("reads curly quotes as quotes, so a `;` inside them splits nothing", async () => {
                const result = await parse("Write-Output \u2018a; rm x\u2019");
                expect(result.errors).toEqual([]);
                expect(commands(result)).toEqual(["Write-Output"]);
                expect(ofType(result, "StringConstantExpressionAst").find((n) => n.kind === "SingleQuoted")?.value).toBe("a; rm x");
            }, 90_000);

            it("reports mismatched quotes as a parse error", async () => {
                const result = await parse("Write-Output 'a\u2019; rm x'");
                expect(result.errors.length).toBeGreaterThan(0);
            }, 90_000);

            it("shows every redirection spelling as a redirection", async () => {
                for (const line of ["ls 1> out.txt", "ls 2>err.txt", "ls 2>>err.txt", "ls *>x.txt", "ls >x.txt", "ls 2>$null", "ls 'a'>x"]) {
                    const result = await parse(line);
                    expectLabeled(result.errors, line).toEqual([]);
                    expectLabeled(ofType(result, "FileRedirectionAst"), line).toHaveLength(1);
                }
                const merge = await parse("ls 2>&1");
                expect(ofType(merge, "MergingRedirectionAst")[0]).toMatchObject({ from: "Error", to: "Output" });
            }, 90_000);

            it("ends a stop-parsing argument at a pipe", async () => {
                const result = await parse("echo --% a | rm x");
                expect(commands(result)).toEqual(["echo", "rm"]);
            }, 90_000);

            it("separates on Unicode whitespace and a bare CR", async () => {
                expect(commands(await parse("Get-Content\u00a0x;\u00a0Remove-Item y"))).toEqual(["Get-Content", "Remove-Item"]);
                expect(commands(await parse("ls # x\rrm y"))).toEqual(["ls", "rm"]);
            }, 90_000);

            it("finds commands nested in strings, subexpressions and script blocks", async () => {
                expect(commands(await parse('ls "x$(rm y)"'))).toEqual(["ls", "rm"]);
                expect(commands(await parse("ls '$(rm y)'"))).toEqual(["ls"]);
                expect(commands(await parse("Invoke-Command -ScriptBlock { rm x }"))).toEqual(["Invoke-Command", "rm"]);
            }, 90_000);

            it("marks call operators, splatting, and static .NET calls", async () => {
                const call = await parse("& $cmd @args");
                expect(ofType(call, "CommandAst")[0]).toMatchObject({ operator: "Ampersand", name: null });
                expect(ofType(call, "VariableExpressionAst").find((n) => n.splatted)?.name).toBe("args");
                const dotnet = await parse("[IO.File]::Delete('x')");
                expect(ofType(dotnet, "InvokeMemberExpressionAst")[0]).toMatchObject({ static: true });
                expect(ofType(dotnet, "TypeExpressionAst")[0].name).toBe("IO.File");
            }, 90_000);

            it("resolves each command in this PowerShell and binds a cmdlet's arguments", async () => {
                // `-Rec`, not `-r`: Windows PowerShell 5.1's binder calls `-r` ambiguous
                // on Get-ChildItem (its file-system dynamic parameters include -ReadOnly).
                const result = await parse("gci -Rec src | Select-String TODO -Ca; NoSuchCommand-xyz -a");
                const [gci, sls, unknown] = ofType(result, "CommandAst");
                expect(gci).toMatchObject({ alias: true, commandType: "Cmdlet", resolvedName: "Get-ChildItem", module: "Microsoft.PowerShell.Management" });
                const canonical = ofType(await parse("Get-ChildItem -Recurse src"), "CommandAst")[0];
                expectLabeled(canonical.bindings?.map((b) => b.parameter).sort(), JSON.stringify(canonical)).toEqual(["Path", "Recurse"]);
                expectLabeled(gci.bindings?.map((b) => b.parameter).sort(), JSON.stringify(gci)).toEqual(["Path", "Recurse"]);
                // An alias is bound as a copy spelled with its cmdlet; its values still
                // point at this tree's nodes.
                const path = gci.bindings?.find((b) => b.parameter === "Path");
                expect(result.nodes[path?.value ?? -1]).toMatchObject({ type: "StringConstantExpressionAst", value: "src" });
                const aliased = await parse("ls -Path a,b; % { $_ } ; echo x 'y z'");
                const [ls, foreach, echo] = ofType(aliased, "CommandAst");
                if (ls.alias) { expect(aliased.nodes[ls.bindings?.find((b) => b.parameter === "Path")?.value ?? -1].type).toBe("ArrayLiteralAst"); }
                expect(aliased.nodes[foreach.bindings?.find((b) => b.parameter === "Process")?.value ?? -1].type).toBe("ScriptBlockExpressionAst");
                const collectedEcho = echo.bindings?.find((b) => b.parameter === "InputObject");
                expect(collectedEcho?.value).toBe(-2);
                expect(collectedEcho?.elements?.map((i) => aliased.nodes[i]?.value)).toEqual(["x", "y z"]);
                expect(sls.bindings?.map((b) => b.parameter).sort()).toEqual(["CaseSensitive", "Pattern"]);
                expect(unknown.commandType).toBeUndefined();
                const surplus = ofType(await parse("Get-Content a b"), "CommandAst")[0];
                expect(surplus.bindingErrors).toEqual(["b"]);
                const collected = ofType(await parse("Write-Output a 'b c'"), "CommandAst")[0];
                expect(collected.bindings).toHaveLength(1);
                expect(collected.bindings?.[0]).toMatchObject({ parameter: "InputObject", value: -2 });
                expect(collected.bindings?.[0].elements?.every((i) => i > 0)).toBe(true);
            }, 90_000);

            it("the tool's spawn delivers a line to PowerShell byte for byte, so the parse is of what runs", async () => {
                // The gate parses the command over base64; the tool passes it on the
                // command line. Each line rides inside a here-string (data, never
                // run) and PowerShell reports the script it received.
                const lines = [
                    'Write-Output "a \\"q\\" b" \'c "d" e\'',
                    'x\\ "y\\\\" z\\',
                    "‘curly’ “double” –dash —em  nbsp\ttab",
                    "%PATH% ^& | ; && || `$x $(y) @(z)",
                    "日本語 ✓ 😀",
                    "line one\r\nline two\nline three",
                ];
                for (const line of lines) {
                    const script = `$null = @'\n${line}\n'@\n[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($MyInvocation.MyCommand.ScriptBlock.ToString())))`;
                    const child = spawnLaunch(shellLaunch(spec, withPowerShellUtf8(script)), { cwd: homedir() });
                    let out = "";
                    child.stdout?.on("data", (chunk) => (out += chunk));
                    await new Promise((resolve) => child.on("close", resolve));
                    expectLabeled(Buffer.from(out.trim(), "base64").toString("utf8"), JSON.stringify(line)).toBe(withPowerShellUtf8(script));
                }
            }, 90_000);

            it("answers a line of only whitespace, and restarts after stop()", async () => {
                expect(commands(await parse("  "))).toEqual([]);
                parser.stop();
                expect(commands(await parse("ls"))).toEqual(["ls"]);
            }, 90_000);
        });
    }
});


(LOCAL_POWERSHELL ? describe : describe.skip)("the shared parser on the tool's own executable", () => {
    it("parses through the same spawn the tool uses, and is one parser per executable", async () => {
        const spec = LOCAL_POWERSHELL as ShellSpawn;
        const parser = powerShellParser(spec);
        if (!parser) { throw new Error("no parser"); }
        parsers.push(parser);
        expect(powerShellParser(spec)).toBe(parser);
        const outcome = await parser.parse("Get-ChildItem src");
        expect(outcome.ok && outcome.parse.nodes.find((n) => n.type === "CommandAst")).toMatchObject({ commandType: "Cmdlet", resolvedName: "Get-ChildItem" });
    }, POWERSHELL_TEST_TIMEOUT);
});

/**
 * The recorded parses the tree tests use without PowerShell must still be
 * what PowerShell answers. Application paths differ between machines, so
 * they are left out of the comparison, and a recording from another
 * platform is not compared at all (command lookup differs).
 */
const recording = readRecording();
(LOCAL_POWERSHELL && recording.platform === process.platform ? describe : describe.skip)("the recorded parses", () => {
    const comparable = (parse: PowerShellParse) =>
        parse.nodes.map((node) => (node.commandType === "Application" ? { ...node, resolvedName: "<application>" } : node));

    it("match the live parser", async () => {
        for (const [command, recorded] of Object.entries(recording.parses)) {
            const live = await liveParse(command);
            expectLabeled(comparable(live), command).toEqual(comparable(recorded));
            expectLabeled(live.errors, command).toEqual(recorded.errors);
        }
    }, 120_000);
});
