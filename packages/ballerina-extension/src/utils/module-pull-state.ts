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

/** Token prefix of the LS's module-pull work-done progress (`PullModuleExecutor`). */
const PULL_MODULE_TOKEN_PREFIX = "pull-module-";

/** Stop extending a wait for a pull after this long, in case its `end` never arrives. */
export const MAX_MODULE_PULL_WAIT_MS = 5 * 60 * 1000;

export type ProgressKind = "begin" | "report" | "end";

const activePulls = new Set<string>();
const listeners = new Set<(kind: ProgressKind) => void>();

/**
 * Feeds a work-done progress update from the LS. Called from the language client's
 * `handleWorkDoneProgress` middleware, which sees every update without replacing the client's
 * own `$/progress` dispatch.
 */
export function trackModulePullProgress(token: string | number, kind: ProgressKind): void {
    if (typeof token !== "string" || !token.startsWith(PULL_MODULE_TOKEN_PREFIX)) {
        return;
    }
    if (kind === "begin") {
        activePulls.add(token);
    } else if (kind === "end") {
        activePulls.delete(token);
    }
    listeners.forEach(listener => listener(kind));
}

export function isModulePullInProgress(): boolean {
    return activePulls.size > 0;
}

/** Listens to module-pull progress updates; returns the function that stops listening. */
export function onModulePullProgress(listener: (kind: ProgressKind) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export interface PullAwareTimeout {
    cancel: () => void;
}

/**
 * Calls `onTimeout` after `ms` without a module pull running. While the LS pulls modules, the
 * countdown starts over each time it runs out, for up to {@link MAX_MODULE_PULL_WAIT_MS} from the start.
 */
export function startPullAwareTimeout(onTimeout: () => void, ms: number): PullAwareTimeout {
    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof setTimeout>;
    const arm = () => {
        timeoutId = setTimeout(() => {
            if (isModulePullInProgress() && Date.now() - startedAt < MAX_MODULE_PULL_WAIT_MS) {
                arm();
                return;
            }
            onTimeout();
        }, ms);
    };
    arm();
    return { cancel: () => clearTimeout(timeoutId) };
}
