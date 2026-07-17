/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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

import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProgressIndicator, Typography } from "@wso2/ui-toolkit";
import { WsClientProvider, WiBridgeClient } from "./integrator-form/context/WsClientContext";
import { CloudContextProvider } from "./integrator-form/providers";
import { BIProjectForm } from "./integrator-form";
import { ProjectCreationView } from "./integrator-form/ProjectCreationView";
import { LibraryCreationView } from "./integrator-form/LibraryCreationView";
import { EmbeddedWsRpc, createCompositeClient, WsCoords } from "./wsRpc";
import { BiWsClient } from "../../wsManager/WsClient";
import { BiWsClientProvider } from "../../wsManager/WsClientContext";
import { CreateIntegrationWizard } from "../../CreateIntegrationWizard";

/**
 * Which BI creation form to render. `integration` is the primary
 * "Create New Integration" form (rendered inside the host's CreationView chrome);
 * `project` and `library` are the welcome "More Actions" flows, which carry their
 * own page chrome and a Back button driven by `onBack`.
 */
export type EmbeddedFormMode = "integration" | "project" | "library";

export interface EmbeddedBIProjectFormProps {
    /** The embedding host's client. Used for the WS bootstrap and cloud reads. */
    wsClient: WiBridgeClient;
    ballerinaUnavailable?: boolean;
    /** The variant to render. Defaults to `integration`. */
    mode?: EmbeddedFormMode;
    /** Back navigation for the self-chromed `project`/`library` variants. */
    onBack?: () => void;
}

const stateContainerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "320px",
    textAlign: "center",
    padding: "24px",
};

/** How long the capability probe waits before falling back to the legacy form. */
const WIZARD_PROBE_TIMEOUT_MS = 5000;

/** Version-skew handshake state for the integration mode. */
type WizardSupport = "probing" | "supported" | "unsupported";

/**
 * Federation entry point. Connects to the Ballerina extension's WS server for
 * project-creation RPCs, composes it with the host client (which keeps serving
 * cloud reads), and renders the appropriate creation form against that
 * composite. For `mode="integration"` it probes the extension's wizard
 * capabilities and renders the 3-step Create Integration wizard, falling back
 * to the legacy single-step form against an older extension.
 */
export default function EmbeddedBIProjectForm({ wsClient, ballerinaUnavailable, mode = "integration", onBack }: EmbeddedBIProjectFormProps) {
    const queryClient = useMemo(() => new QueryClient(), []);
    const [rpcClient, setRpcClient] = useState<WiBridgeClient | null>(null);
    const [biWsClient, setBiWsClient] = useState<BiWsClient | null>(null);
    const [wizardSupport, setWizardSupport] = useState<WizardSupport>("probing");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        let wsRpc: EmbeddedWsRpc | undefined;
        let wizardClient: BiWsClient | undefined;
        (async () => {
            try {
                const coords: WsCoords = await (wsClient as any).getBiFormWsBootstrap();
                if (cancelled) {
                    return;
                }

                if (mode === "integration") {
                    // Probe the 3-step wizard handshake first; an older extension
                    // without the handler rejects (or times out) → legacy form.
                    wizardClient = new BiWsClient({
                        mode: "websocket",
                        wsServer: coords.host,
                        wsPort: coords.port,
                        token: coords.token,
                    });
                    try {
                        const capabilities = await Promise.race([
                            wizardClient.getWizardCapabilities(),
                            new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error("capability probe timed out")), WIZARD_PROBE_TIMEOUT_MS)
                            ),
                        ]);
                        if (!cancelled && capabilities?.threeStepWizard) {
                            setBiWsClient(wizardClient);
                            setWizardSupport("supported");
                            return;
                        }
                    } catch (probeError) {
                        console.warn(">>> Create Integration wizard unavailable, using the legacy form.", probeError);
                    }
                    wizardClient.dispose();
                    wizardClient = undefined;
                    if (cancelled) {
                        return;
                    }
                    setWizardSupport("unsupported");
                }

                // Legacy stack (project/library modes and the integration fallback).
                wsRpc = new EmbeddedWsRpc(coords);
                if (cancelled) {
                    // Unmounted while the bootstrap was in flight — dispose the socket we
                    // just opened rather than leaking it.
                    wsRpc.dispose();
                    return;
                }
                setRpcClient(createCompositeClient(wsClient, wsRpc));
            } catch (connectError) {
                if (!cancelled) {
                    setError(
                        connectError instanceof Error
                            ? connectError.message
                            : "Failed to connect to the Ballerina service.",
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
            wsRpc?.dispose();
            wizardClient?.dispose();
        };
    }, [wsClient, mode]);

    if (error) {
        return (
            <div style={stateContainerStyle}>
                <Typography variant="h4">Unable to start the integration service</Typography>
                <Typography variant="body2">{error}</Typography>
            </div>
        );
    }

    if (mode === "integration" && wizardSupport === "supported" && biWsClient) {
        return (
            <BiWsClientProvider wsClient={biWsClient} onBack={onBack}>
                <CreateIntegrationWizard showHeader={false} />
            </BiWsClientProvider>
        );
    }

    if (!rpcClient) {
        return (
            <div style={stateContainerStyle}>
                <ProgressIndicator />
                <Typography variant="body2">Connecting to the integration service…</Typography>
            </div>
        );
    }

    return (
        <WsClientProvider wsClient={rpcClient}>
            <QueryClientProvider client={queryClient}>
                <CloudContextProvider>
                    {mode === "library" ? (
                        <LibraryCreationView onBack={onBack} ballerinaUnavailable={ballerinaUnavailable} />
                    ) : mode === "project" ? (
                        <ProjectCreationView onBack={onBack} ballerinaUnavailable={ballerinaUnavailable} />
                    ) : (
                        <BIProjectForm ballerinaUnavailable={ballerinaUnavailable} />
                    )}
                </CloudContextProvider>
            </QueryClientProvider>
        </WsClientProvider>
    );
}
