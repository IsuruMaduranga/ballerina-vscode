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
    isSamePath,
    MACHINE_VIEW,
    PendingIntegrationArtifactKind,
    PendingIntegrationArtifactPayload,
} from "@wso2/ballerina-core";
import { extension } from "../../BalExtensionContext";
import { openView, StateMachine } from "../../stateMachine";
import { ServiceDesignerRpcManager } from "../../rpc-managers/service-designer/rpc-manager";
import { BiDiagramRpcManager } from "../../rpc-managers/bi-diagram/rpc-manager";

/** globalState key — only one pending wizard artifact is allowed at a time. */
export const PENDING_INTEGRATION_ARTIFACT_KEY = "ballerina.pendingIntegrationArtifact";

/** Milliseconds before a stale pending-artifact entry is discarded. */
const PENDING_ARTIFACT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Payload file location inside the scaffolded project (target/ is gitignored by the scaffold). */
const PENDING_ARTIFACT_RELATIVE_PATH = path.join("target", ".wizard-pending-artifact.json");

/** Human-readable labels for progress and error messages, per artifact kind. */
const ARTIFACT_KIND_LABELS: Record<PendingIntegrationArtifactKind, string> = {
    SERVICE: "service",
    AUTOMATION: "automation",
    WORKFLOW: "workflow",
    AI_CHAT_AGENT: "AI chat agent",
};

/**
 * Shape of the value stored in VS Code globalState before the terminal
 * `vscode.openFolder` reload. The pointer stays small; the filled model payload
 * lives in the project's `target/.wizard-pending-artifact.json`.
 */
interface PendingIntegrationArtifactPointer {
    projectRoot: string;
    /** epoch ms — used to discard stale entries (> 10 min). */
    timestamp: number;
}

function pendingArtifactFilePath(projectRoot: string): string {
    return path.join(projectRoot, PENDING_ARTIFACT_RELATIVE_PATH);
}

