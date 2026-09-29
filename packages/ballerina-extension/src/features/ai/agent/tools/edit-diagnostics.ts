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

import * as path from 'path';
import { checkProjectDiagnostics } from '../../../../rpc-managers/ai-panel/repair-utils';
import { StateMachine } from '../../../../stateMachine';
import { DIAGNOSTICS_TOOL_NAME } from './diagnostics-utils';
import { affectsCompilation, DeliveredTracker, FileDiagnostics, findPackageRoot, formatNewDiagnostics, pathKey } from './new-diagnostics';

/**
 * How long an edit waits for its package's diagnostics. The language server compiles incrementally
 * from the project it already holds, so this is normally milliseconds; past the limit the edit
 * reports without them rather than stall the run.
 */
const EDIT_DIAGNOSTICS_TIMEOUT_MS = 20_000;

/** The promise's value, or undefined once `ms` pass first; the timer is always cleared. */
export async function resolveWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Said in place of the block when the check did not complete, so a missing block always means the
 * edit added no new errors.
 */
function uncheckedNote(reason: string): string {
    return `Compiler errors were not checked after this edit: ${reason}. Call ${DIAGNOSTICS_TOOL_NAME} before treating the code as compiling.`;
}

/** One run's view of which compiler errors the model has already been shown. */
export interface EditDiagnosticsReporter {
    /**
     * The `<new-diagnostics>` block for errors in the edited file's package that this run has not
     * delivered yet, a note when they could not be read, or undefined when there are none.
     */
    afterEdit(filePath: string): Promise<string | undefined>;
    /** Records a package's diagnostics the model saw some other way (the diagnostics tool) as delivered. */
    recordDelivered(diagnostics: FileDiagnostics[], packageRoot: string): void;
}

/**
 * Asks the language server for the edited file's package diagnostics through the same request as
 * the diagnostics tool, without its dependency-resolution step: a missing module shows up as the
 * error it is, and the diagnostics tool remains the place that pulls dependencies.
 */
export function createEditDiagnosticsReporter(projectRoot: string): EditDiagnosticsReporter {
    const tracker = new DeliveredTracker();
    // One language-server check at a time per package, each starting after the one before it has
    // answered: its result then includes every edit that landed first, and parallel edits or a
    // check that outlives its timeout never pile compiles onto the server.
    const lastCheck = new Map<string, Promise<unknown>>();
    return {
        async afterEdit(filePath: string): Promise<string | undefined> {
            if (!affectsCompilation(filePath)) {
                return undefined;
            }
            const absolute = path.resolve(projectRoot, filePath);
            const packageRoot = findPackageRoot(absolute, projectRoot);
            if (!packageRoot) {
                return uncheckedNote('the file is not inside a Ballerina package yet (no Ballerina.toml above it)');
            }
            tracker.clear(pathKey(absolute));
            const check = (lastCheck.get(packageRoot) ?? Promise.resolve())
                .then(() => checkProjectDiagnostics(StateMachine.langClient(), packageRoot));
            lastCheck.set(packageRoot, check.catch(() => undefined));
            try {
                const diagnostics = await resolveWithin(check, EDIT_DIAGNOSTICS_TIMEOUT_MS);
                if (!diagnostics) {
                    console.warn(`[EditDiagnostics] No diagnostics for ${filePath} within ${EDIT_DIAGNOSTICS_TIMEOUT_MS} ms`);
                    return uncheckedNote(`the language server did not answer within ${EDIT_DIAGNOSTICS_TIMEOUT_MS / 1000} s`);
                }
                return formatNewDiagnostics(tracker.takeNew(diagnostics, packageRoot), projectRoot);
            } catch (error) {
                // A package that cannot compile at all is the diagnostics tool's to explain.
                console.warn(`[EditDiagnostics] Could not read diagnostics after editing ${filePath}:`, error);
                return uncheckedNote('the package could not be compiled');
            }
        },
        recordDelivered(diagnostics: FileDiagnostics[], packageRoot: string): void {
            tracker.takeNew(diagnostics, packageRoot);
        },
    };
}

/**
 * Wraps a file tool's execute so a successful result also carries the compiler errors the edit newly
 * surfaced. Runs after the tool returns, and so after its file lock is released: a slow compile
 * never holds up the next edit to the same file.
 */
export function withEditDiagnostics<A extends { file_path: string }, R extends { success: boolean; message: string }>(
    reporter: EditDiagnosticsReporter | undefined,
    execute: (args: A) => Promise<R>
): (args: A) => Promise<R> {
    if (!reporter) {
        return execute;
    }
    return async (args) => {
        const result = await execute(args);
        const block = result.success ? await reporter.afterEdit(args.file_path) : undefined;
        return block ? { ...result, message: `${result.message}\n\n${block}` } : result;
    };
}
