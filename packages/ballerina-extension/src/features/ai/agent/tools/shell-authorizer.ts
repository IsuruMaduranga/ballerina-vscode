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
 * The host side of the shell gate (`auto-mode/gate.ts`): the approval banner
 * through `ApprovalManager`, the classifier's model call (Sonnet 5.5 through
 * `getAnthropicClient`, so all four login methods work and screening spends
 * the user's quota), the thread's pause tracker and denials, and the decision
 * log under the thread's state directory.
 */

import { generateText } from 'ai';
import { userInfo } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { chatStateStorage } from '../../../../views/ai-panel/chatStateStorage';
import { approvalManager } from '../../state/ApprovalManager';
import { ANTHROPIC_SONNET, getAnthropicClient, getProviderCacheControl, getProviderModelOptions } from '../../utils/ai-client';
import { CopilotEventHandler } from '../../utils/events';
import type { ClassifierModelCall } from '../auto-mode/classifier';
import { defaultEnvironment } from '../auto-mode/classifier-prompt';
import { loadAgentsMdForClassifier, loadAutoModeConfig } from '../auto-mode/config';
import { appendDecision, decisionEntry } from '../auto-mode/decision-log';
import { authorizeShellCommand, sessionRuleStore, type ShellAuthorization, type ShellMode } from '../auto-mode/gate';
import { gitStatusOutput } from '../auto-mode/git';
import { PauseTracker } from '../auto-mode/pause';
import type { RunToolCallLog } from '../auto-mode/run-tool-calls';
import { classifyShellCommand, shellKindOf } from '../auto-mode/shell-classify';
import type { TranscriptEntry } from '../auto-mode/transcript';
import type { ShellRunSetup } from '../shell/shell-session';
import { SHELL_TOOL_NAME } from '../shell/bash-description';
import { POWERSHELL_TOOL_NAME } from '../shell/powershell-description';
import { powerShellEdition, powerShellSpawn } from '../shell/shell-spawn';

/** Per-thread pause trackers and user denials, in memory for as long as the extension host runs. */
const pauseTrackers = new Map<string, PauseTracker>();
const userDenials = new Map<string, TranscriptEntry[]>();

export function pauseTrackerFor(threadKey: string): PauseTracker {
    let tracker = pauseTrackers.get(threadKey);
    if (!tracker) {
        tracker = new PauseTracker();
        pauseTrackers.set(threadKey, tracker);
    }
    return tracker;
}

/** Forget a thread's gate state (its rules, pause counters and denials), for a cleared or deleted thread. */
export function resetShellGateState(threadKey: string): void {
    sessionRuleStore.clear(threadKey);
    pauseTrackers.delete(threadKey);
    userDenials.delete(threadKey);
}

/**
 * Output headroom for a model that cannot turn thinking off, added to both
 * stages' caps: Claude Sonnet 5.5 always thinks, and its reasoning otherwise
 * spends the budget before the verdict is written.
 */
export const FORCED_THINKING_PADDING = 2048;

/**
 * The classifier's model call: thinking at `low` effort (Claude Sonnet 5.5
 * cannot turn it off), our own retries only, and the system prompt (the
 * ruleset) cached for an hour, since classifier calls are sporadic and the
 * prefix is stable for the whole session.
 */
export const classifierModelCall: ClassifierModelCall = async ({ system, user, maxOutputTokens, abortSignal }) => {
    const model = await getAnthropicClient(ANTHROPIC_SONNET);
    const result = await generateText({
        model,
        maxOutputTokens: maxOutputTokens + FORCED_THINKING_PADDING,
        abortSignal,
        maxRetries: 0,
        providerOptions: getProviderModelOptions('low'),
        messages: [
            { role: 'system', content: system, providerOptions: getProviderCacheControl('1h') },
            { role: 'user', content: user },
        ],
    });
    return { text: result.text, finishReason: result.finishReason };
};

