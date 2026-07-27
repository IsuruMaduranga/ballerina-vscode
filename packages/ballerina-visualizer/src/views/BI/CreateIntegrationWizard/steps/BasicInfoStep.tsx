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

import { useEffect, useRef } from "react";
import styled from "@emotion/styled";
import { Codicon, DirectorySelector, TextField } from "@wso2/ui-toolkit";

const FieldGroup = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
`;

const InfoNote = styled.div`
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-descriptionForeground);
`;

interface BasicInfoStepProps {
    integrationName: string;
    /** Full creation path shown in the field: `<baseDir>/<directoryName>`. */
    fullPath: string;
    nameError: string | null;
    pathError: string | null;
    /** The chosen path is inside an existing Ballerina project — the new
     *  integration will be added into it rather than created standalone. */
    existingWorkspace: boolean;
    onNameChange: (value: string) => void;
    /** Fired when the path field text changes; the parent re-splits it into
     *  parent directory + directory name. */
    onPathChange: (value: string) => void;
    onBrowse: () => Promise<void>;
    /** Hide the path field — the location is fixed by the chosen project (the
     *  integration is created inside it), so only the name is asked for. */
    hidePath?: boolean;
}

/**
 * Step 1 — integration name and the full path the integration is created at.
 * The path field shows the complete target directory (`<parent>/<folder>`); its
 * last segment defaults to the integration name and stays editable and
 * independent of the Ballerina package name.
 */
export function BasicInfoStep({
    integrationName,
    fullPath,
    nameError,
    pathError,
    existingWorkspace,
    onNameChange,
    onPathChange,
    onBrowse,
    hidePath = false,
}: BasicInfoStepProps) {
    const nameFieldRef = useRef<HTMLInputElement>(null);

    // Focus and select the default "Untitled" name on mount so the user can
    // immediately overtype it. VSCodeTextField is a web component, so the real
    // <input> is inside its shadow DOM and needs to be targeted directly. Its
    // value sync from the `value` prop lags the initial render by a frame or
    // two, so poll until the input actually holds the text before selecting
    // it — selecting immediately can land while the input is still empty.
    useEffect(() => {
        // Normally resolves within the first frame or two, once the value has
        // synced in. GIVE_UP_AFTER is just a backstop so a mount where the value
        // never syncs still ends up focused, instead of polling forever.
        const GIVE_UP_AFTER_FRAMES = 30;
        let rafId: number;
        let attempts = 0;
        const trySelect = () => {
            const inner = (nameFieldRef.current as any)?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
            if (!inner) {
                return;
            }
            const valueSynced = inner.value.length > 0;
            const gaveUp = attempts >= GIVE_UP_AFTER_FRAMES;
            if (valueSynced || gaveUp) {
                inner.focus();
                inner.select();
                return;
            }
            attempts++;
            rafId = requestAnimationFrame(trySelect);
        };
        rafId = requestAnimationFrame(trySelect);
        return () => cancelAnimationFrame(rafId);
    }, []);

    return (
        <>
            <FieldGroup>
                <TextField
                    ref={nameFieldRef}
                    onTextChange={onNameChange}
                    value={integrationName}
                    label="Integration Name"
                    placeholder="Enter an integration name"
                    required={true}
                    errorMsg={nameError || ""}
                />
            </FieldGroup>
            {!hidePath && (
                <FieldGroup>
                    <DirectorySelector
                        id="integration-folder-selector"
                        label="Select Path"
                        placeholder="Enter path or browse to select a folder..."
                        selectedPath={fullPath}
                        required={true}
                        onSelect={onBrowse}
                        onChange={onPathChange}
                        errorMsg={pathError || undefined}
                    />
                    {existingWorkspace && !pathError && (
                        <InfoNote>
                            <Codicon name="info" sx={{ marginTop: "1px" }} />
                            <span>This is an integrator project. Your new integration will be added to it.</span>
                        </InfoNote>
                    )}
                </FieldGroup>
            )}
        </>
    );
}
