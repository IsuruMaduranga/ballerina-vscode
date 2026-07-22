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

import styled from "@emotion/styled";
import { AgentRunState, AgentRunStatus } from "@wso2/ballerina-core";
import { BallerinaRpcClient } from "@wso2/ballerina-rpc-client";

/** WSO2 brand orange — the pulse-icon color from wso2.com/about/brand. */
export const BRAND_ORANGE = "#F14E23";

export const ORB_COLORS: Record<AgentRunState, [string, string, string]> = {
    "idle": ["#6b5ce8", BRAND_ORANGE, "#ffb199"],
    "running": ["#4facfe", "#a78bfa", "#f472b6"],
    "awaiting-input": ["#fbbf24", "#f59e0b", "#fb923c"],
    "completed": ["#34d399", "#10b981", "#6ee7b7"],
    "error": ["#f87171", "#ef4444", "#fb7185"],
};

/** Flow speed / contrast of the shader per state (0 = still, 1 = lively). */
export const ORB_ENERGY: Record<AgentRunState, number> = {
    "idle": 0.35,
    "running": 1.0,
    "awaiting-input": 0.55,
    "completed": 0.45,
    "error": 0.5,
};

/** User-facing label for a non-idle run state, shared by the orb and the hero box. */
export function activeStateLabel(status: AgentRunStatus): string {
    switch (status.state) {
        case "completed":
            return "Done — click to open Copilot";
        case "running":
            return status.label ?? "Working on it…";
        case "awaiting-input":
            return status.label ?? "Copilot needs your input";
        case "error":
            return status.label ?? "Copilot hit an error";
        default:
            return "Ask WSO2 Copilot";
    }
}

/** CSS gradient sphere — fallback when a WebGL context can't be created. */
export const Sphere = styled.div<{ colors: [string, string, string] }>`
    position: absolute;
    inset: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(
        circle at 32% 28%,
        rgba(255, 255, 255, 0.55),
        ${(props: { colors: [string, string, string] }) => props.colors[0]} 45%,
        ${(props: { colors: [string, string, string] }) => props.colors[1]} 100%
    );
    box-shadow: inset 0 -5px 10px rgba(0, 0, 0, 0.18);
`;

/** Glass reflection overlay — sits on top of both the shader and CSS spheres. */
export const Gloss = styled.div`
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.04) 30%, transparent 50%);
    pointer-events: none;
`;

// ---------------------------------------------------------------------------
// Agent-run-status fan-out.
//
// vscode-messenger keeps ONE handler per notification method
// (handlerRegistry.set), so a second onAgentRunStatusChanged subscriber would
// silently replace the first. This store owns the single messenger
// subscription (plus the initial pull) and fans updates out to any number of
// components (floating orb, landing-page hero box, ...).
// ---------------------------------------------------------------------------

let currentStatus: AgentRunStatus | null = null;
let statusWired = false;
const statusListeners = new Set<(status: AgentRunStatus | null) => void>();

function publishStatus(status: AgentRunStatus | null) {
    currentStatus = status;
    statusListeners.forEach((listener) => listener(status));
}

export function subscribeAgentRunStatus(
    rpcClient: BallerinaRpcClient,
    listener: (status: AgentRunStatus | null) => void
): () => void {
    statusListeners.add(listener);
    if (statusWired) {
        listener(currentStatus);
    } else {
        statusWired = true;
        rpcClient
            .getCommonRpcClient()
            .getAgentRunStatus()
            .then(publishStatus)
            .catch(() => {
                // Older extension host without the RPC — status stays null.
            });
        rpcClient.onAgentRunStatusChanged(publishStatus);
    }
    return () => {
        statusListeners.delete(listener);
    };
}

// ---------------------------------------------------------------------------
// Hero-box presence.
//
// While a landing-page hero box is on screen it IS the copilot surface for
// that view, so the floating orb hides itself to avoid showing two orbs.
// ---------------------------------------------------------------------------

let heroCount = 0;
const heroListeners = new Set<(present: boolean) => void>();

function notifyHeroPresence() {
    heroListeners.forEach((listener) => listener(heroCount > 0));
}

/** Called by a hero box on mount; returns the matching unmount cleanup. */
export function registerHeroPresence(): () => void {
    heroCount++;
    notifyHeroPresence();
    return () => {
        heroCount--;
        notifyHeroPresence();
    };
}

export function subscribeHeroPresence(listener: (present: boolean) => void): () => void {
    heroListeners.add(listener);
    listener(heroCount > 0);
    return () => {
        heroListeners.delete(listener);
    };
}
