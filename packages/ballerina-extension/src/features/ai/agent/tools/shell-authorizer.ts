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
import { CLASSIFIER_MAX_RETRIES, type ClassifierModelCall } from '../auto-mode/classifier';
import { classifierMessages, type ClassifierCacheState } from '../auto-mode/classifier-cache';
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

/** One thread's gate state besides its session rules. */
interface ThreadGateState {
    pause: PauseTracker;
    /** The commands the user declined, newest last, at most 50. */
    denials: TranscriptEntry[];
    classifierCache: ClassifierCacheState;
}

/** Per-thread gate state, in memory for as long as the extension host runs. */
const threadGateStates = new Map<string, ThreadGateState>();

function threadGateState(threadKey: string): ThreadGateState {
    let state = threadGateStates.get(threadKey);
    if (!state) {
        state = { pause: new PauseTracker(), denials: [], classifierCache: {} };
        threadGateStates.set(threadKey, state);
    }
    return state;
}

export function pauseTrackerFor(threadKey: string): PauseTracker {
    return threadGateState(threadKey).pause;
}

/** Forget a thread's gate state (its rules, pause counters, denials and cache hint), for a cleared or deleted thread. */
export function resetShellGateState(threadKey: string): void {
    sessionRuleStore.clear(threadKey);
    threadGateStates.delete(threadKey);
}

/**
 * Output headroom for a model that cannot turn thinking off, added to both
 * stages' caps: Claude Sonnet 5.5 always thinks, and its reasoning otherwise
 * spends the budget before the verdict is written.
 */
export const FORCED_THINKING_PADDING = 2048;

/**
 * The classifier's model call: thinking at `low` effort (Claude Sonnet 5.5
 * cannot turn it off), rate limits and server errors retried with backoff
 * inside the stage timeout, and every cache breakpoint at the one-hour TTL,
 * since classifier calls are sporadic and minutes apart. The system prompt
 * (the ruleset) is stable for the whole session; the user message goes as
 * one block per transcript entry with a breakpoint after the history and one
 * after the previous call's history (auto-mode/classifier-cache.ts), so
 * stage 2 and the next command read the history instead of writing it again.
 */
export const classifierModelCall: ClassifierModelCall = async ({ system, userParts, maxOutputTokens, abortSignal }) => {
    const model = await getAnthropicClient(ANTHROPIC_SONNET);
    const result = await generateText({
        model,
        maxOutputTokens: maxOutputTokens + FORCED_THINKING_PADDING,
        abortSignal,
        maxRetries: CLASSIFIER_MAX_RETRIES,
        providerOptions: getProviderModelOptions('low'),
        messages: classifierMessages(system, userParts, getProviderCacheControl('1h')),
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
    /** Called when the user declines a command in the approval banner (not on a classifier block or a timeout). */
    onUserDeclined?: () => void;
}

/** The `authorize` callback of the shell tool. */
export function createShellAuthorizer(opts: ShellAuthorizerOptions) {
    const { shell, mode, eventHandler, runKey, projectRootPath, threadId, toolCallLog, onUserDeclined } = opts;
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
                    classify: (subject, powershellParse) => classifyShellCommand(
                        {
                            command: subject,
                            tool,
                            cwd: shell.cwd,
                            home: shell.home,
                            extraRoots: shell.writableRoots,
                            powershellParse,
                            generations: projectRootPath ? chatStateStorage.getGenerations(projectRootPath, threadId) : [],
                            denials: threadGateState(runKey).denials,
                            runToolCalls: toolCallLog?.list(),
                            toolCallId,
                            agentsMd: loadAgentsMdForClassifier(shell.cwd),
                            username: safeUsername(),
                            scratchpadDir: shell.scratchpadDir,
                            config,
                            gitStatus: gitStatusOutput,
                        },
                        { call: classifierModelCall, signal: abortSignal, cache: threadGateState(runKey).classifierCache },
                    ),
                },
                onDecision: (record) => {
                    if (!logFile) { return; }
                    appendDecision(logFile, decisionEntry({ ...record, tool: toolName, subject: command, sessionId: threadId, model: record.source === 'classifier' ? ANTHROPIC_SONNET : undefined }));
                },
                onUserDenied: (subject) => {
                    const state = threadGateState(runKey);
                    state.denials.push({ kind: 'denied', tool, subject, rule: 'declined by the user at the approval prompt' });
                    state.denials = state.denials.slice(-50);
                    onUserDeclined?.();
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
