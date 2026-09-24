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
 * The bash tool's description: which shell the model is writing
 * for, when a purpose-built tool is the better choice, one-line reads, the
 * scratchpad, background runs and git safety, in BI's own words. Tool names
 * are spelled out rather than imported, so this stays a leaf the Jest suite
 * can load (the tool modules pull `vscode`).
 */

export const SHELL_TOOL_NAME = "shell";

export function bashToolDescription(): string {
    return `Runs a command with bash (\`/bin/bash -c\`) in the workspace root and returns its combined stdout and stderr.

Each call starts a new, non-interactive bash process. There is no terminal, the working directory is always the workspace root, and \`cd\` or exported variables do not carry over to the next call. Chain dependent steps in one call with \`&&\`; use \`;\` only when a later step should run whatever the earlier one did.

Prefer the purpose-built tools where one exists:
- Reading, creating or changing files: file_read, file_write, file_edit and file_batch_edit. They keep the review view accurate. Do not use cat, head, tail, sed, awk or \`echo >\` for this.
- Compile errors: getCompilationErrors. Starting a service: runBallerinaPackage, which waits until it is ready and keeps it running after your turn; read its logs with task_output and stop it with kill_task. HTTP checks against a running service: hurlRunnerTool.
- Use this tool for the rest of what a terminal does: \`bal build\`, \`bal test\`, \`bal format\`, \`bal pack\`, \`bal pull\`, git, package managers, build scripts, and searching with grep, rg or find.

Writing the command:
- Keep a read-only look to one plain command per call (\`git status\`, \`grep -rn Client src\`, \`ls resources\`). A plain read runs straight away; a line that combines steps, loops or uses variables has to be checked first, which takes longer and may ask the user.
- Quote paths that contain spaces with double quotes.
- Put temporary files in the scratchpad directory named in the system prompt, never in /tmp or the user's project.
- \`timeout\` is in milliseconds: 120000 (2 minutes) by default, at most 600000 (10 minutes).
- Output past 30000 characters is cut to its last 30000; the result names a file that holds all of it.
- \`description\` is a short, plain summary of what the command does, shown to the user.

Long-running commands:
- Set run_in_background: true for a command that takes longer than you want to wait. The call returns a task id at once, and you are told when the command finishes, in a <system-reminder> on a later tool result. Read its output with task_output (block: true waits for it) and stop it with kill_task. Background commands stop when your turn ends, so collect or stop each one before you finish.
- Do not add \`&\`, \`nohup\` or \`setsid\` to a command, and do not wait with \`sleep\` or a polling loop: those calls are refused.

Git:
- Never change git config, skip hooks (\`--no-verify\`) or force-push.
- Run a command that discards work (\`reset --hard\`, \`checkout --\`, \`restore\`, \`clean -f\`, \`branch -D\`) only when the user asked for exactly that.
- Commit or push only when the user asks.
- Interactive forms (\`rebase -i\`, \`add -p\`) are refused: there is no terminal.`;
}
