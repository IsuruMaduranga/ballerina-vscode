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

import React, { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { css, keyframes } from "@emotion/react";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { AgentRunStatus, AgentRunState, SHARED_COMMANDS } from "@wso2/ballerina-core";
import { Icon } from "@wso2/ui-toolkit";
import { ShaderOrb } from "./ShaderOrb";

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

const ORB_SIZE = 56;
const EDGE_MARGIN = 20;
const DRAG_THRESHOLD = 5;
const SNAP_ANIMATION_MS = 250;
const ANCHOR_STORAGE_KEY = "ballerina.copilot.orbAnchor";

type Anchor = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

const ANCHOR_CSS: Record<Anchor, React.CSSProperties> = {
    "top-left": { top: EDGE_MARGIN, left: EDGE_MARGIN },
    "top-center": { top: EDGE_MARGIN, left: "50%", transform: "translateX(-50%)" },
    "top-right": { top: EDGE_MARGIN, right: EDGE_MARGIN },
    "bottom-left": { bottom: EDGE_MARGIN, left: EDGE_MARGIN },
    "bottom-center": { bottom: EDGE_MARGIN, left: "50%", transform: "translateX(-50%)" },
    "bottom-right": { bottom: EDGE_MARGIN, right: EDGE_MARGIN },
};

function loadAnchor(): Anchor {
    const stored = localStorage.getItem(ANCHOR_STORAGE_KEY);
    // Default to bottom-center so the copilot invitation is front and center
    // when BI opens; users can drag it to any of the six anchors.
    return stored && stored in ANCHOR_CSS ? (stored as Anchor) : "bottom-center";
}

/** Top-left px position of the orb when docked at an anchor. */
function anchorPosition(anchor: Anchor): { x: number; y: number } {
    const x = anchor.endsWith("left")
        ? EDGE_MARGIN
        : anchor.endsWith("center")
            ? (window.innerWidth - ORB_SIZE) / 2
            : window.innerWidth - ORB_SIZE - EDGE_MARGIN;
    const y = anchor.startsWith("top") ? EDGE_MARGIN : window.innerHeight - ORB_SIZE - EDGE_MARGIN;
    return { x, y };
}

/** Nearest of the six anchors: horizontal thirds × vertical halves. */
function nearestAnchor(x: number, y: number): Anchor {
    const vertical = y < window.innerHeight / 2 ? "top" : "bottom";
    const horizontal =
        x < window.innerWidth / 3 ? "left" : x > (window.innerWidth * 2) / 3 ? "right" : "center";
    return `${vertical}-${horizontal}` as Anchor;
}

/** Flow speed / contrast of the shader per state (0 = still, 1 = lively). */
const ORB_ENERGY: Record<AgentRunState, number> = {
    "idle": 0.35,
    "running": 1.0,
    "awaiting-input": 0.55,
    "completed": 0.45,
    "error": 0.5,
};

const ORB_COLORS: Record<AgentRunState, [string, string, string]> = {
    "idle": ["#4f5fe8", "#a55cff", "#38d4ff"],
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

const hueCycle = keyframes`
    from { filter: blur(8px) hue-rotate(0deg); }
    to { filter: blur(8px) hue-rotate(360deg); }
`;

const haloPulse = keyframes`
    0%, 100% { opacity: 0.25; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.18); }
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

const InviteBox = styled.div`
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    border-radius: 14px;
    padding: 5px 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    animation: ${fadeIn} 0.25s ease-out;
`;

const InviteInput = styled.input`
    width: 230px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 9px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    outline: none;
    &:focus {
        border-color: var(--vscode-focusBorder);
    }
    &::placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
`;

const InviteDismiss = styled.button`
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 4px 5px;
    border-radius: 4px;
    &:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-toolbar-hoverBackground);
    }
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
    opacity: ${(props: Pick<OrbStyleProps, "state">) => (props.state === "idle" ? 0.85 : 1)};
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
    @media (prefers-reduced-motion: reduce) {
        animation: none;
    }
`;

const Halo = styled.div<{ colors: [string, string, string] }>`
    position: absolute;
    inset: -16px;
    border-radius: 50%;
    background: radial-gradient(
        circle,
        ${(props: Pick<OrbStyleProps, "colors">) => props.colors[1]} 0%,
        transparent 70%
    );
    animation: ${haloPulse} 1.8s ease-in-out infinite;
    pointer-events: none;
    @media (prefers-reduced-motion: reduce) {
        animation: none;
        opacity: 0.4;
    }
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
    opacity: ${(props: Pick<OrbStyleProps, "state">) => (props.state === "idle" ? 0.3 : props.state === "running" ? 1 : 0.85)};
    ${(props: Pick<OrbStyleProps, "state">) =>
        props.state === "running"
            ? css`animation: ${rotate} 2.8s linear infinite, ${hueCycle} 5s linear infinite;`
            : props.state === "idle"
                ? css`animation: ${rotate} 14s linear infinite;`
                : css`animation: ${rotate} 9s linear infinite;`}
    @media (prefers-reduced-motion: reduce) {
        animation: none;
    }
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

/** Glass reflection overlay — sits on top of both the shader and CSS spheres. */
const Gloss = styled.div`
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.04) 30%, transparent 50%);
    pointer-events: none;
`;

