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
import { BasicInfo } from "../types";

const FieldGroup = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
`;

interface BasicInfoStepProps {
    basicInfo: BasicInfo;
    nameError: string | null;
    pathError: string | null;
    onChange: (update: Partial<BasicInfo>) => void;
    onBrowse: () => Promise<void>;
}

/** Step 1 — integration name and the parent directory it is created under. */
export function BasicInfoStep({ basicInfo, nameError, pathError, onChange, onBrowse }: BasicInfoStepProps) {
    return (
        <>
            <FieldGroup>
                <TextField
                    onTextChange={(value: string) => onChange({ integrationName: value })}
                    value={basicInfo.integrationName}
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
                    selectedPath={basicInfo.path}
                    required={true}
                    onSelect={onBrowse}
                    onChange={(value: string) => onChange({ path: value, pathTouched: true })}
                    errorMsg={pathError || undefined}
                />
            </FieldGroup>
        </>
    );
}
