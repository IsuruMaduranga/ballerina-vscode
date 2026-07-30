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
import { ProgressLocation, window } from "vscode";
import {
    EVENT_TYPE,
    INTEGRATION_ARTIFACT_LABELS,
    isPathInside,
    isSamePath,
    MACHINE_VIEW,
    PendingIntegrationArtifactPayload,
} from "@wso2/ballerina-core";
import { openView, StateMachine } from "../../stateMachine";
import { ServiceDesignerRpcManager } from "../../rpc-managers/service-designer/rpc-manager";
import { BiDiagramRpcManager } from "../../rpc-managers/bi-diagram/rpc-manager";
import {
    clearPendingIntegrationPointer,
    isPendingPointerFresh,
    PendingIntegrationArtifactPointer,
    readPendingIntegrationPointer,
    writePendingIntegrationPointer,
} from "./startup-progress";

/** Payload file location inside the scaffolded project (target/ is gitignored by the scaffold). */
const PENDING_ARTIFACT_RELATIVE_PATH = path.join("target", ".wizard-pending-artifact.json");

/** Human-readable labels for progress and error messages, per artifact kind. */
const ARTIFACT_KIND_LABELS = INTEGRATION_ARTIFACT_LABELS;

function pendingArtifactFilePath(projectRoot: string): string {
    return path.join(projectRoot, PENDING_ARTIFACT_RELATIVE_PATH);
}

/**
 * Records the wizard's create so the reloaded window can finish it. Written even for an
 * empty integration — it is also what lets the new window narrate "Creating <name>".
 * Call right before `openInVSCode(projectRoot)`.
 */
export async function schedulePendingIntegration(
    projectRoot: string,
    integrationName: string,
    payload?: PendingIntegrationArtifactPayload
): Promise<void> {
    if (payload) {
        const payloadFile = pendingArtifactFilePath(projectRoot);
        fs.mkdirSync(path.dirname(payloadFile), { recursive: true });
        fs.writeFileSync(payloadFile, JSON.stringify(payload), "utf8");
    }

    await writePendingIntegrationPointer({
        projectRoot,
        timestamp: Date.now(),
        integrationName,
        artifactKind: payload?.kind,
    });
    console.log(
        `[IntegrationWizard] Scheduled pending ${payload?.kind ?? "empty"} integration for project: ${projectRoot}`
    );
}

/**
 * Finishes a wizard submit that spanned the last folder reload: generates the configured
 * first artifact and lands on the new integration. Consume-immediately — the pointer and
 * payload file are cleared BEFORE generation, so a failure can never loop. Safe on every
 * activation; never throws. No progress toast: the startup screen already narrates the wait.
 */
export async function checkAndRunPendingArtifact(): Promise<void> {
    try {
        const stored = readPendingIntegrationPointer();
        if (!stored) {
            return;
        }

        // Consume the pointer immediately to avoid re-running on later activations.
        await clearPendingIntegrationPointer();

        const payload = consumePendingArtifactPayload(stored.projectRoot);

        // Discard stale entries (e.g. the user opened an unrelated workspace later).
        if (!isPendingPointerFresh(stored)) {
            const age = Date.now() - stored.timestamp;
            console.log(`[IntegrationWizard] Discarding stale pending artifact (age: ${Math.round(age / 1000)}s)`);
            return;
        }

        // Match the entry to the opened project: a standalone package is the context's
        // projectPath; inside a workspace only workspacePath is set.
        const ctx = StateMachine.context();
        const opensStoredPackage = isSamePath(stored.projectRoot, ctx.projectPath);
        const insideOpenWorkspace = !!ctx.workspacePath && isPathInside(ctx.workspacePath, stored.projectRoot);
        if (!opensStoredPackage && !insideOpenWorkspace) {
            console.log(
                `[IntegrationWizard] Pending artifact project (${stored.projectRoot}) does not match ` +
                `the opened project (projectPath=${ctx.projectPath}, workspacePath=${ctx.workspacePath}) — skipping.`
            );
            return;
        }

        // An empty integration has no payload: there is nothing to generate, only
        // the landing view below to open.
        if (!payload) {
            ensureLandedOnNewIntegration(stored, opensStoredPackage);
            return;
        }

        const label = ARTIFACT_KIND_LABELS[payload.kind];
        if (!label || payload.version !== 1) {
            console.error(`[IntegrationWizard] Unsupported pending artifact payload:`, payload);
            ensureLandedOnNewIntegration(stored, opensStoredPackage);
            return;
        }

        const addedIntoWorkspace = insideOpenWorkspace && !opensStoredPackage;
        console.log(
            `[IntegrationWizard] Pending artifact: kind=${payload.kind}, projectRoot=${stored.projectRoot}, ` +
            `opensStoredPackage=${opensStoredPackage}, insideOpenWorkspace=${insideOpenWorkspace}, ` +
            `addedIntoWorkspace=${addedIntoWorkspace}`
        );
        try {
            // Standalone: land on the package overview (the package's home). Added
            // into a workspace: don't drill into the package — the landing below
            // puts the window on the workspace overview instead.
            await generatePendingArtifact(payload, stored.projectRoot, opensStoredPackage);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[IntegrationWizard] Failed to generate pending ${payload.kind} artifact:`, error);
            window.showErrorMessage(
                `Couldn't create the ${label}: ${message}. ` +
                `Your integration was created; you can add the artifact from the Artifacts panel.`
            );
        }
        // Whatever generation did (navigated, didn't, or failed), never leave the window
        // on the startup screen.
        ensureLandedOnNewIntegration(stored, opensStoredPackage);
    } catch (error) {
        console.error("[IntegrationWizard] Unexpected error while checking pending artifact:", error);
    }
}

