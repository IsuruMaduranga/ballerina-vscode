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
import * as os from "os";
import * as path from "path";
import {
    CreateIntegrationRequest,
    isSamePath,
    ProjectRequest,
    ScaffoldIntegrationProjectResponse,
    WizardCapabilitiesResponse,
} from "@wso2/ballerina-core";
import { createBIComponent, createBIProjectPure, isAlreadyOpenFolder, openInVSCode } from "../../utils/bi";
import { generateArtifactInPlace, schedulePendingArtifact } from "./pending-artifact";
import { extension } from "../../BalExtensionContext";
import { StateMachine } from "../../stateMachine";

/** Bumped whenever the wizard wire contract changes in a way remote hosts must detect. */
const WIZARD_CAPABILITIES_VERSION = 1;

/** Fixed OS-temp home for the wizard's throwaway staging package. */
const STAGING_PARENT = path.join(os.tmpdir(), "wso2-integration-wizard");
/** Package name of the staging package (irrelevant to the artifact models it serves). */
const STAGING_PACKAGE = "integration";

/**
 * The active staging package root for this window's wizard session, or undefined
 * when none exists. The staging package is a throwaway Ballerina package created
 * ONLY so the language server can compute the step-3 artifact model against a
 * real package. It lives under the OS temp dir — never at the user's chosen
 * path — so an abandoned wizard can never occupy (and later collide with) the
 * final location. The real project is created fresh at finalize.
 */
let activeStagingRoot: string | undefined;

/** Removes the temp staging package (best-effort). Never touches user paths. */
function cleanupStaging(): void {
    activeStagingRoot = undefined;
    try {
        if (fs.existsSync(STAGING_PARENT)) {
            fs.rmSync(STAGING_PARENT, { recursive: true, force: true });
        }
    } catch (error) {
        console.warn("[IntegrationWizard] Failed to remove staging package:", error);
    }
}

/**
 * Provides the throwaway staging package the step-3 artifact form resolves its
 * language-server model against, creating it on first use and reusing it for the
 * rest of the session. Located in the OS temp dir, so it is invisible to the
 * user and can never collide with their chosen project path.
 */
export async function scaffoldIntegrationProject(): Promise<ScaffoldIntegrationProjectResponse> {
    if (activeStagingRoot && fs.existsSync(path.join(activeStagingRoot, "Ballerina.toml"))) {
        return { projectRoot: activeStagingRoot };
    }

    // Start from a clean slate — discard any stale staging left by a prior run.
    cleanupStaging();
    fs.mkdirSync(STAGING_PARENT, { recursive: true });

    // Org and version are intentionally omitted: `createBIProjectPure` falls back
    // to the OS username and "0.1.0". The name is irrelevant — the staging
    // package only hosts language-server model requests for the chosen artifact.
    const stagingRequest: ProjectRequest = {
        projectName: "Untitled",
        packageName: STAGING_PACKAGE,
        projectPath: STAGING_PARENT,
        createDirectory: true,
    };
    const projectRoot = await createBIProjectPure(stagingRequest);
    activeStagingRoot = projectRoot;
    return { projectRoot };
}

/**
 * Final submit of the Create Integration wizard: creates the real package FRESH
 * at the user's chosen path (the only point at which that path is ever touched),
 * persists the configured first artifact, discards the temp staging package, and
 * opens the project.
 *
 * When the chosen path resolves inside an existing Ballerina workspace, the
 * integration is added into that project (registered in the workspace toml)
 * instead of the new package being opened on its own. Two sub-cases:
 *  - The workspace is ALREADY open in this window (the common in-project "Add
 *    Integration" case) — no folder switch is needed, so the artifact is
 *    generated LIVE, in the current session (`generateArtifactInPlace`), with no
 *    window reload at all. This matches the library-add flow, which has never
 *    needed a reload either.
 *  - The workspace is a DIFFERENT, not-currently-open project — opening it is a
 *    genuine folder switch, so the first artifact is scheduled and generated
 *    post-reload by `checkAndRunPendingArtifact`, as before.
 */
export async function createIntegration(params: CreateIntegrationRequest): Promise<void> {
    const projectRequest: ProjectRequest = {
        projectName: params.project.integrationName,
        packageName: params.project.packageName,
        projectPath: params.project.projectPath,
        directoryName: params.project.directoryName,
        createDirectory: true,
        newProject: params.project.newProject,
        workspaceName: params.project.workspaceName,
        convertToWorkspace: params.project.convertToWorkspace,
    };
    const { packageRoot, openRoot } = await createBIComponent(projectRequest);
    cleanupStaging();

    // Live, no-reload path only when `openRoot` is a workspace the extension has
    // ALREADY activated (not merely a folder VS Code happens to have open — a
    // brand-new/just-converted workspace at the same path would be open in VS
    // Code too, but the extension hasn't recognized/activated it yet and still
    // needs the reload below to do so).
    const addedIntoActiveWorkspace = isAlreadyOpenFolder(openRoot) && isSamePath(StateMachine.context().workspacePath, openRoot);

    if (addedIntoActiveWorkspace) {
        if (params.artifact) {
            await generateArtifactInPlace(packageRoot, openRoot, params.artifact);
        } else {
            StateMachine.refreshProjectInfo();
        }
        return;
    }

    if (params.artifact) {
        await schedulePendingArtifact(packageRoot, params.artifact);
    }
    openInVSCode(openRoot);
}

/**
 * Discards the active wizard session's temp staging package. Called when the
 * wizard is abandoned (best-effort on unmount) and, race-free, whenever the
 * wizard (re)opens — so no staging package ever lingers. Because staging lives
 * in the OS temp dir and the real project is only created at finalize, this can
 * never affect a user's project.
 */
export async function cancelIntegrationWizard(): Promise<void> {
    cleanupStaging();
}

/** Alias kept for the mount-time sweep; identical to {@link cancelIntegrationWizard}. */
export async function cleanupAbandonedScaffolds(): Promise<void> {
    await cancelIntegrationWizard();
}

/** Version-skew handshake for embedded hosts (see `WizardCapabilitiesResponse`). */
export function getWizardCapabilities(): WizardCapabilitiesResponse {
    return {
        threeStepWizard: true,
        version: WIZARD_CAPABILITIES_VERSION,
        isWorkspaceSupported: extension.ballerinaExtInstance.isWorkspaceSupported,
    };
}
