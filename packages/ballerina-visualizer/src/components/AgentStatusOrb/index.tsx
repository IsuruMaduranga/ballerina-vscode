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

import React, { useEffect, useState } from "react";
import styled from "@emotion/styled";
import { keyframes } from "@emotion/react";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { AgentRunStatus, AgentRunState, SHARED_COMMANDS } from "@wso2/ballerina-core";

/**
 * Floating ambient indicator for the Copilot agent's background run.
 *
 * Rendered as an overlay in the visualizer webview so users see what the agent
 * is doing while the AI panel is closed. Hidden when the agent is idle or the
 * AI panel is open (the panel itself shows richer progress). Clicking it opens
 * the Copilot chat.
 */

const ORB_COLORS: Record<Exclude<AgentRunState, "idle">, [string, string, string]> = {
    "running": ["#4facfe", "#a78bfa", "#f472b6"],
    "awaiting-input": ["#fbbf24", "#f59e0b", "#fb923c"],
    "completed": ["#34d399", "#10b981", "#6ee7b7"],
    "error": ["#f87171", "#ef4444", "#fb7185"],
};

const rotate = keyframes`
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
`;

const breathe = keyframes`
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.12); }
`;

const bloom = keyframes`
    0% { transform: scale(0.6); opacity: 0; }
    60% { transform: scale(1.15); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
`;

const fadeIn = keyframes`
    from { opacity: 0; transform: translateX(6px); }
    to { opacity: 1; transform: translateX(0); }
`;

const Wrapper = styled.div`
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: none;
`;

const LabelPill = styled.div`
    pointer-events: auto;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 12px;
    line-height: 1;
    padding: 7px 12px;
    border-radius: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    animation: ${fadeIn} 0.2s ease-out;
    cursor: pointer;
`;

interface OrbStyleProps {
    state: Exclude<AgentRunState, "idle">;
    colors: [string, string, string];
}

const OrbButton = styled.button<{ state: Exclude<AgentRunState, "idle"> }>`
    pointer-events: auto;
    position: relative;
    width: 38px;
    height: 38px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    outline-offset: 4px;
    animation: ${(props: Pick<OrbStyleProps, "state">) =>
        props.state === "awaiting-input" ? breathe : props.state === "completed" ? bloom : "none"}
        ${(props: Pick<OrbStyleProps, "state">) =>
        props.state === "awaiting-input" ? "1.6s ease-in-out infinite" : props.state === "completed" ? "0.6s ease-out" : ""};
`;

const Aura = styled.div<{ colors: [string, string, string]; spinning: boolean }>`
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    background: conic-gradient(
        from 0deg,
        ${(props: Pick<OrbStyleProps, "colors">) => `${props.colors[0]}, ${props.colors[1]}, ${props.colors[2]}, ${props.colors[0]}`}
    );
    filter: blur(7px);
    opacity: 0.85;
    animation: ${rotate} ${(props: { spinning: boolean }) => (props.spinning ? "2.8s" : "9s")} linear infinite;
`;

const Sphere = styled.div<{ colors: [string, string, string] }>`
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(
        circle at 32% 28%,
        rgba(255, 255, 255, 0.95),
        ${(props: Pick<OrbStyleProps, "colors">) => props.colors[0]} 45%,
        ${(props: Pick<OrbStyleProps, "colors">) => props.colors[1]} 100%
    );
    box-shadow: inset 0 -4px 8px rgba(0, 0, 0, 0.18);
`;

export function AgentStatusOrb() {
    const { rpcClient } = useRpcContext();
    const [status, setStatus] = useState<AgentRunStatus | null>(null);
    const [hovered, setHovered] = useState(false);

    useEffect(() => {
        if (!rpcClient) {
            return;
        }
        rpcClient
            .getCommonRpcClient()
            .getAgentRunStatus()
            .then(setStatus)
            .catch(() => {
                // Older extension host without the RPC — stay hidden.
            });
        rpcClient.onAgentRunStatusChanged(setStatus);
    }, [rpcClient]);

    if (!status || status.state === "idle" || status.aiPanelOpen) {
        return null;
    }

    const state = status.state as Exclude<AgentRunState, "idle">;
    const colors = ORB_COLORS[state];
    const label =
        status.label ??
        (state === "running" ? "Copilot is working" : state === "awaiting-input" ? "Copilot needs your input" : undefined);
    const showLabel = hovered || state === "awaiting-input" || state === "error";

    const openCopilot = () => {
        rpcClient?.getCommonRpcClient().executeCommand({ commands: [SHARED_COMMANDS.OPEN_AI_PANEL] });
    };

    return (
        <Wrapper onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
            {showLabel && label && <LabelPill onClick={openCopilot}>{label}</LabelPill>}
            <OrbButton
                state={state}
                onClick={openCopilot}
                title={label ? `BI Copilot — ${label}` : "BI Copilot"}
                aria-label={label ? `BI Copilot: ${label}. Open the Copilot chat.` : "Open the BI Copilot chat"}
            >
                <Aura colors={colors} spinning={state === "running"} />
                <Sphere colors={colors} />
            </OrbButton>
        </Wrapper>
    );
}
