/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as vscode from "vscode";

/**
 * A dedicated output channel for WSO2 Integrator Copilot review-diff diagnostics, kept separate
 * from the general "Ballerina" logs so a failed review diagram produces a clean, self-contained
 * trace that can be handed to the language-server team. Created lazily on first use.
 */
let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel("WSO2 Integrator Copilot");
    }
    return channel;
}

export function logReviewDiagnostic(message: string): void {
    getChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** Human-readable one-liner identifying which construct/range a flow-model request targets. */
export function describeFlowRequest(
    filePath: string | undefined,
    startLine: { line: number; offset: number } | undefined,
    endLine: { line: number; offset: number } | undefined,
    construct?: string
): string {
    const range = startLine && endLine
        ? `[${startLine.line}:${startLine.offset}-${endLine.line}:${endLine.offset}]`
        : "[unknown range]";
    const name = construct ? `"${construct}" ` : "";
    return `${name}${filePath ?? "unknown file"} ${range}`;
}

/**
 * Runs `run()` but resolves to `undefined` if it does not settle within `timeoutMs`, so a hung
 * or pathologically slow LS request can never freeze the review UI. Timeouts and errors are
 * logged to the review channel with timing; the caller logs the success/empty-model cases (it
 * knows how to inspect the result). The underlying promise is left to settle on its own — there
 * is no LS-side cancellation — but the UI no longer waits on it.
 */
export async function withReviewTimeout<T>(
    label: string,
    timeoutMs: number,
    run: () => Promise<T>
): Promise<T | undefined> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timedOut");
    const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });
    // Start the work once and keep the reference: if the timeout wins the race the promise is
    // orphaned, so swallow any late rejection here to avoid an unhandled-rejection warning.
    // (A rejection that arrives before the timeout still propagates to the race and is logged.)
    const runPromise = run();
    runPromise.catch(() => undefined);
    try {
        const result = await Promise.race([runPromise, timeout]);
        if (result === timedOut) {
            logReviewDiagnostic(`✗ TIMEOUT after ${timeoutMs}ms — ${label}`);
            return undefined;
        }
        return result as T;
    } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        logReviewDiagnostic(`✗ ERROR after ${Date.now() - start}ms — ${label}\n${detail}`);
        return undefined;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
