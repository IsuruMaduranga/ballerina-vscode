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

import React, { Suspense, useEffect } from "react";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { AIMachineStateValue, MachineStateValue } from "@wso2/ballerina-core";
import styled from '@emotion/styled';

import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react";
import { Global, css } from '@emotion/react';
import { DownloadIcon } from "./components/DownloadIcon";
import { WebviewErrorBoundary } from "./components/WebviewErrorBoundary";
import { ThemeColors } from "@wso2/ui-toolkit";
import { LoadingRing } from "./components/Loader";

const MainPanel = React.lazy(() => import("./MainPanel"));
const AIPanel = React.lazy(() => import("./views/AIPanel/AIPanel"));
const AgentChat = React.lazy(() =>
    import("./views/AgentChatPanel/AgentChat").then((module) => ({ default: module.AgentChat }))
);
const EvaluationHistory = React.lazy(() =>
    import("./views/EvaluationHistory/EvaluationHistory").then((module) => ({ default: module.EvaluationHistory }))
);
const EvaluationReport = React.lazy(() =>
    import("./views/EvaluationReport/EvaluationReport").then((module) => ({ default: module.EvaluationReport }))
);
const MigrationPanel = React.lazy(() =>
    import("./views/MigrationPanel/MigrationPanel").then((module) => ({ default: module.MigrationPanel }))
);

const ProgressRing = styled(VSCodeProgressRing)`
    height: 36px;
    width: 36px;
`;

const LoadingContent = styled.div`
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    width: 100%;
    text-align: center;
    animation: fadeIn 1s ease-in-out;
`;

const LoadingTitle = styled.h1`
    color: var(--vscode-foreground);
    font-size: 1.5em;
    font-weight: 400;
    margin: 0;
    margin-top: 1.5rem;
    letter-spacing: -0.02em;
    line-height: normal;
`;

const LoadingSubtitle = styled.p`
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
    margin: 0.5rem 0 2rem 0;
    opacity: 0.8;
`;

const LoadingText = styled.div`
    color: ${ThemeColors.PRIMARY};
    font-size: 13px;
    font-weight: 500;
`;

const globalStyles = css`
    @keyframes fadeIn {
        0% { opacity: 0; }
        100% { opacity: 1; }
    }
    .loading-dots::after {
        content: '';
        animation: dots 1.5s infinite;
    }
    @keyframes dots {
        0%, 20% { content: ''; }
        40% { content: '.'; }
        60% { content: '..'; }
        80%, 100% { content: '...'; }
    }
`;

const MODES = {
    VISUALIZER: "visualizer",
    AI: "ai",
    RUNTIME_SERVICES: "runtime-services",
    AGENT_CHAT: "agent-chat",
    MIGRATION: "migration",
    EVALUATION_HISTORY: "evaluation-history",
    EVALUATION_REPORT: "evaluation-report",
};

export function Visualizer({ mode }: { mode: string }) {
    const { rpcClient } = useRpcContext();
    const [state, setState] = React.useState<MachineStateValue>('initialize');
    const [aiState, setAIState] = React.useState<AIMachineStateValue>('Initialize');

    if (mode === MODES.VISUALIZER) {
        rpcClient?.onStateChanged((newState: MachineStateValue) => {
            setState(newState);
        });
    }

    if (mode === MODES.AI) {
        rpcClient?.onAIPanelStateChanged((newState: AIMachineStateValue) => {
            setAIState(newState);
        });
    }

    useEffect(() => {
        if (mode === MODES.VISUALIZER) {
            rpcClient.webviewReady();
        }
    }, []);

    return (
        <WebviewErrorBoundary
            title="Unable to load the visualizer"
            message="A required webview chunk failed to load. Retry to reload the webview."
            onRetry={() => window.location.reload()}
        >
            {/* Chunk-loading fallback: keep narrating the create (when there is one)
                rather than flipping to a generic message for the last moment of it. */}
            <Suspense fallback={<LanguageServerLoadingView startupIntegration={readStartupIntegration()} />}>
                {(() => {
                    switch (mode) {
                        case MODES.VISUALIZER:
                            return <VisualizerComponent state={state} />
                        case MODES.RUNTIME_SERVICES:
                            return <MainPanel />
                        case MODES.AI:
                            return <Suspense fallback={<LoadingRing />}><AIPanel state={aiState} /></Suspense>
                        case MODES.AGENT_CHAT:
                            return <AgentChat />
                        case MODES.MIGRATION:
                            return <MigrationPanel />
                        case MODES.EVALUATION_HISTORY:
                            return <EvaluationHistory />
                        case MODES.EVALUATION_REPORT:
                            return <EvaluationReport />
                        default:
                            return <MainPanel />
                    }
                })()}
            </Suspense>
        </WebviewErrorBoundary>
    );
};

