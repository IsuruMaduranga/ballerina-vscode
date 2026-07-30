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

import React, { useMemo } from "react";
import { BallerinaRpcClient, Context } from "@wso2/ballerina-rpc-client";
import { BiWsClient } from "../../wsManager/WsClient";

/**
 * A minimal `BallerinaRpcClient` look-alike backed by the wizard's `BiWsClient`.
 *
 * The wizard renders the shared `ArtifactForm` in collect-only mode BEFORE a
 * project is open, where the real vscode-messenger rpcClient does not exist.
 * Model-fetch calls the wizard genuinely needs — and expression DIAGNOSTICS, which
 * must catch an invalid value before submit rather than at generation time — go
 * over the WS bridge, resolved against the throwaway staging package. The
 * convenience calls (completions, signature help, visible types) are stubbed with
 * correct-shaped empty results, so expression fields degrade to a plain validated
 * textbox (no autocomplete) instead of crashing.
 *
 * Upgrading any stub to a real LS-backed handler only requires routing it to a
 * new bridge action here — this adapter is the single seam.
 */
/**
 * Wraps a manager stub so any method it doesn't define resolves to `undefined`
 * with a console warning instead of crashing the render with
 * "x is not a function". Notify-style calls (formDidOpen/formDidClose/…) and
 * future additions degrade silently this way.
 */
function withFallback<T extends object>(managerName: string, real: T): T {
    return new Proxy(real, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            // 'then' must stay undefined so the manager object is not thenable.
            if (value !== undefined || typeof prop !== "string" || prop === "then") {
                return value;
            }
            return async (): Promise<undefined> => {
                console.warn(`[CreateIntegrationWizard] Stubbed pre-project rpc call: ${managerName}.${prop}`);
                return undefined;
            };
        },
    }) as T;
}

function createWizardRpcAdapter(wsClient: BiWsClient): BallerinaRpcClient {
    const noopUnsubscribe = () => { };

    const biDiagramRpcClient = withFallback("BIDiagram", {
        getExpressionCompletions: async () => [] as any,
        getDataMapperCompletions: async () => [] as any,
        getExpressionDiagnostics: (params: any) => wsClient.getExpressionDiagnostics(params),
        getSignatureHelp: async () => ({ signatures: [] as any[], activeSignature: 0, activeParameter: 0 }),
        getVisibleTypes: async () => [] as any,
        getExpressionTokens: async () => [] as number[],
        // Import statements are applied at generation time (post-reload) from the
        // collected form imports — nothing to offset pre-project.
        updateImports: async () => ({ importStatementOffset: 0 }),
        getNodeTemplate: (params: any) => wsClient.getNodeTemplate(params),
    });

    const serviceDesignerRpcClient = withFallback("ServiceDesigner", {
        getResourceReturnTypes: async () => [] as any,
        getTriggerModels: (params: any) => wsClient.getTriggerModels(params),
        getServiceInitModel: (params: any) => wsClient.getServiceInitModel(params),
    });

    const visualizerRpcClient = withFallback("Visualizer", {
        // Navigation is meaningless pre-project — the wizard owns view flow.
        openView: async () => { },
        getThemeKind: async () =>
            document.body.classList.contains("vscode-light") ? "light" : "dark",
    });

    const commonRpcClient = withFallback("Common", {
        showErrorMessage: (params: any) => wsClient.showErrorMessage(params),
        // File pickers (FILE_SELECT fields — "Import from OpenAPI Specification",
        // GraphQL schema, …) go over the WS bridge to the host's open dialog.
        // `allowOutsideProject` is forced: pre-project there is no target package to
        // hold the file yet, and the host would otherwise offer to copy the picked
        // spec into whatever project happens to be open — a different package than
        // the one being created. The absolute path is read at generation time
        // (post-reload), so it needs no project-relative home.
        selectFileOrDirPath: (params: any) => wsClient.selectFileOrDirPath({ ...params, allowOutsideProject: true }),
        selectFileOrFolderPath: () => wsClient.selectFileOrFolderPath(),
    });

    const adapter = {
        getBIDiagramRpcClient: () => biDiagramRpcClient,
        getServiceDesignerRpcClient: () => serviceDesignerRpcClient,
        getVisualizerRpcClient: () => visualizerRpcClient,
        getCommonRpcClient: () => commonRpcClient,
        // Pre-project there is no visualizer state machine — an empty location
        // reads as "no view/project" to consumers (e.g. ParamManager's GraphQL check).
        getVisualizerLocation: async () => ({} as any),
        onThemeChanged: (_callback: (kind: unknown) => void) => noopUnsubscribe,
    };

    // Unknown manager getters (getAiPanelRpcClient, …) return an all-stub
    // manager; other unknown client methods resolve to an empty object (safe
    // for the common `(await rpcClient.x()).prop` pattern) — so unexpected
    // descendants degrade instead of crashing the render.
    return new Proxy(adapter, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (value !== undefined || typeof prop !== "string" || prop === "then") {
                return value;
            }
            if (prop.startsWith("get") && prop.endsWith("RpcClient")) {
                const manager = withFallback(prop.slice(3).replace(/RpcClient$/, ""), {});
                return () => manager;
            }
            return async (): Promise<any> => {
                console.warn(`[CreateIntegrationWizard] Stubbed pre-project rpc call: rpcClient.${prop}`);
                return {};
            };
        },
    }) as unknown as BallerinaRpcClient;
}

interface WizardRpcAdapterProviderProps {
    wsClient: BiWsClient;
    children: React.ReactNode;
}

/**
 * Mounts the `@wso2/ballerina-rpc-client` React context with the WS-backed
 * adapter so `useRpcContext()` consumers (ArtifactForm and descendants) work
 * inside the pre-project wizard — in both the native and embedded transports.
 */
export function WizardRpcAdapterProvider({ wsClient, children }: WizardRpcAdapterProviderProps) {
    const rpcClient = useMemo(() => createWizardRpcAdapter(wsClient), [wsClient]);
    const value = useMemo(() => ({ rpcClient }), [rpcClient]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
