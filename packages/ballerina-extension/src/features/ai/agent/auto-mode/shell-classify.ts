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
 * Builds the classifier request for one shell command and runs it (design
 * §4): the thread's transcript (user messages and tool inputs, results
 * stripped), the user's denials, the earlier calls of the step still running,
 * a `{"meta":{"gitStatus":…}}` line above a
 * command that can destroy uncommitted work, then the command under review as
 * the last entry. The model call is injected, so this runs under Jest.
 */

import { classify, type ClassifierDeps } from "./classifier";
import type { ShellKind } from "./classifier-prompt";
import type { AutoModeConfig } from "./config";
import { gitStatusMeta, gitStatusMetaArgs, reachesIgnoredFiles, wantsGitStatusMeta } from "./git-status-meta";
import type { ClassifyVerdict } from "./prompt";
import type { TranscriptEntry } from "./transcript";
import { transcriptFromGenerations, unstoredToolCalls, type TranscriptGeneration, type TranscriptToolCall } from "./transcript-source";

export interface ShellClassifyInput {
    command: string;
    /** The shell tool's name (`shell` or `powershell`). */
    tool: "shell" | "powershell";
    cwd: string;
    generations: readonly TranscriptGeneration[];
    /** Commands the user declined earlier in the thread, as `denied` entries. */
    denials: readonly TranscriptEntry[];
    /** The run's tool calls as their tools started (`run-tool-calls.ts`); the unstored ones are added. */
    runToolCalls?: readonly TranscriptToolCall[];
    /** The shell call under review, left out of `runToolCalls`. */
    toolCallId?: string;
    agentsMd?: string;
    username: string;
    scratchpadDir?: string;
    config: AutoModeConfig;
    /** Runs `git status` for the meta line; undefined when git could not say. */
    gitStatus?: (cwd: string, args: readonly string[]) => Promise<string | undefined>;
}

/** The ruleset's shell kind for a tool name. */
export function shellKindOf(tool: "shell" | "powershell", edition: "core" | "desktop" | "unknown" = "unknown"): ShellKind {
    return tool === "powershell" ? { kind: "powershell", edition } : { kind: "bash" };
}

/** Classify one shell command in auto mode. Never rejects. */
export async function classifyShellCommand(input: ShellClassifyInput, deps: ClassifierDeps): Promise<ClassifyVerdict> {
    const { entries, userMessages, toolCallIds } = transcriptFromGenerations(input.generations);
    const transcript: TranscriptEntry[] = [
        ...entries,
        ...input.denials,
        ...unstoredToolCalls(input.runToolCalls ?? [], toolCallIds, input.toolCallId),
    ];
    const flavour = input.tool === "powershell" ? "powershell" : "bash";
    if (input.gitStatus && wantsGitStatusMeta(flavour, input.command)) {
        const porcelain = await input.gitStatus(input.cwd, gitStatusMetaArgs(reachesIgnoredFiles(flavour, input.command)));
        const meta = porcelain === undefined ? undefined : gitStatusMeta(porcelain);
        if (meta) { transcript.push({ kind: "meta", gitStatus: meta }); }
    }
    transcript.push({ kind: "tool", tool: input.tool, input: { command: input.command } });
    return classify(
        {
            transcript,
            userMessages,
            agentsMd: input.agentsMd,
            username: input.username,
            scratchpadDir: input.scratchpadDir,
            environment: input.config.environment,
            ruleExtras: { hardDeny: input.config.hardDeny, softDeny: input.config.softDeny, allow: input.config.allow },
            toolName: input.tool,
        },
        deps,
    );
}
