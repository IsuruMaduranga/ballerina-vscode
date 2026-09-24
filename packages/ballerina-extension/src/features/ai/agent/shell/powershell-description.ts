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
 * The `powershell` tool's description (design §9, owner 2026-09-19): the same
 * sections and coverage as Claude Code's captured description (the edition
 * slot, PowerShell syntax, the Unix commands PowerShell lacks, exit codes,
 * interactive commands, multi-line strings, usage and git safety), written in
 * BI's own words, with BI's purpose-built tools, background runs, scratchpad
 * and one-line-read notes. No sentence is copied. The edition is chosen by
 * executable name (`shell-spawn.ts powerShellEdition`), never by a probe.
 * Pure, so the Jest suite can load it.
 */

export const POWERSHELL_TOOL_NAME = "powershell";

export type PowerShellEditionName = "core" | "desktop" | "unknown";

/** The edition slot: what differs between PowerShell 7+ and Windows PowerShell 5.1. */
export const EDITION_SECTIONS: Record<PowerShellEditionName, string> = {
    core: `This machine runs PowerShell 7 or later (pwsh):
- \`&&\` and \`||\` chain commands as in bash; use \`a && b\` when b needs a to succeed, \`a; b\` when it does not.
- The ternary (\`$c ? $x : $y\`), \`??\` and \`?.\` operators work.
- Files are written as UTF-8 without a BOM by default.`,
    desktop: `This machine runs Windows PowerShell 5.1 (powershell.exe):
- \`&&\` and \`||\` do not exist and fail to parse. Run b only after a succeeds with \`a; if ($?) { b }\`, or both regardless with \`a; b\`.
- The ternary, \`??\` and \`?.\` operators do not exist; write \`if\`/\`else\` and compare with \`$null -eq $x\`.
- Do not add \`2>&1\` to a native program: 5.1 turns each stderr line into an error record and sets \`$?\` to false even when the program exited 0. stderr is captured for you already.
- Files are written as UTF-16 LE with a BOM by default; pass \`-Encoding utf8\` to \`Set-Content\` and \`Out-File\` for anything another tool will read.
- \`ConvertFrom-Json\` returns an object, not a hashtable, and has no \`-AsHashtable\`.`,
    unknown: `The PowerShell edition on this machine is not known, so write for Windows PowerShell 5.1:
- \`&&\`, \`||\`, the ternary, \`??\` and \`?.\` exist only in PowerShell 7 and fail to parse in 5.1, so leave them out.
- Chain with \`a; if ($?) { b }\` when b needs a to succeed, or \`a; b\` otherwise.`,
};

