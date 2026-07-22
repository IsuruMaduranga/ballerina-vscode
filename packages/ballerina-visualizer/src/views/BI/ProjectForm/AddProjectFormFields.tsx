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

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckBox, DirectorySelector, TextField } from "@wso2/ui-toolkit";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { usePlatformExtContext } from "../../../providers/platform-ext-ctx-provider";
import {
    CheckboxContainer,
    Description,
    FieldGroup,
    ProjectSection,
    SectionDivider,
} from "./styles";
import { ProjectTypeSelector, AdvancedConfigurationSection } from "./components";
import { AddProjectFormData } from "./types";
import {
    sanitizePackageName,
    sanitizeProjectHandle,
    validateComponentName,
    validatePackageName,
    validateOrgName,
} from "./utils";

// Re-export for backwards compatibility
export type { AddProjectFormData } from "./types";

export interface AddProjectFormFieldsProps {
    formData: AddProjectFormData;
    onFormDataChange: (data: Partial<AddProjectFormData>) => void;
    isInProject: boolean;
    addNewAfterConvert: boolean;
    onAddNewAfterConvertChange: (value: boolean) => void;
    packageNameValidationError?: string;
    projectNameValidationError?: string;
    /** Full destination path (location + folder name) for the convert flow. */
    convertPath?: string;
    onConvertPathChange?: (value: string) => void;
    onConvertPathSelect?: () => void;
    convertPathError?: string;
}

