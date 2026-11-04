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

import styled from "@emotion/styled";
import React, { useState } from "react";
import { ChevronIcon, CommandOutput } from "./CommandOutputCard";
import { ItemLabel, ItemRow, ToolIcon } from "./styles";
import { getToolResultDisplay, shellExploreIcon, shellExploreTitle, type ShellExploreSummary } from "./toolDisplay";

// A real <button> so the row is focusable and keyboard-operable, as ThinkingSegment's header.
const RowButton = styled(ItemRow.withComponent("button"))`
    cursor: pointer;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    width: 100%;
    &:disabled { cursor: default; }
`;

const RowOutput = styled(CommandOutput)`
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    margin: 2px 0 4px 0;
`;

interface ShellExploreRowProps {
    toolName: string;
    explore: ShellExploreSummary;
    toolOutput: any;
    failed?: boolean;
}

/**
 * A finished shell command that only listed, searched or read the project, shown like the file
 * tools' rows ("Read 9 files") instead of a terminal card. Clicking it shows the command and its output.
 */
const ShellExploreRow: React.FC<ShellExploreRowProps> = ({ toolName, explore, toolOutput, failed }) => {
    const [expanded, setExpanded] = useState(false);
    const output: string | undefined = toolOutput?.output;
    const errored = failed || toolOutput?.status === "error";

    return (
        <>
            <RowButton type="button" disabled={!output} aria-expanded={expanded} title={shellExploreTitle(explore)} onClick={() => setExpanded((e) => !e)}>
                <ToolIcon failed={errored}>
                    <span className={`codicon ${shellExploreIcon(explore)}`} />
                </ToolIcon>
                <ItemLabel loading={false} failed={errored}>
                    {getToolResultDisplay(toolName, toolOutput).label}
                </ItemLabel>
                {output && (
                    <ChevronIcon expanded={expanded}>
                        <span className="codicon codicon-chevron-down" />
                    </ChevronIcon>
                )}
            </RowButton>
            {expanded && output && <RowOutput command={toolOutput?.command} output={output} />}
        </>
    );
};

export default ShellExploreRow;
