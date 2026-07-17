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

import { useState } from "react";
import styled from "@emotion/styled";
import { Button, TextField } from "@wso2/ui-toolkit";
import { FormHeader } from "../../../../../components/FormHeader";

const FormContainer = styled.div`
    max-width: 600px;
`;

const FieldGroup = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 16px 0 24px;
`;

const ActionRow = styled.div`
    display: flex;
    justify-content: flex-end;
`;

interface AIAgentConfigureFormProps {
    isSubmitting: boolean;
    onSubmit: (agentName: string) => void;
}

/**
 * Step 3 for the AI Chat Agent — collects only the agent name (mirroring
 * AIChatAgentWizard's single input and validation rules; the duplicate-service
 * check is skipped since the project is brand-new). The agent's multi-RPC
 * creation orchestration runs post-reload via the pre-filled AIChatAgentWizard.
 */
export function AIAgentConfigureForm({ isSubmitting, onSubmit }: AIAgentConfigureFormProps) {
    const [name, setName] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);

    const validateName = (value: string): boolean => {
        if (!value || !value.trim()) {
            setNameError("Name is required");
            return false;
        }
        if (/^\s/.test(value) || /^[0-9]/.test(value.trim())) {
            setNameError("Name must start with a letter");
            return false;
        }
        if (!/^[a-zA-Z][a-zA-Z0-9\s_]*$/.test(value)) {
            setNameError("Name can only contain letters, numbers, spaces, and underscores");
            return false;
        }
        setNameError(null);
        return true;
    };

    const handleCreate = () => {
        if (!validateName(name)) {
            return;
        }
        onSubmit(name.trim());
    };

    return (
        <FormContainer>
            <FormHeader title="Create AI Chat Agent" subtitle="Create an intelligent chat agent" />
            <FieldGroup>
                <TextField
                    label="Name"
                    placeholder="Enter a name for the agent"
                    value={name}
                    autoFocus={true}
                    required={true}
                    onTextChange={(value: string) => {
                        setName(value);
                        validateName(value);
                    }}
                    errorMsg={nameError || ""}
                />
            </FieldGroup>
            <ActionRow>
                <Button appearance="primary" onClick={handleCreate} disabled={isSubmitting || !!nameError}>
                    Create Integration
                </Button>
            </ActionRow>
        </FormContainer>
    );
}