export function AddProjectFormFields({
    formData,
    onFormDataChange,
    isInProject,
    addNewAfterConvert,
    onAddNewAfterConvertChange,
    packageNameValidationError,
    projectNameValidationError,
    convertPath,
    onConvertPathChange,
    onConvertPathSelect,
    convertPathError,
}: AddProjectFormFieldsProps) {
    const { rpcClient } = useRpcContext();
    const { platformExtState } = usePlatformExtContext();
    const isLoggedIn = !!platformExtState?.isLoggedIn;
    const orgsSource = platformExtState?.userInfo?.organizations;
    const organizations = useMemo(
        () => isLoggedIn ? (orgsSource ?? []) : undefined,
        [isLoggedIn, orgsSource]
    );
    const [packageNameTouched, setPackageNameTouched] = useState(false);
    const isOrgTouched = useRef(false);
    const [isPackageInfoExpanded, setIsPackageInfoExpanded] = useState(false);
    const [integrationNameError, setIntegrationNameError] = useState<string | null>(null);
    const [packageNameError, setPackageNameError] = useState<string | null>(null);
    const [isOrgLocked, setIsOrgLocked] = useState(false);
    const [isOrgDataLoaded, setIsOrgDataLoaded] = useState(false);
    const resourceTypeLabel = formData.isLibrary ? "Library" : "Integration";
    const resourceTypeLabelLower = resourceTypeLabel.toLowerCase();
    const showIntegrationFields = isInProject || addNewAfterConvert;

    const handleProjectName = (value: string) => {
        // The project name also seeds the default destination folder name (via the
        // derived handle); the folder itself is editable through the Project Location
        // field, so there is no separate Project ID field to keep in sync here.
        onFormDataChange({
            workspaceName: value,
            projectHandle: sanitizeProjectHandle(value, { trimTrailing: false }),
        });
    };

    const handleIntegrationName = (value: string) => {
        onFormDataChange({ integrationName: value });
        // Auto-populate package name if user hasn't manually edited it
        if (!packageNameTouched) {
            onFormDataChange({ packageName: sanitizePackageName(value) });
        }
    };

    useEffect(() => {
        if (isOrgTouched.current) return;

        const controller = new AbortController();

        const pickOrg = (rpcOrg: string) => {
            const match = organizations?.find((o) => o.handle === rpcOrg);
            if (match) return match.handle;
            if (organizations && organizations.length > 0) return organizations[0].handle;
            return rpcOrg;
        };

        (async () => {
            try {
                const { orgName: rpcOrg, isLocked } = await rpcClient.getCommonRpcClient().getDefaultOrgName();
                if (controller.signal.aborted) return;
                if (isOrgTouched.current) {
                    setIsOrgDataLoaded(true);
                    return;
                }

                if (isInProject && isLocked) {
                    setIsOrgLocked(true);
                    setIsOrgDataLoaded(true);
                    onFormDataChange({ orgName: rpcOrg });
                    return;
                }

                setIsOrgLocked(false);
                setIsOrgDataLoaded(true);
                onFormDataChange({ orgName: pickOrg(rpcOrg) });
            } catch (error) {
                if (controller.signal.aborted) return;
                if (isOrgTouched.current) {
                    setIsOrgDataLoaded(true);
                    return;
                }

                console.error("Failed to fetch default org name:", error);
                setIsOrgLocked(false);
                setIsOrgDataLoaded(true);

                if (organizations && organizations.length > 0) {
                    onFormDataChange({ orgName: organizations[0].handle });
                }
            }
        })();

        return () => {
            controller.abort();
        };
    }, [isInProject, organizations, onFormDataChange, rpcClient]);

    // Real-time validation for integration/library name
    useEffect(() => {
        const error = validateComponentName(formData.integrationName, formData.isLibrary);
        setIntegrationNameError(error);
    }, [formData.integrationName, formData.isLibrary]);

    // Effect to trigger validation when requested by parent
    useEffect(() => {
        const error = validatePackageName(formData.packageName, formData.integrationName);
        setPackageNameError(error);
    }, [formData.packageName]);

    // Computed inline — avoids a one-render lag from a useState/useEffect pair which would
    // cause hasAdvancedConfigError to briefly read a stale error while orgName is updating.
    const orgNameError = (!isOrgLocked && isOrgDataLoaded) ? validateOrgName(formData.orgName) : null;

    const hasAdvancedConfigError = !!(
        // Advanced configs only render (and matter) when a new package is scaffolded.
        (showIntegrationFields && (packageNameError || packageNameValidationError)) ||
        orgNameError
    );

    // Auto-expand Advanced Configurations when any field inside it has an error
    useEffect(() => {
        if (hasAdvancedConfigError) {
            setIsPackageInfoExpanded(true);
        }
    }, [hasAdvancedConfigError]);

    return (
        <>
            {!isInProject && (
                <>
                    <ProjectSection>
                        <TextField
                            onTextChange={handleProjectName}
                            value={formData.workspaceName}
                            label="Project Name"
                            placeholder="Enter project name"
                            autoFocus={true}
                            required={true}
                            errorMsg={projectNameValidationError || ""}
                        />
                    </ProjectSection>

                    <FieldGroup>
                        <DirectorySelector
                            id="convert-project-folder-selector"
                            label="Project Location"
                            placeholder="Enter path or browse to select a folder..."
                            selectedPath={convertPath || ""}
                            required={true}
                            onSelect={() => onConvertPathSelect?.()}
                            onChange={(value) => onConvertPathChange?.(value)}
                            errorMsg={convertPathError || undefined}
                        />
                        <Description>
                            The project folder is created here and your current integration is moved into it.
                        </Description>
                    </FieldGroup>

                    <CheckboxContainer>
                        <CheckBox
                            label="Also add a new integration or library now"
                            checked={addNewAfterConvert}
                            onChange={onAddNewAfterConvertChange}
                        />
                        <Description>
                            Your current integration becomes the first member of the project. Optionally scaffold
                            another one in the same step.
                        </Description>
                    </CheckboxContainer>
                </>
            )}

            {showIntegrationFields && (
                <>
                    <ProjectTypeSelector
                        value={formData.isLibrary}
                        onChange={(isLibrary) => onFormDataChange({ isLibrary })}
                    />

                    <FieldGroup>
                        <TextField
                            onTextChange={handleIntegrationName}
                            value={formData.integrationName}
                            label={`${resourceTypeLabel} Name`}
                            placeholder={`Enter a ${resourceTypeLabelLower} name`}
                            autoFocus={isInProject}
                            onFocus={(e) => (e.target as HTMLInputElement).select()}
                            required={true}
                            errorMsg={integrationNameError || ""}
                        />
                    </FieldGroup>
                </>
            )}

            {/* Advanced Configurations apply only to the new package being scaffolded, so
                they are shown only when a new integration/library is part of this flow
                (in-project add, or convert + add new). Project-level configs (org / Project
                ID) are intentionally omitted here — the project's location and folder name
                are set via the Project Location field above. */}
            {showIntegrationFields && (
                <>
                    <SectionDivider />

                    <AdvancedConfigurationSection
                        isExpanded={isPackageInfoExpanded}
                        onToggle={() => setIsPackageInfoExpanded(!isPackageInfoExpanded)}
                        data={{
                            packageName: formData.packageName,
                            orgName: formData.orgName,
                            version: formData.version,
                        }}
                        onChange={(data) => {
                            onFormDataChange(data);
                            if (data.packageName !== undefined) {
                                setPackageNameTouched(true);
                            }
                            if (data.orgName !== undefined) {
                                isOrgTouched.current = true;
                            }
                        }}
                        isLibrary={formData.isLibrary}
                        packageNameError={packageNameValidationError || packageNameError}
                        orgNameError={orgNameError || undefined}
                        organizations={organizations}
                        hasError={hasAdvancedConfigError}
                        isOrgLocked={isOrgLocked}
                        showPackageFields={showIntegrationFields}
                    />
                </>
            )}
        </>
    );
}
