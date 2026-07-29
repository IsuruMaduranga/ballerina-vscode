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

import { MACHINE_VIEW } from "@wso2/ballerina-core";
import { loadMarkdown } from "../components/Markdown";

/**
 * Warms the chunk a view lives in, so the navigation that needs it does not pay for
 * the download and evaluation.
 *
 * Every view in the visualizer is reached through a dynamic `import()`, which means
 * the first navigation to each one loads megabytes of chunk before anything can
 * render — the reason a view is slow exactly once and instant afterwards. Nothing
 * here changes what a navigation does; it only moves that one-time cost into idle
 * time after the current view has painted.
 *
 * The specifiers must stay identical to the ones at the real import sites (webpack
 * keys chunks by resolved module, so a differently written path pointing at the same
 * file still shares the chunk — but a path pointing somewhere else silently warms
 * the wrong thing).
 */
const WARMERS = {
    workspaceOverview: () => import("../views/BI/WorkspaceOverview"),
    packageOverview: () => import("../views/BI/PackageOverview"),
    addProjectForm: () => import("../views/BI/ProjectForm/AddProjectForm"),
    createIntegrationWizard: () => import("../views/BI/CreateIntegrationWizard"),
    componentDiagram: () => import("../views/BI/ComponentDiagram"),
    componentListView: () => import("../views/BI/ComponentListView"),
    serviceDesigner: () => import("../views/BI/ServiceDesigner"),
    flowDiagram: () => import("../views/BI/DiagramWrapper"),
    markdown: loadMarkdown,
};

export type PrefetchTarget = keyof typeof WARMERS;

/** Erases each warmer's module type, which is of no interest to the queue. */
const warmerFor = (target: PrefetchTarget): (() => Promise<unknown>) => WARMERS[target];

/**
 * What to warm once a view is on screen, keyed by the view the user is looking at.
 * Ordered by how likely the next click is, because the queue is drained one entry at
 * a time; views not listed here get nothing, which is the right default for leaves
 * of the navigation tree.
 */
const AFTER_VIEW: Partial<Record<MACHINE_VIEW, PrefetchTarget[]>> = {
    [MACHINE_VIEW.WorkspaceOverview]: ["packageOverview", "addProjectForm", "componentDiagram"],
    [MACHINE_VIEW.PackageOverview]: ["addProjectForm", "componentListView", "serviceDesigner", "flowDiagram"],
    [MACHINE_VIEW.BIComponentView]: ["serviceDesigner", "flowDiagram"],
    // The welcome view's only forward paths are creating and opening a project.
    [MACHINE_VIEW.BIWelcome]: ["createIntegrationWizard", "workspaceOverview", "packageOverview"],
};

const requested = new Set<PrefetchTarget>();
const queue: PrefetchTarget[] = [];
let loading = false;

/** Runs `task` when the webview is next idle, so warming never delays a paint. */
function whenIdle(task: () => void): void {
    const idle = (window as any).requestIdleCallback as
        | ((cb: () => void, opts?: { timeout: number }) => void)
        | undefined;
    if (idle) {
        idle(task, { timeout: 2000 });
    } else {
        setTimeout(task, 300);
    }
}

function drain(): void {
    if (loading) {
        return;
    }
    const next = queue.shift();
    if (!next) {
        return;
    }
    loading = true;
    whenIdle(() => {
        Promise.resolve()
            .then(warmerFor(next))
            // A warmer failing is not a user-visible problem: the real import site
            // will retry and surface the error there. Logged rather than swallowed
            // so a chunk that never loads is still diagnosable.
            .catch((error) => console.warn(`Failed to prefetch the "${next}" chunk.`, error))
            .then(() => {
                loading = false;
                drain();
            });
    });
}

/** Queues `targets` for warming, skipping anything already requested. */
export function prefetchChunks(targets: PrefetchTarget[]): void {
    for (const target of targets) {
        if (requested.has(target)) {
            continue;
        }
        requested.add(target);
        queue.push(target);
    }
    drain();
}

/** Warms what the user is most likely to open next from `view`. */
export function prefetchAfterView(view: MACHINE_VIEW | undefined): void {
    const targets = view && AFTER_VIEW[view];
    if (targets) {
        prefetchChunks(targets);
    }
}