const IconOverlay = styled.div`
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
`;

export function AgentStatusOrb() {
    const { rpcClient } = useRpcContext();
    const [status, setStatus] = useState<AgentRunStatus | null>(null);
    const [hovered, setHovered] = useState(false);
    const [anchor, setAnchor] = useState<Anchor>(loadAnchor);
    /** Orb top-left in px while dragging/snapping; null when docked at an anchor. */
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
    const [snapping, setSnapping] = useState(false);
    const dragStateRef = useRef<{ startX: number; startY: number; wasDrag: boolean } | null>(null);
    const snapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [inviteText, setInviteText] = useState("");
    const [inviteDismissed, setInviteDismissed] = useState(false);
    /** WebGL unavailable — render the CSS gradient sphere instead. */
    const [webglFailed, setWebglFailed] = useState(false);
    const handleWebglFailed = useCallback(() => setWebglFailed(true), []);

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
        state === "completed"
            ? "Done — click to open Copilot"
            : state === "running"
                ? status.label ?? "Working on it…"
                : state === "awaiting-input"
                    ? status.label ?? "Copilot needs your input"
                    : state === "error"
                        ? status.label ?? "Copilot hit an error"
                        : "Ask WSO2 Copilot";
    const dragging = dragPos !== null && !snapping;
    // Active states keep the pill visible the whole time. Idle shows the
    // invitation input; dismissing only collapses it into the orb — hovering
    // the orb expands it again, so it is never more than one hover away.
    const showInvite = state === "idle" && !dragging && (!inviteDismissed || hovered);
    const showLabel = !dragging && !showInvite && state !== "idle";

    const openCopilot = () => {
        rpcClient?.getCommonRpcClient().executeCommand({ commands: [SHARED_COMMANDS.OPEN_AI_PANEL] });
    };

    const submitInvite = () => {
        const text = inviteText.trim();
        if (!text) {
            openCopilot();
            return;
        }
        rpcClient?.getCommonRpcClient().executeCommand({
            commands: [SHARED_COMMANDS.OPEN_AI_PANEL, { type: "text", text, planMode: false, autoSubmit: true }],
        });
        setInviteText("");
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
        const target = nearestAnchor(event.clientX, event.clientY);
        // Animate to the anchor's px position, then hand over to anchor
        // positioning (offsets/percentages) so window resizes keep it pinned.
        setSnapping(true);
        setDragPos(anchorPosition(target));
        snapTimerRef.current = setTimeout(() => {
            setAnchor(target);
            localStorage.setItem(ANCHOR_STORAGE_KEY, target);
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

    // Keep the label pill on-screen and horizontally centered orbs balanced:
    // left edge → pill to the right; centers → pill stacked toward the middle.
    const flexDirection: "row" | "row-reverse" | "column" | "column-reverse" =
        dragPos !== null
            ? "row"
            : anchor.endsWith("left")
                ? "row-reverse"
                : anchor === "bottom-center"
                    ? "column"
                    : anchor === "top-center"
                        ? "column-reverse"
                        : "row";
    const wrapperStyle: React.CSSProperties = dragPos
        ? {
            left: dragPos.x,
            top: dragPos.y,
            transition: snapping ? `left ${SNAP_ANIMATION_MS}ms ease, top ${SNAP_ANIMATION_MS}ms ease` : "none",
        }
        : ANCHOR_CSS[anchor];

    return (
        <Wrapper
            style={{ ...wrapperStyle, flexDirection }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {showInvite && (
                <InviteBox>
                    <InviteInput
                        value={inviteText}
                        onChange={(event) => setInviteText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                submitInvite();
                            }
                        }}
                        placeholder="What do you want to build?"
                        aria-label="Ask WSO2 Copilot: what do you want to build?"
                    />
                    <InviteDismiss title="Hide" aria-label="Hide the copilot prompt" onClick={() => setInviteDismissed(true)}>
                        ✕
                    </InviteDismiss>
                </InviteBox>
            )}
            {showLabel && label && <LabelPill onClick={openCopilot}>{label}</LabelPill>}
            <OrbButton
                state={state}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                title={label ? `WSO2 Integrator Copilot — ${label}` : "WSO2 Integrator Copilot"}
                aria-label={label ? `WSO2 Copilot: ${label}. Open the Copilot chat.` : "Open the WSO2 Copilot chat"}
            >
                {(state === "running" || state === "awaiting-input") && <Halo colors={colors} />}
                <Aura colors={colors} state={state} />
                {webglFailed ? (
                    <Sphere colors={colors} />
                ) : (
                    <ShaderOrb
                        colors={colors}
                        energy={ORB_ENERGY[state]}
                        size={ORB_SIZE}
                        onContextFailed={handleWebglFailed}
                    />
                )}
                {webglFailed && <Gloss />}
                <IconOverlay>
                    <Icon
                        name="bi-ai-chat"
                        sx={{ width: 26, height: 26 }}
                        iconSx={{ fontSize: "26px", color: "#ffffff", cursor: "inherit" }}
                    />
                </IconOverlay>
            </OrbButton>
        </Wrapper>
    );
}
