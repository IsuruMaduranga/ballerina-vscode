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
import { Typography, ThemeColors } from "@wso2/ui-toolkit";

export const LoadingContainer = styled.div`
    display: flex;
    justify-content: center;
    align-items: center;
    height: 80vh;
    flex-direction: column;
`;

export const Container = styled.div({
    display: "flex",
    flexDirection: "column",
    gap: 10,
});

export const AddPanel = styled.div({
    position: "relative", // Add this line to position the close button absolutely
    display: "flex",
    flexDirection: "column",
    gap: 32,
    padding: 16,
});

// ── Filter bar (colored category chips + compact search), mirroring the Create
//    wizard's Integration Type step so the Add-Artifact screen reads the same. ──

export const FilterBar = styled.div`
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding: 8px 16px 12px;
    background-color: var(--vscode-editor-background);
`;

export const ChipRow = styled.div`
    display: flex;
    gap: 6px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    flex-wrap: nowrap;
`;

export const SearchSlot = styled.div`
    flex-shrink: 0;
    width: 220px;
`;

export const Chip = styled.button<{ active?: boolean; accent: string }>`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 5px 12px;
    border-radius: 999px;
    /* Category-colored, matching the Project Overview type labels; the active
       (filter) chip gets a stronger tint + weight. */
    border: 1px solid ${(props: { active?: boolean; accent: string }) =>
        `color-mix(in srgb, ${props.accent} ${props.active ? "55%" : "24%"}, transparent)`};
    background-color: ${(props: { active?: boolean; accent: string }) =>
        `color-mix(in srgb, ${props.accent} ${props.active ? "22%" : "12%"}, transparent)`};
    color: ${(props: { accent: string }) => props.accent};
    font-size: 12px;
    font-weight: ${(props: { active?: boolean }) => (props.active ? 600 : 500)};
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
    &:hover {
        background-color: ${(props: { active?: boolean; accent: string }) =>
            `color-mix(in srgb, ${props.accent} ${props.active ? "22%" : "18%"}, transparent)`};
    }
    &:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
    }
`;

export const PanelViewMore = styled.div<{ disabled?: boolean }>`
    display: flex;
    flex-direction: column;
    gap: 10px;
    opacity: ${(props: { disabled: boolean }) => (props.disabled ? 0.5 : 1)};
    pointer-events: ${(props: { disabled: boolean }) => (props.disabled ? "none" : "auto")};
`;

export const CardGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
    width: 100%;
`;

export const Title = styled(Typography)`
    margin: 4px 0;
    font-size: 16px;
`;

export const Card = styled.div`
    border: 2px solid ${(props: { active: boolean }) => (props.active ? ThemeColors.PRIMARY : ThemeColors.OUTLINE_VARIANT)};
    background-color: ${(props: { active: boolean }) => (props.active ? ThemeColors.PRIMARY_CONTAINER : ThemeColors.SURFACE_DIM)};
    cursor: pointer;
    &:hover {
        background-color: ${ThemeColors.PRIMARY_CONTAINER};
        border: 2px solid ${ThemeColors.PRIMARY};
    }
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 16px;
    max-width: 42rem;
    padding: 16px;
    border-radius: 4px;
    cursor: pointer;
`;

export const TitleWrapper = styled.div`
    display: flex;
    flex-direction: column;
`;