/** True when `child` is `parent` itself or a directory nested inside it. */
function isPathInside(child: string, parent: string): boolean {
    const resolvedChild = path.resolve(child);
    const resolvedParent = path.resolve(parent);
    return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

/**
 * Persists the wizard's configured first artifact so it can be generated after
 * the window reload. Call this right before `openInVSCode(projectRoot)`.
 */
export async function schedulePendingArtifact(
    projectRoot: string,
    payload: PendingIntegrationArtifactPayload
): Promise<void> {
    const payloadFile = pendingArtifactFilePath(projectRoot);
    fs.mkdirSync(path.dirname(payloadFile), { recursive: true });
    fs.writeFileSync(payloadFile, JSON.stringify(payload), "utf8");

    const pointer: PendingIntegrationArtifactPointer = { projectRoot, timestamp: Date.now() };
    await extension.context.globalState.update(PENDING_INTEGRATION_ARTIFACT_KEY, pointer);
    console.log(`[IntegrationWizard] Scheduled pending ${payload.kind} artifact for project: ${projectRoot}`);
}

/**
 * Checks whether the Create Integration wizard scheduled a first artifact
 * before the last folder reload and, if so, generates it and navigates to it.
 *
 * Consume-immediately semantics: the globalState pointer and the payload file
 * are both cleared BEFORE any generation runs, so a failure can never loop.
 * Safe to call on every activation — a no-op when there is no pending entry.
 * Never throws.
 */
export async function checkAndRunPendingArtifact(): Promise<void> {
    try {
        const stored = extension.context.globalState.get<PendingIntegrationArtifactPointer>(
            PENDING_INTEGRATION_ARTIFACT_KEY
        );
        if (!stored) {
            return;
        }

        // Consume the pointer immediately to avoid re-running on later activations.
        await extension.context.globalState.update(PENDING_INTEGRATION_ARTIFACT_KEY, undefined);

        const payload = consumePendingArtifactPayload(stored.projectRoot);
        if (!payload) {
            return;
        }

        // Discard stale entries (e.g. the user opened an unrelated workspace later).
        const age = Date.now() - stored.timestamp;
        if (age > PENDING_ARTIFACT_TTL_MS) {
            console.log(`[IntegrationWizard] Discarding stale pending artifact (age: ${Math.round(age / 1000)}s)`);
            return;
        }

        // The pending artifact only applies to the project it was scheduled for.
        // It was created either as a standalone package (opened directly, so it is
        // the context's projectPath) or inside an existing Ballerina workspace (the
        // workspace root is opened and projectPath is undefined, so match by the
        // package living under the opened workspace).
        const ctx = StateMachine.context();
        const opensStoredPackage = isSamePath(stored.projectRoot, ctx.projectPath);
        const insideOpenWorkspace = !!ctx.workspacePath && isPathInside(stored.projectRoot, ctx.workspacePath);
        if (!opensStoredPackage && !insideOpenWorkspace) {
            console.log(
                `[IntegrationWizard] Pending artifact project (${stored.projectRoot}) does not match ` +
                `the opened project (projectPath=${ctx.projectPath}, workspacePath=${ctx.workspacePath}) — skipping.`
            );
            return;
        }

        const label = ARTIFACT_KIND_LABELS[payload.kind];
        if (!label || payload.version !== 1) {
            console.error(`[IntegrationWizard] Unsupported pending artifact payload:`, payload);
            return;
        }

        const addedIntoWorkspace = insideOpenWorkspace && !opensStoredPackage;
        console.log(
            `[IntegrationWizard] Pending artifact: kind=${payload.kind}, projectRoot=${stored.projectRoot}, ` +
            `opensStoredPackage=${opensStoredPackage}, insideOpenWorkspace=${insideOpenWorkspace}, ` +
            `addedIntoWorkspace=${addedIntoWorkspace}`
        );
        try {
            await window.withProgress(
                { location: ProgressLocation.Notification, title: `Setting up your ${label}...` },
                () => generatePendingArtifact(payload, stored.projectRoot)
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[IntegrationWizard] Failed to generate pending ${payload.kind} artifact:`, error);
            window.showErrorMessage(
                `Couldn't create the ${label}: ${message}. ` +
                `Your integration was created; you can add the artifact from the Artifacts panel.`
            );
        }
    } catch (error) {
        console.error("[IntegrationWizard] Unexpected error while checking pending artifact:", error);
    }
}

/**
 * Reads and immediately deletes the payload file (consume-before-generate).
 * Returns undefined when the file is missing or unreadable.
 */
function consumePendingArtifactPayload(projectRoot: string): PendingIntegrationArtifactPayload | undefined {
    const payloadFile = pendingArtifactFilePath(projectRoot);
    let raw: string;
    try {
        raw = fs.readFileSync(payloadFile, "utf8");
    } catch (error) {
        console.warn(`[IntegrationWizard] No pending artifact payload at: ${payloadFile}`, error);
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
 * Runs the kind-specific generation and navigates to the produced artifact. All
 * files are targeted inside `projectRoot` — the newly created package — which is
 * the context's projectPath for a standalone package and a child package path
 * when added into an existing workspace (where the context has no projectPath).
 */
async function generatePendingArtifact(payload: PendingIntegrationArtifactPayload, projectRoot: string): Promise<void> {
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
            openPackageOverview(projectRoot);
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
            openPackageOverview(projectRoot);
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
 * Lands on the new package's overview after the first artifact is created, rather
 * than drilling into the artifact's own designer. The overview lists the new
 * artifact and is the expected place to land after creating an integration. The
 * package root is passed as `projectPath` so it resolves correctly in a workspace
 * (where the context has no active `projectPath`).
 */
function openPackageOverview(projectRoot: string): void {
    openView(EVENT_TYPE.OPEN_VIEW, { view: MACHINE_VIEW.PackageOverview, projectPath: projectRoot });
}