/**
 * The create-in-progress this window was opened to finish, injected into the
 * webview's HTML by the extension (see `VisualizerWebview.getWebviewContent`).
 * Read synchronously, so the very first React render already has it.
 */
interface StartupIntegration {
    integrationName: string;
    /** e.g. "service" — absent for an empty integration. */
    artifactLabel?: string;
}

type StartupIntegrationHost = { startupIntegration?: StartupIntegration | null };

function readStartupIntegration(): StartupIntegration | undefined {
    return (window as unknown as StartupIntegrationHost).startupIntegration ?? undefined;
}

/** Consumed once: see the effect in `VisualizerComponent`. */
function clearStartupIntegration(): void {
    (window as unknown as StartupIntegrationHost).startupIntegration = null;
}

const VisualizerComponent = React.memo(({ state }: { state: MachineStateValue }) => {
    const isViewReady = typeof state === 'object' && 'viewActive' in state && state.viewActive === "viewReady";

    // The startup narrative belongs to startup only. Once a view has been shown the
    // create is over, so drop it — any later loading state is an ordinary one and
    // must not claim the integration is still being created.
    useEffect(() => {
        if (isViewReady) {
            clearStartupIntegration();
        }
    }, [isViewReady]);

    switch (true) {
        case isViewReady:
            return <MainPanel />;
        case typeof state === 'object' && 'viewActive' in state && state.viewActive === "resolveMissingDependencies":
            return <PullingDependenciesView />;
        default:
            return <LanguageServerLoadingView startupIntegration={readStartupIntegration()} />;
    }
});

/**
 * The pre-view loading screen. When this window is finishing a Create Integration
 * wizard submit it continues that flow's "Creating <name>" screen — same layout
 * and wording as both the wizard before the reload and the static HTML this app
 * replaces — so the whole create reads as one progress screen rather than a
 * sequence of unrelated waits.
 */
const LanguageServerLoadingView = ({ startupIntegration }: { startupIntegration?: StartupIntegration }) => {
    return (
        <div style={{
            backgroundColor: 'var(--vscode-editor-background)',
            height: '100vh',
            width: '100%',
            display: 'flex',
            fontFamily: 'var(--vscode-font-family)'
        }}>
            <Global styles={globalStyles} />
            <LoadingContent>
                <ProgressRing />
                <LoadingTitle>
                    {startupIntegration
                        ? `Creating ${startupIntegration.integrationName}`
                        : "Activating Language Server"}
                </LoadingTitle>
                <LoadingSubtitle>
                    {startupIntegration
                        ? `Setting up your ${startupIntegration.artifactLabel ?? "integration"}.`
                        : "Preparing your Ballerina development environment."}
                </LoadingSubtitle>
                <LoadingText>
                    <span className="loading-dots">{startupIntegration ? "Opening workspace" : "Initializing"}</span>
                </LoadingText>
            </LoadingContent>
        </div>
    );
};

const PullingDependenciesView = () => {
    const { rpcClient } = useRpcContext();
    const [currentModule, setCurrentModule] = React.useState<string>('Compiling project...');

    React.useEffect(() => {
        rpcClient?.onDependencyPullProgress((message: string) => {
            setCurrentModule(message);
        });
    }, [rpcClient]);

    return (
        <div style={{
            backgroundColor: 'var(--vscode-editor-background)',
            height: '100vh',
            width: '100%',
            display: 'flex',
            fontFamily: 'var(--vscode-font-family)'
        }}>
            <Global styles={globalStyles} />
            <LoadingContent>
                <DownloadIcon color="var(--vscode-progressBar-background)" sx={{ width: '36px', height: '36px' }} />
                <LoadingTitle>
                    Pulling Dependencies
                </LoadingTitle>
                <LoadingSubtitle>
                    Please wait while your project dependencies are being pulled.
                </LoadingSubtitle>
                <LoadingText>
                    {currentModule}
                </LoadingText>
            </LoadingContent>
        </div>
    );
};
