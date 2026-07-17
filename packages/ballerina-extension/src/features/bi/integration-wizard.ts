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

import * as fs from "fs";
import * as path from "path";
import {
    CancelIntegrationWizardRequest,
    CreateIntegrationRequest,
    isSamePath,
    ProjectRequest,
    ScaffoldIntegrationProjectRequest,
    ScaffoldIntegrationProjectResponse,
    WizardCapabilitiesResponse,
} from "@wso2/ballerina-core";
import { createBIProjectPure, openInVSCode, sanitizeName } from "../../utils/bi";
import { schedulePendingArtifact } from "./pending-artifact";

/** Bumped whenever the wizard wire contract changes in a way remote hosts must detect. */
const WIZARD_CAPABILITIES_VERSION = 1;

/**
 * Scaffold roots created by THIS window's wizard sessions, keyed by normalized
 * root path, mapped to the parameter fingerprint they were scaffolded with.
 * Deletion is only ever allowed for roots tracked here (plus a Ballerina.toml
 * presence check) so a user-picked pre-existing directory can never be removed.
 */
const sessionScaffolds = new Map<string, string>();

function normalizeRoot(root: string): string {
    return path.normalize(path.resolve(root));
}

function scaffoldParamsKey(params: ScaffoldIntegrationProjectRequest): string {
    return JSON.stringify([params.integrationName, params.packageName, normalizeRoot(params.projectPath)]);
}

/** Computes the root `createBIProjectPure` will resolve for these params (without creating it). */
function computeProjectRoot(params: ScaffoldIntegrationProjectRequest): string {
    return path.join(params.projectPath, sanitizeName(params.packageName));
}

/**
 * Deletes a scaffold root created earlier in this session. Guards: the root must
 * be session-tracked AND still look like a Ballerina package (Ballerina.toml).
 * Returns true when the directory was removed.
 */
function deleteSessionScaffold(root: string): boolean {
    const normalized = normalizeRoot(root);
    if (!sessionScaffolds.has(normalized)) {
        console.log(`>>> Skipping scaffold cleanup for untracked root: ${root}`);
        return false;
    }
    sessionScaffolds.delete(normalized);
    if (!fs.existsSync(path.join(normalized, "Ballerina.toml"))) {
        console.log(`>>> Skipping scaffold cleanup — no Ballerina.toml at: ${root}`);
        return false;
    }
    fs.rmSync(normalized, { recursive: true, force: true });
    console.log(`>>> Removed abandoned wizard scaffold at: ${root}`);
    return true;
}

/**
 * Silently scaffolds the integration package for the Create Integration wizard
 * (step 2 → 3) WITHOUT opening it. Idempotent per parameter set: re-invoking
 * with unchanged params returns the already-scaffolded root. When params changed
 * on back-navigation, the previous session scaffold is removed (guarded) and a
 * fresh one is created.
 */
export async function scaffoldIntegrationProject(
    params: ScaffoldIntegrationProjectRequest
): Promise<ScaffoldIntegrationProjectResponse> {
    const projectRoot = computeProjectRoot(params);
    const normalizedRoot = normalizeRoot(projectRoot);
    const paramsKey = scaffoldParamsKey(params);

    // Already scaffolded this session with the same params — reuse it.
    if (sessionScaffolds.get(normalizedRoot) === paramsKey) {
        return { projectRoot };
    }

    // Params changed (e.g. new integration name at the same location) — rebuild.
    if (sessionScaffolds.has(normalizedRoot)) {
        deleteSessionScaffold(normalizedRoot);
    }

    // Back-navigation moved the scaffold elsewhere — clean up the previous root.
    if (params.previousScaffoldRoot && !isSamePath(params.previousScaffoldRoot, projectRoot)) {
        deleteSessionScaffold(params.previousScaffoldRoot);
    }

    // Org and version are intentionally omitted: `createBIProjectPure` falls back
    // to the OS username and "0.1.0", matching the legacy createBIProject flow.
    const projectRequest: ProjectRequest = {
        projectName: params.integrationName,
        packageName: params.packageName,
        projectPath: params.projectPath,
        createDirectory: true,
    };
    const createdRoot = await createBIProjectPure(projectRequest);
    sessionScaffolds.set(normalizeRoot(createdRoot), paramsKey);
    return { projectRoot: createdRoot };
}

/**
 * Final submit of the Create Integration wizard: ensures the package is
 * scaffolded, persists the pending first artifact (generated post-reload by
 * `checkAndRunPendingArtifact`), and opens the project — the single terminal
 * window reload of the whole flow.
 */
export async function createIntegration(params: CreateIntegrationRequest): Promise<void> {
    let projectRoot = params.scaffoldedProjectRoot;
    if (!projectRoot) {
        projectRoot = (await scaffoldIntegrationProject(params.project)).projectRoot;
    }
    if (params.artifact) {
        await schedulePendingArtifact(projectRoot, params.artifact);
    }
    // The project is being adopted — it must never be cleaned up as abandoned.
    sessionScaffolds.delete(normalizeRoot(projectRoot));
    openInVSCode(projectRoot);
}

/** Cancels a wizard session, removing its silent scaffold (guarded). */
export async function cancelIntegrationWizard(params: CancelIntegrationWizardRequest): Promise<void> {
    if (params?.scaffoldedRoot) {
        deleteSessionScaffold(params.scaffoldedRoot);
    }
}

/** Version-skew handshake for embedded hosts (see `WizardCapabilitiesResponse`). */
export function getWizardCapabilities(): WizardCapabilitiesResponse {
    return { threeStepWizard: true, version: WIZARD_CAPABILITIES_VERSION };
}