export interface ShellAuthorizerOptions {
    shell: ShellRunSetup;
    mode: ShellMode;
    eventHandler: CopilotEventHandler;
    /** `buildRunKey(projectRootPath, threadId)`: keys the thread's gate state. */
    runKey: string;
    projectRootPath: string;
    threadId: string;
    /** The run's tool calls, so the classifier sees the earlier calls of the step under review. */
    toolCallLog?: RunToolCallLog;
}

/** The `authorize` callback of the shell tool. */
export function createShellAuthorizer(opts: ShellAuthorizerOptions) {
    const { shell, mode, eventHandler, runKey, projectRootPath, threadId, toolCallLog } = opts;
    const tool = shell.tool;
    const toolName = tool === 'powershell' ? POWERSHELL_TOOL_NAME : SHELL_TOOL_NAME;
    const edition = tool === 'powershell' ? powerShellEdition(powerShellSpawn()) : undefined;
    const config = loadAutoModeConfig(shell.home, defaultEnvironment(shellKindOf(tool, edition)));
    if (config.diagnostics.length > 0) {
        console.warn(`[ShellTool] ~/.ballerina/copilot/auto-mode.json: ${config.diagnostics.join('; ')}`);
    }
    const logFile = config.logDecisions && projectRootPath
        ? join(chatStateStorage.getThreadDir(projectRootPath, threadId), 'auto-mode-decisions.jsonl')
        : undefined;

    return async ({ command, description, toolCallId, abortSignal }: { command: string; description?: string; toolCallId?: string; abortSignal?: AbortSignal }): Promise<ShellAuthorization> => {
        const pause = pauseTrackerFor(runKey);
        return authorizeShellCommand(
            {
                command,
                cwd: shell.cwd,
                home: shell.home,
                readableRoots: shell.readableRoots,
                writableRoots: shell.writableRoots,
                sessionRules: sessionRuleStore.get(runKey),
                shell: tool === 'powershell' ? 'powershell' : 'bash',
                // The main agent is pinned to Sonnet; weaker future callers must opt out.
                allowContainedFileOperations: true,
            },
            mode,
            {
                ask: (prompt) => approvalManager.requestShellApproval(`shell-${uuidv4()}`, {
                    toolName,
                    command: prompt.command,
                    description,
                    reasons: prompt.reasons,
                    sessionRuleLabel: prompt.grant?.label,
                }, eventHandler, prompt.timeoutMs),
                grantRule: (rule) => sessionRuleStore.add(runKey, rule),
                auto: {
                    pause,
                    classify: (subject) => classifyShellCommand(
                        {
                            command: subject,
                            tool,
                            cwd: shell.cwd,
                            generations: projectRootPath ? chatStateStorage.getGenerations(projectRootPath, threadId) : [],
                            denials: userDenials.get(runKey) ?? [],
                            runToolCalls: toolCallLog?.list(),
                            toolCallId,
                            agentsMd: loadAgentsMdForClassifier(shell.cwd),
                            username: safeUsername(),
                            scratchpadDir: shell.scratchpadDir,
                            config,
                            gitStatus: gitStatusOutput,
                        },
                        { call: classifierModelCall, signal: abortSignal },
                    ),
                },
                onDecision: (record) => {
                    if (!logFile) { return; }
                    appendDecision(logFile, decisionEntry({ ...record, tool: toolName, subject: command, sessionId: threadId, model: record.source === 'classifier' ? ANTHROPIC_SONNET : undefined }));
                },
                onUserDenied: (subject) => {
                    const list = userDenials.get(runKey) ?? [];
                    list.push({ kind: 'denied', tool, subject, rule: 'declined by the user at the approval prompt' });
                    userDenials.set(runKey, list.slice(-50));
                },
            },
        );
    };
}

function safeUsername(): string {
    try {
        return userInfo().username || 'user';
    } catch {
        return 'user';
    }
}