/**
 * Guarantees the window lands on a real view after a wizard create. Acts only when
 * nothing has navigated yet (machine still in `extensionReady`), so it stays a no-op on
 * paths that navigate themselves.
 */
function ensureLandedOnNewIntegration(
    pointer: PendingIntegrationArtifactPointer,
    opensStoredPackage: boolean
): void {
    // Read the raw machine value rather than `StateMachine.state()`: the shared
    // `MachineStateValue` type predates the startup states and does not include
    // `extensionReady`, which is exactly the one being tested here.
    if (StateMachine.service().getSnapshot().value !== "extensionReady") {
        return;
    }
    if (opensStoredPackage) {
        openPackageOverview(pointer.projectRoot);
        return;
    }
    openView(EVENT_TYPE.OPEN_VIEW, { view: MACHINE_VIEW.WorkspaceOverview });
}

/** Reads and immediately deletes the payload file; undefined when missing (empty integration) or unreadable. */
function consumePendingArtifactPayload(projectRoot: string): PendingIntegrationArtifactPayload | undefined {
    const payloadFile = pendingArtifactFilePath(projectRoot);
    if (!fs.existsSync(payloadFile)) {
        return undefined;
    }
    let raw: string;
    try {
        raw = fs.readFileSync(payloadFile, "utf8");
    } catch (error) {
        console.warn(`[IntegrationWizard] Could not read pending artifact payload at: ${payloadFile}`, error);
        return undefined;
    }
    try {
        fs.rmSync(payloadFile, { force: true });
    } catch (error) {
        console.warn(`[IntegrationWizard] Failed to delete pending artifact payload: ${payloadFile}`, error);
    }
    try {
        return JSON.parse(raw) as PendingIntegrationArtifactPayload;
    } catch (error) {
        console.error(`[IntegrationWizard] Pending artifact payload is not valid JSON: ${payloadFile}`, error);
        return undefined;
    }
}

/**
 * Generates the first artifact for a package added into a workspace already open in this
 * window — runs in the current session, no pointer and no reload.
 */
export async function generateArtifactInPlace(
    packageRoot: string,
    payload: PendingIntegrationArtifactPayload,
    landOnPackageOverview = false
): Promise<void> {
    const label = ARTIFACT_KIND_LABELS[payload.kind];
    if (!label || payload.version !== 1) {
        console.error(`[IntegrationWizard] Unsupported artifact payload for in-place generation:`, payload);
        return;
    }

    try {
        await window.withProgress(
            { location: ProgressLocation.Notification, title: `Generating your ${label}...` },
            () => generatePendingArtifact(payload, packageRoot, landOnPackageOverview)
        );
        // A non-silent refresh lands on the workspace overview, which would clobber the
        // package overview navigated to above.
        StateMachine.refreshProjectInfo({ silent: landOnPackageOverview });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[IntegrationWizard] Failed to generate ${payload.kind} artifact in place:`, error);
        window.showErrorMessage(
            `Couldn't create the ${label}: ${message}. ` +
            `Your integration was created; you can add the artifact from the Artifacts panel.`
        );
    }
}

/**
 * Runs the kind-specific generation and navigates to the result. All files target
 * `projectRoot` (the new package). `landOnPackageOverview`: true for a standalone package;
 * false when added into a workspace, so the window stays on the project overview.
 */
async function generatePendingArtifact(
    payload: PendingIntegrationArtifactPayload,
    projectRoot: string,
    landOnPackageOverview: boolean
): Promise<void> {
    switch (payload.kind) {
        case "SERVICE": {
            if (!payload.serviceInitModel) {
                throw new Error("The service configuration is missing");
            }
            // Target the new package explicitly (`<projectRoot>/main.bal`) so it works
            // both standalone and when the package lives inside an opened workspace.
            await new ServiceDesignerRpcManager().createServiceAndListener({
                filePath: "",
                projectPath: projectRoot,
                serviceInitModel: payload.serviceInitModel,
            });
            if (landOnPackageOverview) {
                openPackageOverview(projectRoot);
            }
            return;
        }
        case "AUTOMATION":
        case "WORKFLOW": {
            if (!payload.flowNode) {
                throw new Error("The function configuration is missing");
            }
            // Same default file the FunctionForm targets (MainPanel's getDefaultFunctionsFile).
            const filePath = path.join(projectRoot, "functions.bal");
            await new BiDiagramRpcManager().getSourceCode({
                filePath,
                flowNode: payload.flowNode,
                isFunctionNodeUpdate: true,
            });
            if (landOnPackageOverview) {
                openPackageOverview(projectRoot);
            }
            return;
        }
        case "AI_CHAT_AGENT": {
            // Pragmatic v1: the agent's multi-RPC orchestration stays webview-side —
            // land on the AI Chat Agent wizard with the chosen name carried on the
            // existing `identifier` field of the visualizer location.
            openView(EVENT_TYPE.OPEN_VIEW, {
                view: MACHINE_VIEW.AIChatAgentWizard,
                identifier: payload.aiAgent?.name,
            });
            return;
        }
        default:
            throw new Error(`Unsupported artifact kind: ${(payload as PendingIntegrationArtifactPayload).kind}`);
    }
}

/**
 * Lands on the new package's overview; the package root is passed as `projectPath` so it
 * resolves inside a workspace.
 */
function openPackageOverview(projectRoot: string): void {
    openView(EVENT_TYPE.OPEN_VIEW, { view: MACHINE_VIEW.PackageOverview, projectPath: projectRoot });
}
