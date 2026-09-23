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

import React, { useState, useEffect } from "react";
import styled from "@emotion/styled";
import { FooterContainer } from "./index";
import { ActionButton } from "../../AgentStreamView/styles";
import { FooterBox, FooterBoxPrompt, FooterDivider, FooterHeaderRow, FooterTextInputRow, FooterInput, FooterIconBtn } from "./styles";
import { AmbientFrame } from "../../../../../components/AgentStatusOrb/shared";
import StopControl from "./StopControl";
import { useEscapeToStop } from "./useEscapeToStop";

// ── Web tool styles (footer-specific, not shared) ─────────────────────────────

const WebToolHeader = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
`;

const WebToolContent = styled.div`
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
    word-break: break-all;
`;

const WebToolActions = styled.div`
    display: flex;
    gap: 8px;
`;

// ── Types ──────────────────────────────────────────────────────────────────────

type PlanCompletionProps = {
    type: "plan" | "completion";
    onApprove: (enableAutoApprove: boolean) => void;
    onReject: (comment: string) => void;
    onStop: () => void;
    isSubmitting?: boolean;
};

type WebToolProps = {
    type: "web_tool";
    toolName: "web_search" | "web_fetch";
    content: string;
    onAllow: () => void;
    onDeny: () => void;
    onStop: () => void;
};

type ShellCommandProps = {
    type: "shell_command";
    command: string;
    description?: string;
    reasons: string[];
    /** The "allow for this session" option's label; the option is hidden without one. */
    sessionRuleLabel?: string;
    onAllow: () => void;
    onAllowSession: () => void;
    onDeny: () => void;
    onStop: () => void;
};

const ShellCommandText = styled.pre`
    margin: 0;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 160px;
    overflow-y: auto;
`;

const ShellReasons = styled.ul`
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
`;

type SkillEnableProps = {
    type: "skill_enable";
    skillName: string;
    onEnable: () => void;
    onSkip: () => void;
    onStop: () => void;
};

type CommonApprovalFooterProps = PlanCompletionProps | WebToolProps | ShellCommandProps | SkillEnableProps;

// ── Component ─────────────────────────────────────────────────────────────────

const CommonApprovalFooter: React.FC<CommonApprovalFooterProps> = (props) => {
    const [comment, setComment] = useState("");
    const { onStop } = props;

    useEffect(() => {
        setComment("");
    }, [props.type]);

    useEscapeToStop(onStop);

    if (props.type === "web_tool") {
        const { toolName, content, onAllow, onDeny } = props;
        const label = toolName === "web_search" ? "Web Search" : "Web Fetch";
        return (
            <FooterContainer>
                <AmbientFrame $variant="composer" $state="awaiting-input">
                    <FooterBox>
                        <FooterHeaderRow>
                            <WebToolHeader>
                                <span className="codicon codicon-globe" />
                                {label}
                            </WebToolHeader>
                            <StopControl onStop={onStop} />
                        </FooterHeaderRow>
                        <WebToolContent>{content}</WebToolContent>
                        <FooterDivider />
                        <WebToolActions>
                            <ActionButton onClick={onAllow}>Allow</ActionButton>
                            <ActionButton variant="secondary" onClick={onDeny}>Deny</ActionButton>
                        </WebToolActions>
                    </FooterBox>
                </AmbientFrame>
            </FooterContainer>
        );
    }

    if (props.type === "shell_command") {
        const { command, description, reasons, sessionRuleLabel, onAllow, onAllowSession, onDeny } = props;
        return (
            <FooterContainer>
                <AmbientFrame $variant="composer" $state="awaiting-input">
                    <FooterBox>
                        <FooterHeaderRow>
                            <WebToolHeader>
                                <span className="codicon codicon-terminal" />
                                {description ? `Run a command: ${description}` : "Run a command?"}
                            </WebToolHeader>
                            <StopControl onStop={onStop} />
                        </FooterHeaderRow>
                        <ShellCommandText>{command}</ShellCommandText>
                        {reasons.length > 0 && (
                            <ShellReasons>
                                {reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
                            </ShellReasons>
                        )}
                        <FooterDivider />
                        <WebToolActions>
                            <ActionButton onClick={onAllow}>Allow</ActionButton>
                            {sessionRuleLabel && (
                                <ActionButton variant="secondary" onClick={onAllowSession}>{sessionRuleLabel}</ActionButton>
                            )}
                            <ActionButton variant="secondary" onClick={onDeny}>Deny</ActionButton>
                        </WebToolActions>
                    </FooterBox>
                </AmbientFrame>
            </FooterContainer>
        );
    }

    if (props.type === "skill_enable") {
        const { skillName, onEnable, onSkip } = props;
        return (
            <FooterContainer>
                <AmbientFrame $variant="composer" $state="awaiting-input">
                    <FooterBox>
                        <FooterHeaderRow>
                            <WebToolHeader>
                                <span className="codicon codicon-extensions" />
                                Skill Disabled
                            </WebToolHeader>
                            <StopControl onStop={onStop} />
                        </FooterHeaderRow>
                        <WebToolContent>{skillName}</WebToolContent>
                        <FooterDivider />
                        <WebToolActions>
                            <ActionButton onClick={onEnable}>Enable skill</ActionButton>
                            <ActionButton variant="secondary" onClick={onSkip}>Continue without it</ActionButton>
                        </WebToolActions>
                    </FooterBox>
                </AmbientFrame>
            </FooterContainer>
        );
    }

    // plan / completion
    const { type, onApprove, onReject, isSubmitting = false } = props;

    const promptText = type === "plan" ? "Does this plan look right?" : "Ready to continue?";
    const approveIcon = type === "plan" ? "codicon-play" : "codicon-check";
    const approveButtonText = type === "plan" ? "Start building" : "Approve";

    const handleRejectSubmit = () => {
        const trimmed = comment.trim();
        if (trimmed) {
            onReject(trimmed);
            setComment("");
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (comment.trim()) {
                handleRejectSubmit();
            }
        }
    };

    return (
        <FooterContainer>
            <AmbientFrame $variant="composer" $state="awaiting-input">
                <FooterBox>
                    <FooterHeaderRow>
                        <FooterBoxPrompt>{promptText}</FooterBoxPrompt>
                        <StopControl onStop={onStop} />
                    </FooterHeaderRow>
                    <FooterDivider />
                    <ActionButton
                        onClick={() => onApprove(false)}
                        disabled={isSubmitting}
                        style={{ justifyContent: "flex-start", gap: "6px" }}
                    >
                        <span className={`codicon ${approveIcon}`} style={{ fontSize: "12px" }} />
                        {approveButtonText}
                    </ActionButton>
                    <FooterTextInputRow>
                        <FooterInput
                            type="text"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="What should be different?"
                            disabled={isSubmitting}
                        />
                        <FooterIconBtn
                            onClick={handleRejectSubmit}
                            disabled={!comment.trim() || isSubmitting}
                            title="Request Revision"
                        >
                            <span className="codicon codicon-send" style={{ fontSize: "14px" }} />
                        </FooterIconBtn>
                    </FooterTextInputRow>
                </FooterBox>
            </AmbientFrame>
        </FooterContainer>
    );
};

export default CommonApprovalFooter;
