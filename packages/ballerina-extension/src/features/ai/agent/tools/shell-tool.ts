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

import { tool } from 'ai';
import { z } from 'zod';
import { CopilotEventHandler } from '../../utils/events';
import type { ShellAuthorization } from '../auto-mode/gate';
import { bashToolDescription, SHELL_TOOL_NAME } from '../shell/bash-description';
import { bashGuardReason } from '../shell/guards';
import { tailCap } from '../shell/output';
import { finishLine } from '../shell/runner';
import { runShellCall, type ShellCallParams } from '../shell/shell-call';
import { bashSpawn } from '../shell/shell-spawn';
import { diffSnapshots, hasTouchedFiles, snapshotWorkspace, type TouchedFiles } from '../shell/touched-files';

export { SHELL_TOOL_NAME };

/** How much output the tool row carries to the UI. */
const UI_OUTPUT_CAP = 2_000;

const ShellInputSchema = z.object({
    command: z.string().describe("The command to run."),
    description: z.string().optional().describe("A short, plain summary of what the command does, shown to the user (5-10 words)."),
    timeout: z.number().optional().describe("Timeout in milliseconds, at most 600000. Default 120000."),
    run_in_background: z.boolean().optional().describe("Run in the background and return a task id at once. Read the output with task_output; stop it with kill_task."),
});


export interface ShellToolOptions {
    eventHandler: CopilotEventHandler;
    /** The workspace root: every command runs here. */
    cwd: string;
    /** `subagents/types.ts buildRunKey` for this run. */
    runKey: string;
    /** The thread's scratchpad: task logs and spilled output go under it. */
    scratchpadDir?: string;
    /** Decides whether a command may run (`auto-mode/gate.ts`). Required: the tool must never run a command no gate has seen. */
    authorize: (request: { command: string; description?: string; toolCallId: string }) => Promise<ShellAuthorization>;
    /** Registers files a command changed (`tools/shell-touched-files.ts`); without it no scan runs. */
    onFilesTouched?: (touched: TouchedFiles) => Promise<void>;
}

/** The bash `shell` tool (macOS and Linux). */
export function createShellTool(opts: ShellToolOptions) {
    return tool({
        description: bashToolDescription(),
        inputSchema: ShellInputSchema,
        execute: async (input: ShellCallParams, context?: { toolCallId?: string; abortSignal?: AbortSignal }): Promise<string> => {
            const toolCallId = context?.toolCallId || `fallback-${Date.now()}`;
            const background = input.run_in_background === true;
            opts.eventHandler({
                type: "tool_call",
                toolName: SHELL_TOOL_NAME,
                toolCallId,
                toolInput: { command: input.command, description: input.description, run_in_background: background },
            });
            const emitResult = (status: "completed" | "error" | "blocked" | "background", toolOutput: Record<string, unknown>) =>
                opts.eventHandler({ type: "tool_result", toolName: SHELL_TOOL_NAME, toolCallId, toolOutput: { status, command: input.command, description: input.description, ...toolOutput } });

            const authorization = await opts.authorize({ command: input.command, description: input.description, toolCallId });
            if (authorization.allowed === false) {
                emitResult("blocked", { reason: authorization.text });
                return authorization.text;
            }

            // Stat the workspace around a command that may write, so its edits join the review.
            const before = opts.onFilesTouched && authorization.mayWrite ? snapshotWorkspace(opts.cwd) : undefined;
            const registerTouched = async () => {
                if (!before || !opts.onFilesTouched) { return; }
                const touched = diffSnapshots(before, snapshotWorkspace(opts.cwd));
                if (!hasTouchedFiles(touched)) { return; }
                try {
                    await opts.onFilesTouched(touched);
                } catch (error) {
                    console.error('[ShellTool] Failed to register files the command changed:', error);
                }
            };

            const result = await runShellCall(input, {
                toolName: SHELL_TOOL_NAME,
                label: "Bash",
                spawn: bashSpawn(),
                guard: bashGuardReason,
                cwd: opts.cwd,
                runKey: opts.runKey,
                toolCallId,
                signal: context?.abortSignal,
                scratchpadDir: opts.scratchpadDir,
                onBackgroundFinished: () => { void registerTouched(); },
            });
            if (result.kind === "foreground") { await registerTouched(); }
            if (result.kind === "refused") {
                emitResult("blocked", { reason: result.text });
            } else if (result.kind === "background") {
                emitResult("background", { taskId: result.taskId, logPath: result.logPath });
            } else {
                const line = finishLine(result.summary, result.timeoutMs);
                emitResult(line === "completed" ? "completed" : "error", {
                    exitCode: result.summary.exitCode,
                    finish: line,
                    output: tailCap(result.summary.output, UI_OUTPUT_CAP),
                    outputFile: result.outputFile,
                });
            }
            return result.text;
        }
    });
}
