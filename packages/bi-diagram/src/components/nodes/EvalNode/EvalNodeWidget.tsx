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
/** @jsxImportSource @emotion/react */
import React from "react";
import { css } from "@emotion/react";
import styled from "@emotion/styled";
import { DiagramEngine, PortWidget } from "@projectstorm/react-diagrams-core";
import {
    Button, DefaultLlmIcon, Icon, Item, Menu, MenuItem, Popover, ThemeColors, getAIModuleIcon,
} from "@wso2/ui-toolkit";
import { EvalNodeModel } from "./EvalNodeModel";
import {
    LABEL_HEIGHT, LABEL_WIDTH, NODE_BORDER_WIDTH, NODE_GAP_X, NODE_HEIGHT, NODE_PADDING, NODE_WIDTH,
} from "../../../resources/constants";
import { MoreVertIcon } from "../../../resources/icons";
import { FlowNode } from "../../../utils/types";
import { DiagnosticsPopUp } from "../../DiagnosticsPopUp";
import { nodeHasError } from "../../../utils/node";
import { BreakpointMenu } from "../../BreakNodeMenu/BreakNodeMenu";
import { ThemeListener } from "../../NodeIcon";
import { useAgentNodeController } from "../AgentWidget/useAgentNodeController";
import {
    AGENT_CARD_CONTENT_HEIGHT, AGENT_CARD_HEIGHT, AGENT_CARD_MARGIN_BOTTOM, AGENT_CARD_PADDING,
    DESCRIPTION_HEIGHT,
    DESCRIPTION_LINES, DESCRIPTION_LINE_HEIGHT, DESCRIPTION_MARGIN_Y, ICON_BOX_SIZE,
    HEADER_MARGIN_TOP, HEADER_PADDING_Y, SUBTITLE_LINE_HEIGHT,
    SUBTITLE_MARGIN_TOP, TITLE_HEIGHT, TITLE_SUBTITLE_GAP, getEvalPresentation,
} from "./evalNodePresentation";

const Node = styled.div<{ readOnly: boolean }>`
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    cursor: ${(props: { readOnly: boolean }) => (props.readOnly ? "default" : "pointer")};
`;

type BoxProps = { hovered: boolean; hasError: boolean; isActiveBreakpoint: boolean; isSelected: boolean };

const Box = styled.div<BoxProps>`
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: ${NODE_WIDTH}px;
    min-height: ${NODE_HEIGHT}px;
    padding: 0 ${NODE_PADDING}px;
    border: ${NODE_BORDER_WIDTH}px solid
        ${(props: BoxProps) =>
        props.hasError
            ? ThemeColors.ERROR
            : props.isSelected || props.hovered
                ? ThemeColors.SECONDARY
                : ThemeColors.OUTLINE_VARIANT};
    border-radius: 10px;
    background-color: ${(props: BoxProps) =>
        props.isActiveBreakpoint ? ThemeColors.DEBUGGER_BREAKPOINT_BACKGROUND : ThemeColors.SURFACE_DIM};
    color: ${ThemeColors.ON_SURFACE};
    transition: border-color 0.4s ease-out;
`;

const Column = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    height: 100%;
    overflow: hidden;
`;

const HeaderRow = styled.div`
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    z-index: 2;
`;

const IconBox = styled.div`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 4px;
`;

const Header = styled.div`
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: ${TITLE_SUBTITLE_GAP}px;
    flex: 1;
    min-width: 0;
    padding: ${HEADER_PADDING_Y}px;
    margin-top: ${HEADER_MARGIN_TOP}px;
`;

const Title = styled.div`
    font-size: 14px;
    height: ${TITLE_HEIGHT}px;
    font-family: "GilmerMedium";
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const Subtitle = styled.div`
    width: 100%;
    font-size: 12px;
    line-height: ${SUBTITLE_LINE_HEIGHT}px;
    margin-top: ${SUBTITLE_MARGIN_TOP}px;
    font-family: "GilmerRegular";
    color: ${ThemeColors.ON_SURFACE};
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const HeaderActions = styled.div`
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
`;

const Divider = styled.div`
    width: 100%;
    border-top: 1px dashed ${ThemeColors.OUTLINE_VARIANT};
`;

const Description = styled.div`
    width: 100%;
    margin: ${DESCRIPTION_MARGIN_Y}px 0;
    padding: 0 4px;
    height: ${DESCRIPTION_HEIGHT}px;
    font-size: 12px;
    line-height: ${DESCRIPTION_LINE_HEIGHT}px;
    font-family: "GilmerRegular";
    color: ${ThemeColors.ON_SURFACE};
    opacity: 0.7;
    display: -webkit-box;
    -webkit-line-clamp: ${DESCRIPTION_LINES};
    -webkit-box-orient: vertical;
    overflow: hidden;
    z-index: 2;
