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

import React from "react";
import styled from "@emotion/styled";

export type ShellMode = "auto" | "ask";

const ToggleButton = styled.button`
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 6px;
    border-radius: 4px;
    border: none;
    background-color: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-family: var(--vscode-font-family);
    cursor: pointer;
    transition: background-color 0.1s, color 0.1s;

    &:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
        color: var(--vscode-foreground);
    }

    &:disabled {
        opacity: 0.5;
        cursor: default;
    }
`;

export interface ShellModeToggleProps {
    mode: ShellMode;
    onToggle: () => void;
    disabled?: boolean;
}

const TITLES: Record<ShellMode, string> = {
    auto: "Shell commands: auto. Commands the built-in checks cannot clear are screened by Claude Sonnet 5; blocked ones go back to the Copilot. Click to be asked instead.",
    ask: "Shell commands: ask. You approve every command the built-in checks cannot clear. Click to let auto mode screen them.",
};

/** Switches how the Copilot's shell commands are approved: auto mode (the default) or ask. */
const ShellModeToggle: React.FC<ShellModeToggleProps> = ({ mode, onToggle, disabled }) => (
    <ToggleButton
        onClick={onToggle}
        disabled={disabled}
        aria-label={mode === "auto" ? "Shell commands in auto mode, click to switch to ask" : "Shell commands in ask mode, click to switch to auto"}
        title={TITLES[mode]}
    >
        <span className="codicon codicon-terminal" style={{ fontSize: 14 }} />
        {mode === "auto" ? "Auto" : "Ask"}
    </ToggleButton>
);

export default ShellModeToggle;
