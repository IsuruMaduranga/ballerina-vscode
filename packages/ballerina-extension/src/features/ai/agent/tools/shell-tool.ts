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
import { startAndEnd } from '../shell/output';
import { runShellCall, type ShellCallContext, type ShellCallParams } from '../shell/shell-call';
import { bashSpawn, powerShellEdition, powerShellSpawn, withPowerShellUtf8 } from '../shell/shell-spawn';
import { POWERSHELL_TOOL_NAME, powershellToolDescription } from '../shell/powershell-description';
import { powershellGuardReason } from '../shell/powershell-guards';
import { diffSnapshots, hasTouchedFiles, snapshotWorkspace, type TouchedFiles } from '../shell/touched-files';

export { SHELL_TOOL_NAME, POWERSHELL_TOOL_NAME };

/** The shell tool a platform gets (`shell/shell-policy.ts`). */
export type ShellToolKindName = "shell" | "powershell";

/** How much output the tool row carries to the UI. */
const UI_OUTPUT_CAP = 2_000;

const ShellInputSchema = z.object({
    command: z.string().describe("The command to run."),
    description: z.string().optional().describe("A short, plain summary of what the command does, shown to the user (5-10 words)."),
    timeout: z.number().optional().describe("Timeout in milliseconds, at most 600000. Default 120000."),
    run_in_background: z.boolean().optional().describe("Run in the background and return a task id at once. Read the output with task_output; stop it with kill_task."),
});


export interface ShellToolOptions {
    /** bash (`shell`, macOS / Linux) or PowerShell (`powershell`, Windows); bash when absent. */
    kind?: ShellToolKindName;
    eventHandler: CopilotEventHandler;
    /** The workspace root: every command runs here. */
    cwd: string;
    /** `subagents/types.ts buildRunKey` for this run. */
    runKey: string;
    /** The thread's scratchpad: task logs and spilled output go under it. */
    scratchpadDir?: string;
    /** Decides whether a command may run (`auto-mode/gate.ts`). Required: the tool must never run a command no gate has seen. */
    authorize: (request: { command: string; description?: string; toolCallId: string; abortSignal?: AbortSignal }) => Promise<ShellAuthorization>;
    /** Registers files a command changed (`tools/shell-touched-files.ts`); without it no scan runs. */
    onFilesTouched?: (touched: TouchedFiles) => Promise<void>;
    /** Starts a background `bal run` as a service (`tools/ballerina-run.ts startShellService`). */
    startService?: ShellCallContext["startService"];
    /** The commands' environment (`shell/bal-run.ts withBalOnPath`); the extension host's when absent. */
    env?: NodeJS.ProcessEnv;
}

/** What differs between the two shell tools; the body is shared (`shell/shell-call.ts`). */
function shellFlavour(kind: ShellToolKindName) {
    if (kind === "powershell") {
        const spawn = powerShellSpawn();
        return {
            name: POWERSHELL_TOOL_NAME,
            dialect: "powershell" as const,
            label: "PowerShell",
            description: powershellToolDescription(powerShellEdition(spawn)),
            spawn,
            guard: powershellGuardReason,
            wrapCommand: withPowerShellUtf8,
        };
    }
    return { name: SHELL_TOOL_NAME, dialect: "bash" as const, label: "Bash", description: bashToolDescription(), spawn: bashSpawn(), guard: bashGuardReason, wrapCommand: undefined };
}

/** The shell tool: bash `shell` on macOS and Linux, `powershell` on Windows. */
export function createShellTool(opts: ShellToolOptions) {
    const flavour = shellFlavour(opts.kind ?? "shell");
    return tool({
        description: flavour.description,
        inputSchema: ShellInputSchema,
        execute: async (input: ShellCallParams, context?: { toolCallId?: string; abortSignal?: AbortSignal }): Promise<string> => {
            const toolCallId = context?.toolCallId || `fallback-${Date.now()}`;
            const background = input.run_in_background === true;
            opts.eventHandler({
                type: "tool_call",
                toolName: flavour.name,
                toolCallId,
                toolInput: { command: input.command, description: input.description, run_in_background: background },
            });
            const emitResult = (status: "completed" | "error" | "blocked" | "background" | "service", toolOutput: Record<string, unknown>) =>
                opts.eventHandler({ type: "tool_result", toolName: flavour.name, toolCallId, toolOutput: { status, command: input.command, description: input.description, ...toolOutput } });

            const authorization = await opts.authorize({ command: input.command, description: input.description, toolCallId, abortSignal: context?.abortSignal });
            if (authorization.allowed === false) {
                emitResult("blocked", { reason: authorization.text, gate: { by: authorization.by, rule: authorization.rule } });
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
                toolName: flavour.name,
                dialect: flavour.dialect,
                label: flavour.label,
                spawn: flavour.spawn,
                guard: flavour.guard,
                wrapCommand: flavour.wrapCommand,
                cwd: opts.cwd,
                env: opts.env,
                runKey: opts.runKey,
                toolCallId,
                signal: context?.abortSignal,
                scratchpadDir: opts.scratchpadDir,
                onBackgroundFinished: () => { void registerTouched(); },
                startService: opts.startService,
            });
            if (result.kind === "foreground") { await registerTouched(); }
            const gate = { by: authorization.by };
            if (result.kind === "refused") {
                emitResult("blocked", { reason: result.text, gate });
            } else if (result.kind === "background") {
                emitResult("background", { taskId: result.taskId, logPath: result.logPath, gate });
            } else if (result.kind === "service") {
                const { start } = result;
                const service = { kind: "service", packagePath: result.packagePath, output: startAndEnd(start.output, UI_OUTPUT_CAP, UI_OUTPUT_CAP / 2), gate };
                if (start.kind === "started") {
                    emitResult("service", { ...service, taskId: start.taskId });
                } else {
                    emitResult("error", { ...service, exitCode: start.exitCode });
                }
            } else {
                // A nonzero exit the command's semantics call success (grep's "no match") reads as completed.
                const line = result.finish;
                emitResult(line === "completed" ? "completed" : "error", {
                    exitCode: result.summary.exitCode,
                    finish: line,
                    // The start and the end, where a failure prints its errors; `head` holds the start even when the buffer dropped it.
                    output: startAndEnd(result.summary.output, UI_OUTPUT_CAP, UI_OUTPUT_CAP / 2, result.summary.head, result.summary.length),
                    outputFile: result.summary.logPath,
                    gate,
                });
            }
            return result.text;
        }
    });
}
