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
import { DirectorySelector, TextField } from "@wso2/ui-toolkit";

const FieldGroup = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
`;

interface BasicInfoStepProps {
    integrationName: string;
    /** Full creation path shown in the field: `<baseDir>/<directoryName>`. */
    fullPath: string;
    nameError: string | null;
    pathError: string | null;
    onNameChange: (value: string) => void;
    /** Fired when the path field text changes; the parent re-splits it into
     *  parent directory + directory name. */
    onPathChange: (value: string) => void;
    onBrowse: () => Promise<void>;
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
    onNameChange,
    onPathChange,
    onBrowse,
}: BasicInfoStepProps) {
    return (
        <>
            <FieldGroup>
                <TextField
                    onTextChange={onNameChange}
                    value={integrationName}
                    label="Integration Name"
                    placeholder="Enter an integration name"
                    autoFocus={true}
                    required={true}
                    errorMsg={nameError || ""}
                />
            </FieldGroup>
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
            </FieldGroup>
        </>
    );
}
