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

import {
    INTEGRATION_ARTIFACT_LABELS,
    isPathInside,
    PendingIntegrationArtifactKind,
} from "@wso2/ballerina-core";
import { extension } from "../../BalExtensionContext";

/**
 * Bookkeeping for a Create Integration wizard submit that spans the terminal
 * `vscode.openFolder` reload.
 *
 * Deliberately dependency-light: the visualizer webview reads this while building
 * its very first HTML, so pulling in the state machine or the RPC managers here
 * would add an import cycle to the earliest, most fragile part of startup. The
 * caller passes in the path of the folder this window opened instead.
 */

/** globalState key — only one pending wizard create is allowed at a time. */
export const PENDING_INTEGRATION_ARTIFACT_KEY = "ballerina.pendingIntegrationArtifact";

/** Milliseconds before a stale pending entry is discarded. */
export const PENDING_ARTIFACT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Shape of the value stored in VS Code globalState before the reload. The pointer
 * stays small; any filled artifact model lives in the created project's
 * `target/.wizard-pending-artifact.json`.
 *
 * Written for EVERY wizard create — including an empty integration, which has no
 * payload file — because it is also what tells the freshly reloaded window that it
 * is mid-create, so the startup screen can name the integration being created
 * instead of showing a generic "Activating Language Server".
 */
export interface PendingIntegrationArtifactPointer {
    projectRoot: string;
    /** epoch ms — used to discard stale entries (> 10 min). */
    timestamp: number;
    /** Display name of the integration, for the startup progress screen. */
    integrationName?: string;
    /** Kind of the configured first artifact; absent for an empty integration. */
    artifactKind?: PendingIntegrationArtifactKind;
}

/**
 * What the reloaded window shows while it finishes a create that began before the
 * reload. Mirrors the wizard's own "Creating …" screen so the two read as one
 * continuous progress screen rather than two unrelated waits.
 */
export interface StartupIntegrationProgress {
    integrationName: string;
    /** e.g. "service" — absent for an empty integration. */
    artifactLabel?: string;
}

export function readPendingIntegrationPointer(): PendingIntegrationArtifactPointer | undefined {
    return extension.context?.globalState.get<PendingIntegrationArtifactPointer>(PENDING_INTEGRATION_ARTIFACT_KEY);
}

export async function writePendingIntegrationPointer(pointer: PendingIntegrationArtifactPointer): Promise<void> {
    await extension.context.globalState.update(PENDING_INTEGRATION_ARTIFACT_KEY, pointer);
}

export async function clearPendingIntegrationPointer(): Promise<void> {
    await extension.context.globalState.update(PENDING_INTEGRATION_ARTIFACT_KEY, undefined);
}

/** Whether `pointer` was written recently enough to still be acted on. */
export function isPendingPointerFresh(pointer: PendingIntegrationArtifactPointer): boolean {
    return Date.now() - pointer.timestamp <= PENDING_ARTIFACT_TTL_MS;
}

/**
 * Whether `pointer` belongs to the folder this window opened — either the created
 * package itself was opened, or it lives inside the opened workspace.
 * `isPathInside` is inclusive of the path itself, so it covers both.
 */
export function isPendingPointerForOpenedPath(
    pointer: PendingIntegrationArtifactPointer,
    openedPath: string | undefined
): boolean {
    return isPathInside(openedPath, pointer.projectRoot);
}

/**
 * The create-in-progress this window should narrate on its startup screen, or
 * undefined when this is an ordinary project open.
 *
 * Guarded exactly like the consumption path (`checkAndRunPendingArtifact`): a
 * stale entry, or one belonging to a different project, must never make an
 * unrelated window claim to be creating something.
 *
 * @param openedPath the workspace (or package) path this window opened.
 */
export function getStartupIntegrationProgress(openedPath: string | undefined): StartupIntegrationProgress | undefined {
    const pointer = readPendingIntegrationPointer();
    if (!pointer?.integrationName || !isPendingPointerFresh(pointer)) {
        return undefined;
    }
    if (!isPendingPointerForOpenedPath(pointer, openedPath)) {
        return undefined;
    }
    return {
        integrationName: pointer.integrationName,
        artifactLabel: pointer.artifactKind ? INTEGRATION_ARTIFACT_LABELS[pointer.artifactKind] : undefined,
    };
}