`;

const AgentCard = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: ${AGENT_CARD_HEIGHT}px;
    box-sizing: border-box;
    margin: 0 0 ${AGENT_CARD_MARGIN_BOTTOM}px;
    padding: ${AGENT_CARD_PADDING}px;
    border: 1px dashed ${ThemeColors.OUTLINE_VARIANT};
    border-radius: 4px;
    z-index: 2;
`;

const AgentName = styled.div`
    flex: 1;
    min-width: 0;
    font-family: monospace;
    font-size: 12px;
    line-height: ${AGENT_CARD_CONTENT_HEIGHT}px;
    opacity: 0.78;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const MenuButton = styled(Button)`
    border-radius: 5px;
`;

const TopPortWidget = styled(PortWidget)`
    margin-top: -3px;
    z-index: 2;
`;

const BottomPortWidget = styled(PortWidget)`
    margin-bottom: -2px;
    z-index: 2;
`;

interface EvalNodeWidgetProps {
    model: EvalNodeModel;
    engine: DiagramEngine;
    onClick?: (node: FlowNode) => void;
}

export function EvalNodeWidget(props: EvalNodeWidgetProps) {
    const { model, engine, onClick } = props;
    const controller = useAgentNodeController(model);
    const { onNodeSelect, goToSource, onDeleteNode, addBreakpoint, removeBreakpoint, readOnly, aiNodes } =
        controller.context;
    const {
        isSelected, isBoxHovered, setIsBoxHovered, anchorEl, setAnchorEl, menuButtonElement, setMenuButtonElement,
        isMenuOpen, hasBreakpoint, isActiveBreakpoint, handleThemeChange, aiColor,
    } = controller;

    const node = model.node;
    const presentation = getEvalPresentation(node);
    const hasError = nodeHasError(node);

    const onNodeClick = () => {
        onClick?.(node);
        onNodeSelect?.(node);
        setAnchorEl(null);
    };

    const handleOnClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (readOnly) {
            return;
        }
        if (event.metaKey) {
            onGoToSource();
        } else {
            onNodeClick();
        }
    };

    const onGoToSource = () => {
        goToSource?.(node);
        setAnchorEl(null);
    };

    const handleOnMenuClick = (event: React.MouseEvent<HTMLElement | SVGSVGElement>) => {
        if (readOnly) {
            return;
        }
        event.stopPropagation();
        setAnchorEl(event.currentTarget);
    };

    const onModelEditClick = (event: React.MouseEvent<SVGElement>) => {
        event.stopPropagation();
        if (!readOnly) {
            aiNodes?.onModelSelect?.(node);
        }
    };

    const menuItems: Item[] = [
        { id: "edit", label: "Edit", onClick: () => onNodeClick() },
        { id: "goToSource", label: "Source", onClick: () => onGoToSource() },
        { id: "delete", label: "Delete", onClick: () => { onDeleteNode?.(node); setAnchorEl(null); } },
    ];

    return (
        <Node data-testid="eval-node" readOnly={readOnly}>
            <Box
                hovered={isBoxHovered}
                hasError={hasError}
                isActiveBreakpoint={isActiveBreakpoint}
                isSelected={isSelected}
                onMouseEnter={() => setIsBoxHovered(true)}
                onMouseLeave={() => setIsBoxHovered(false)}
                onClick={!readOnly ? handleOnClick : undefined}
                onContextMenu={
                    !readOnly
                        ? (event: React.MouseEvent<HTMLDivElement>) => {
                            event.preventDefault();
                            setAnchorEl(menuButtonElement || event.currentTarget);
                        }
                        : undefined
                }
                title="Configure Evaluation"
            >
                {hasBreakpoint && (
                    <div
                        data-testid={
                            isActiveBreakpoint ? "breakpoint-indicator-diagram-active" : "breakpoint-indicator-diagram"
                        }
                        style={{
                            position: "absolute",
                            left: -5,
                            width: 15,
                            height: 15,
                            borderRadius: "50%",
                            backgroundColor: "red",
                            zIndex: 2,
                        }}
                    />
                )}
                <TopPortWidget port={model.getPort("in")!} engine={engine} />
                <Column style={{ height: `${node.viewState?.ch}px` }}>
                    <HeaderRow>
                        <IconBox>
                            <Icon
                                name={presentation.icon.name}
                                isCodicon
                                iconSx={{ fontSize: `${presentation.icon.size}px` }}
                                sx={{
                                    width: ICON_BOX_SIZE,
                                    height: ICON_BOX_SIZE,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    color: ThemeColors.PRIMARY,
                                }}
                            />
                        </IconBox>
                        <Header>
                            <Title>AI Evaluation</Title>
                            <Subtitle title={presentation.subtitle}>{presentation.subtitle}</Subtitle>
                        </Header>
                        <HeaderActions>
                            {hasError && <DiagnosticsPopUp node={node} />}
                            <MenuButton
                                ref={setMenuButtonElement}
                                buttonSx={readOnly ? { cursor: "not-allowed" } : {}}
                                appearance="icon"
                                onClick={handleOnMenuClick}
                            >
                                <MoreVertIcon />
                            </MenuButton>
                        </HeaderActions>
                    </HeaderRow>
                    <Popover
                        open={isMenuOpen}
                        anchorEl={anchorEl}
                        handleClose={() => { setAnchorEl(null); setIsBoxHovered(false); }}
                        sx={{ padding: 0, borderRadius: 0 }}
                    >
                        <Menu>
                            <>
                                {menuItems.map((item) => (
                                    <MenuItem key={item.id} item={item} />
                                ))}
                                <BreakpointMenu
                                    hasBreakpoint={hasBreakpoint}
                                    onAddBreakpoint={() => { addBreakpoint?.(node); setAnchorEl(null); }}
                                    onRemoveBreakpoint={() => { removeBreakpoint?.(node); setAnchorEl(null); }}
                                />
                            </>
                        </Menu>
                    </Popover>

                    {presentation.description && (
                        <>
                            <Divider />
                            <Description title={presentation.description}>{presentation.description}</Description>
                        </>
                    )}

                    {presentation.agentName && (
                        <AgentCard>
                            <Icon
                                name="bi-ai-agent"
                                iconSx={{ fontSize: "16px" }}
                                sx={{ width: 16, height: 16, color: aiColor }}
                            />
                            <AgentName title={presentation.agentName}>{presentation.agentName}</AgentName>
                        </AgentCard>
                    )}
                </Column>
                <BottomPortWidget port={model.getPort("out")!} engine={engine} />
            </Box>

            {presentation.judgeModel && (
                <svg
                    width={NODE_GAP_X + NODE_HEIGHT + LABEL_HEIGHT + LABEL_WIDTH + 10}
                    height={node.viewState?.ch}
                    viewBox={`0 0 300 ${node.viewState?.ch}`}
                    style={{ marginLeft: "-10px", position: "relative", zIndex: 1 }}
                >
                    <g onClick={onModelEditClick} css={css`cursor: ${readOnly ? "default" : "pointer"};`}>
                        <circle
                            cx="80"
                            cy="24"
                            r="22"
                            fill={ThemeColors.SURFACE_DIM}
                            stroke={ThemeColors.OUTLINE_VARIANT}
                            strokeWidth={1.5}
                            css={css`
                                transition: stroke 0.4s ease-out;
                                &:hover {
                                    stroke: ${readOnly ? ThemeColors.OUTLINE_VARIANT : ThemeColors.SECONDARY};
                                }
                            `}
                        >
                            <title>Configure Judge Model</title>
                        </circle>
                        <foreignObject x="68" y="12" width="44" height="44" style={{ pointerEvents: "none" }}>
                            {presentation.judgeModel.isDefault ? (
                                <Icon name="bi-wso2" sx={{ fontSize: 24, width: 24, height: 24 }} />
                            ) : (
                                getAIModuleIcon(presentation.judgeModel.type)
                                ?? (presentation.judgeModel.iconUrl
                                    ? <img src={presentation.judgeModel.iconUrl} style={{ width: 24, height: 24 }} />
                                    : <DefaultLlmIcon />)
                            )}
                        </foreignObject>
                        <line
                            x1="0"
                            y1="25"
                            x2="57"
                            y2="25"
                            style={{
                                stroke: ThemeColors.ON_SURFACE,
                                strokeWidth: 1.5,
                                markerEnd: `url(#${node.id}-eval-arrow-head)`,
                                markerStart: `url(#${node.id}-eval-diamond-start)`,
                            }}
                        />
                    </g>
                    <defs>
                        <marker
                            id={`${node.id}-eval-arrow-head`}
                            markerWidth="4"
                            markerHeight="4"
                            refX="3"
                            refY="2"
                            viewBox="0 0 4 4"
                            orient="auto"
                        >
                            <polygon points="0,4 0,0 4,2" fill={ThemeColors.ON_SURFACE} />
                        </marker>
                        <marker
                            id={`${node.id}-eval-diamond-start`}
                            markerWidth="8"
                            markerHeight="8"
                            refX="4.5"
                            refY="4"
                            viewBox="0 0 8 8"
                            orient="auto"
                        >
                            <circle
                                cx="4"
                                cy="4"
                                r="3"
                                fill={ThemeColors.SURFACE_DIM}
                                stroke={ThemeColors.ON_SURFACE}
                                strokeWidth="1"
                            />
                        </marker>
                    </defs>
                </svg>
            )}
            <ThemeListener onThemeChange={handleThemeChange} />
        </Node>
    );
}
