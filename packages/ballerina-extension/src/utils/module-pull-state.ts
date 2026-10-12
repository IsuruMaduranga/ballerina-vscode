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

export type ProgressKind = "begin" | "report" | "end";

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
    listeners.forEach(listener => listener(kind));
}

/** Listens to module-pull progress updates; returns the function that stops listening. */
export function onModulePullProgress(listener: (kind: ProgressKind) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