/** The description the `powershell` tool registers with, for the resolved edition. */
export function powershellToolDescription(edition: PowerShellEditionName): string {
    return `Runs a PowerShell command in the workspace root and returns its combined output. Each call starts a fresh, non-interactive PowerShell: variables and functions from an earlier call are gone, and the working directory is always the workspace root.

${EDITION_SECTIONS[edition]}

Prefer the purpose-built tools where one exists:
- Reading, creating or changing files: file_read, file_write, file_edit and file_batch_edit. They keep the review view accurate. Do not use Get-Content, Set-Content, Out-File or Add-Content for this.
- Compile errors: getCompilationErrors. Starting a service: runBallerinaPackage, which waits until it is ready and keeps it running after your turn; read its logs with task_output and stop it with kill_task. HTTP checks against a running service: hurlRunnerTool.
- Use this tool for the rest of what a terminal does: \`bal build\`, \`bal test\`, \`bal format\`, \`bal pack\`, \`bal pull\`, git, package managers and build scripts.

Writing the command:
- Keep a read-only look to one plain command per call (\`git status\`, \`Get-ChildItem resources\`, \`Select-String -Pattern Client -Path main.bal\`). A plain read runs straight away; a line that combines steps, loops or uses variables has to be checked first, which takes longer and may ask the user.
- Put double quotes around a path with spaces. The escape character is the backtick, not the backslash. A program whose path has spaces runs through the call operator: \`& "C:\\Program Files\\Tool\\tool.exe" arg\`.
- Cmdlets are Verb-Noun (\`Get-ChildItem\`, \`New-Item\`, \`Remove-Item\`); \`ls\`, \`cat\`, \`cd\` and \`rm\` are aliases for them. The pipeline passes objects, not text: shape them with \`Select-Object\`, \`Where-Object\` and \`ForEach-Object\`.
- Variables start with \`$\`; \`"Hello $name"\` and \`"$($x.Prop)"\` interpolate. Read an environment variable with \`$env:NAME\` and set one with \`$env:NAME = 'x'\`; there is no \`export\` and no \`VAR=x cmd\` prefix.
- The registry is a drive: \`HKCU:\\Software\\…\`, not \`HKEY_CURRENT_USER\\…\`.
- Put temporary files in the scratchpad directory named in the system prompt, never in \`$env:TEMP\` directly or the user's project.

Unix commands PowerShell does not have, and what to write instead:
- head / tail: \`Get-Content f -TotalCount 20\` / \`-Tail 20\`, or \`| Select-Object -First 20\` / \`-Last 20\` in a pipeline.
- which: \`(Get-Command name).Source\`.
- touch: \`if (-not (Test-Path f)) { New-Item -ItemType File f }\`. \`New-Item -Force\` on an existing file empties it.
- wc -l: \`(Get-Content f | Measure-Object -Line).Lines\`.
- mkdir -p: \`New-Item -ItemType Directory -Force d\`.
- rm -rf: \`Remove-Item -Recurse -Force d\`.
- ln -s: \`New-Item -ItemType SymbolicLink -Path link -Target target\`.
- chmod / chown: no equivalent on Windows; use \`icacls\` only when an ACL really has to change.
- 2>/dev/null: \`2>$null\`, rarely needed because stderr is captured.
- bash \`if [ … ]\`, \`for x in *\` and backtick substitution do not parse; the PowerShell forms are \`foreach ($x in …)\`, \`if (Test-Path x)\` and \`$(…)\`.

Exit codes: a native program's exit code is in \`$LASTEXITCODE\`. \`-ErrorAction SilentlyContinue\` hides a cmdlet's error text but the call still ends as failed; to make a cmdlet failure harmless, write \`try { Cmdlet … -ErrorAction Stop } catch {}\`.

Nothing can answer a prompt: stdin is the null device and the shell runs -NonInteractive.
- \`Read-Host\`, \`pause\`, \`Get-Credential\` and \`Out-GridView\` wait for an answer and are refused; \`$Host.UI.PromptForChoice\` fails the same way.
- Cmdlets that confirm before destroying something (\`Remove-Item\`, \`Stop-Process\`, \`Clear-Content\`) need \`-Confirm:$false\` when you mean it, and \`-Force\` for hidden or read-only items.
- Interactive git (\`rebase -i\`, \`add -i\`, \`add -p\`) is refused: there is no editor.

Multi-line text for a program (a commit message, file content): use a single-quoted here-string, which expands nothing. Its closing \`'@\` must start its own line, with nothing before it:
<example>
git commit -m @'
Add the order sync service

Costs $0 per call.
'@
</example>
Use \`@"…"@\` only when you want variables expanded. For arguments PowerShell would read as operators, the stop-parsing token passes the rest of the line through: \`git log --% --format=%H\`.

Usage:
- \`timeout\` is in milliseconds: 120000 (2 minutes) by default, at most 600000 (10 minutes).
- Output past 30000 characters is cut to its last 30000; the result names a file that holds all of it.
- \`description\` is a short, plain summary of what the command does, shown to the user.
- Independent commands can go in parallel calls in one message; dependent ones belong in one call, chained as the edition section says. Do not separate commands with newlines outside quoted strings, and do not start a command with \`cd\` or \`Set-Location\`.

Long-running commands:
- Set run_in_background: true for a command that takes longer than you want to wait. The call returns a task id at once, and you are told when the command finishes, in a <system-reminder> on a later tool result. Read its output with task_output (block: true waits for it) and stop it with kill_task. Background commands stop when your turn ends, so collect or stop each one before you finish.
- Do not wait with \`Start-Sleep\` or a polling loop; a foreground command that starts with a long \`Start-Sleep\` is refused.

Git:
- Never change git config, skip hooks (\`--no-verify\`), bypass signing or force-push unless the user asked for exactly that. When a hook fails, fix what it found.
- Prefer a new commit to \`--amend\`. Run a command that discards work (\`reset --hard\`, \`checkout --\`, \`restore\`, \`clean -f\`, \`branch -D\`) only when the user asked for exactly that and nothing safer does the job.
- Commit or push only when the user asks.`;
}
