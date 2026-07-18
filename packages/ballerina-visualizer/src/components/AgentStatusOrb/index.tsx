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

import React, { useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { keyframes } from "@emotion/react";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { AgentRunStatus, AgentRunState, SHARED_COMMANDS } from "@wso2/ballerina-core";
import { Icon } from "@wso2/ui-toolkit";

/**
 * Floating ambient indicator for the Copilot agent's background run.
 *
 * Rendered as an overlay in the visualizer webview and always visible while
 * the AI panel is closed — a subdued idle presence, and animated color-coded
 * states while the agent works in the background. Hidden while the AI panel
 * is open (the panel itself shows richer progress). Clicking it opens the
 * Copilot chat. Draggable: released anywhere, it snaps to the nearest corner
 * and the corner is remembered across reloads.
 */

const ORB_SIZE = 48;
const EDGE_MARGIN = 20;
const DRAG_THRESHOLD = 5;
const SNAP_ANIMATION_MS = 250;
const CORNER_STORAGE_KEY = "ballerina.copilot.orbCorner";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER_CSS: Record<Corner, React.CSSProperties> = {
    "top-left": { top: EDGE_MARGIN, left: EDGE_MARGIN },
    "top-right": { top: EDGE_MARGIN, right: EDGE_MARGIN },
    "bottom-left": { bottom: EDGE_MARGIN, left: EDGE_MARGIN },
    "bottom-right": { bottom: EDGE_MARGIN, right: EDGE_MARGIN },
};

function loadCorner(): Corner {
    const stored = localStorage.getItem(CORNER_STORAGE_KEY);
    return stored && stored in CORNER_CSS ? (stored as Corner) : "bottom-right";
}

/** Top-left px position of the orb when anchored at a corner. */
function cornerPosition(corner: Corner): { x: number; y: number } {
    return {
        x: corner.endsWith("left") ? EDGE_MARGIN : window.innerWidth - ORB_SIZE - EDGE_MARGIN,
        y: corner.startsWith("top") ? EDGE_MARGIN : window.innerHeight - ORB_SIZE - EDGE_MARGIN,
    };
}

function nearestCorner(x: number, y: number): Corner {
    const vertical = y < window.innerHeight / 2 ? "top" : "bottom";
    const horizontal = x < window.innerWidth / 2 ? "left" : "right";
    return `${vertical}-${horizontal}` as Corner;
}

const ORB_COLORS: Record<AgentRunState, [string, string, string]> = {
    "idle": ["#7c8ce0", "#8a7bd9", "#6aa4d9"],
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
    state: AgentRunState;
    colors: [string, string, string];
}

const OrbButton = styled.button<{ state: AgentRunState }>`
    pointer-events: auto;
    position: relative;
    width: ${ORB_SIZE}px;
    height: ${ORB_SIZE}px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: grab;
    outline-offset: 4px;
    touch-action: none;
    opacity: ${(props: Pick<OrbStyleProps, "state">) => (props.state === "idle" ? 0.65 : 1)};
    transition: opacity 0.3s ease, transform 0.2s ease;
    &:hover {
        opacity: 1;
        transform: scale(1.06);
    }
    &:active {
        cursor: grabbing;
    }
    animation: ${(props: Pick<OrbStyleProps, "state">) =>
        props.state === "awaiting-input" ? breathe : props.state === "completed" ? bloom : "none"}
        ${(props: Pick<OrbStyleProps, "state">) =>
        props.state === "awaiting-input" ? "1.6s ease-in-out infinite" : props.state === "completed" ? "0.6s ease-out" : ""};
`;

const Aura = styled.div<{ colors: [string, string, string]; state: AgentRunState }>`
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    background: conic-gradient(
        from 0deg,
        ${(props: Pick<OrbStyleProps, "colors">) => `${props.colors[0]}, ${props.colors[1]}, ${props.colors[2]}, ${props.colors[0]}`}
    );
    filter: blur(8px);
    opacity: ${(props: Pick<OrbStyleProps, "state">) => (props.state === "idle" ? 0.45 : 0.85)};
    animation: ${rotate}
        ${(props: Pick<OrbStyleProps, "state">) => (props.state === "running" ? "2.8s" : props.state === "idle" ? "14s" : "9s")}
        linear infinite;
`;

const Sphere = styled.div<{ colors: [string, string, string] }>`
    position: absolute;
    inset: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(
        circle at 32% 28%,
        rgba(255, 255, 255, 0.55),
        ${(props: Pick<OrbStyleProps, "colors">) => props.colors[0]} 45%,
        ${(props: Pick<OrbStyleProps, "colors">) => props.colors[1]} 100%
    );
    box-shadow: inset 0 -5px 10px rgba(0, 0, 0, 0.18);
`;

export function AgentStatusOrb() {
    const { rpcClient } = useRpcContext();
    const [status, setStatus] = useState<AgentRunStatus | null>(null);
    const [hovered, setHovered] = useState(false);
    const [corner, setCorner] = useState<Corner>(loadCorner);
    /** Orb top-left in px while dragging/snapping; null when anchored to a corner. */
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
    const [snapping, setSnapping] = useState(false);
    const dragStateRef = useRef<{ startX: number; startY: number; wasDrag: boolean } | null>(null);
    const snapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

    useEffect(() => () => clearTimeout(snapTimerRef.current), []);

    if (!status || status.aiPanelOpen) {
        return null;
    }

    const state = status.state;
    const colors = ORB_COLORS[state];
    const label =
        status.label ??
        (state === "running"
            ? "Copilot is working"
            : state === "awaiting-input"
                ? "Copilot needs your input"
                : "Ask BI Copilot");
    const dragging = dragPos !== null && !snapping;
    const showLabel = !dragging && (hovered || state === "awaiting-input" || state === "error");

    const openCopilot = () => {
        rpcClient?.getCommonRpcClient().executeCommand({ commands: [SHARED_COMMANDS.OPEN_AI_PANEL] });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStateRef.current = { startX: event.clientX, startY: event.clientY, wasDrag: false };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag) {
            return;
        }
        if (!drag.wasDrag) {
            const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (moved < DRAG_THRESHOLD) {
                return;
            }
            drag.wasDrag = true;
            clearTimeout(snapTimerRef.current);
            setSnapping(false);
        }
        setDragPos({ x: event.clientX - ORB_SIZE / 2, y: event.clientY - ORB_SIZE / 2 });
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        dragStateRef.current = null;
        if (!drag?.wasDrag) {
            return;
        }
        const target = nearestCorner(event.clientX, event.clientY);
        // Animate to the corner's px position, then hand over to corner
        // anchoring (right/bottom offsets) so window resizes keep it pinned.
        setSnapping(true);
        setDragPos(cornerPosition(target));
        snapTimerRef.current = setTimeout(() => {
            setCorner(target);
            localStorage.setItem(CORNER_STORAGE_KEY, target);
            setDragPos(null);
            setSnapping(false);
        }, SNAP_ANIMATION_MS);
    };

    const handleClick = () => {
        // Suppress the click that follows a drag; dragStateRef is already
        // cleared on pointerup, so only a stale wasDrag matters here.
        if (dragPos === null) {
            openCopilot();
        }
    };

    const onLeftEdge = dragPos === null && corner.endsWith("left");
    const wrapperStyle: React.CSSProperties = dragPos
        ? {
            left: dragPos.x,
            top: dragPos.y,
            transition: snapping ? `left ${SNAP_ANIMATION_MS}ms ease, top ${SNAP_ANIMATION_MS}ms ease` : "none",
        }
        : CORNER_CSS[corner];

    return (
        <Wrapper
            style={{ ...wrapperStyle, flexDirection: onLeftEdge ? "row-reverse" : "row" }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {showLabel && label && <LabelPill onClick={openCopilot}>{label}</LabelPill>}
            <OrbButton
                state={state}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                title={label ? `BI Copilot — ${label}` : "BI Copilot"}
                aria-label={label ? `BI Copilot: ${label}. Open the Copilot chat.` : "Open the BI Copilot chat"}
            >
                <Aura colors={colors} state={state} />
                <Sphere colors={colors}>
                    <Icon
                        name="bi-ai-chat"
                        sx={{ width: 22, height: 22 }}
                        iconSx={{ fontSize: "22px", color: "#ffffff", cursor: "inherit" }}
                    />
                </Sphere>
            </OrbButton>
        </Wrapper>
    );
}
