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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, Typography } from "@wso2/ui-toolkit";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import {
    PageWrapper,
    FormContainer,
    TitleContainer,
    ScrollableContent,
    ButtonWrapper,
    IconButton,
} from "./styles";
import { AddProjectFormFields } from "./AddProjectFormFields";
import { AddProjectFormData } from "./types";
import { isFormValidAddProject, joinPath, sanitizeOrgHandle, sanitizePackageName, splitPath } from "./utils";
import { useRealtimeProjectPathValidation } from "../CreateIntegrationWizard/hooks/useRealtimeProjectPathValidation";
import { ValidateProjectFormErrorField } from "@wso2/ballerina-core";
export function AddProjectForm() {
    const { rpcClient } = useRpcContext();
    const [formData, setFormData] = useState<AddProjectFormData>({
        integrationName: "",
        packageName: "",
        workspaceName: "",
        orgName: "",
        version: "",
        isLibrary: false,
    });
    const [isInProject, setIsInProject] = useState<boolean>(false);
    const [addNewAfterConvert, setAddNewAfterConvert] = useState<boolean>(false);
    const [targetPath, setTargetPath] = useState<string>("");
    // Convert flow: the destination is user-selectable. `convertBaseDir` is the
    // parent location (defaults to the current integration's parent) and the
    // directory name (last path segment) defaults to the project name but can be
    // edited independently once the user touches it.
    const [convertBaseDir, setConvertBaseDir] = useState<string>("");
    const [convertDirName, setConvertDirName] = useState<string>("");
    const [convertDirTouched, setConvertDirTouched] = useState<boolean>(false);
    const [convertPathError, setConvertPathError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [pathValidationError, setPathValidationError] = useState<string | null>(null);
    const [packageNameValidationError, setPackageNameValidationError] = useState<string | null>(null);
    const [projectNameValidationError, setProjectNameValidationError] = useState<string | null>(null);
    const resourceTypeLabel = formData.isLibrary ? "Library" : "Integration";
    const isConvert = !isInProject;
    const isConvertAndAdd = isConvert && addNewAfterConvert;

    // The name-derived default for the destination folder segment.
    const autoConvertDirName = formData.projectHandle?.trim()
        ? formData.projectHandle
        : sanitizePackageName(formData.workspaceName || "");
    // The folder segment actually used: the manually edited value once the user has
    // taken control, otherwise the name-derived default.
    const effectiveConvertDirName = convertDirTouched ? convertDirName.trim() : autoConvertDirName;
    const convertFullPath = joinPath(convertBaseDir, effectiveConvertDirName);

    const handleFormDataChange = useCallback((data: Partial<AddProjectFormData>) => {
        setFormData(prev => ({ ...prev, ...data }));
        setPathValidationError(null);
        setPackageNameValidationError(null);
        setProjectNameValidationError(null);
    }, []);

    // Adapter so the shared realtime path-validation hook can call the native RPC client.
    const pathValidationClient = useMemo(
        () => ({ validateProjectPath: (p: any) => rpcClient.getBIDiagramRpcClient().validateProjectPath(p) }),
        [rpcClient]
    );

    useRealtimeProjectPathValidation({
        wsClient: pathValidationClient,
        projectPath: convertBaseDir,
        projectName: formData.workspaceName || "",
        createAsWorkspace: true,
        // Only meaningful in the convert flow; validate live once a base and a folder
        // name are present so a "directory already exists" conflict surfaces early.
        pathTouched: isConvert && convertBaseDir.trim().length > 0 && effectiveConvertDirName.length > 0,
        requiredPathMessage: "Please select a location for your project",
        invalidPathMessage: "Invalid project path",
        onPathErrorChange: useCallback((error: string | null) => setConvertPathError(error), []),
        directoryName: effectiveConvertDirName,
    });

    useEffect(() => {
        Promise.all([
            rpcClient.getCommonRpcClient().getWorkspaceRoot(),
            rpcClient.getCommonRpcClient().getWorkspaceType()
        ]).then(async ([workspaceRoot, workspaceType]) => {
            const inProject = workspaceType.type === "BALLERINA_WORKSPACE";
            setTargetPath(workspaceRoot.path);
            // The converted project is created next to the current integration by
            // default, so seed the location with the integration's parent directory.
            setConvertBaseDir(splitPath(workspaceRoot.path).base);
            setIsInProject(inProject);

            try {
                const defaults = await rpcClient.getBIDiagramRpcClient().getSuggestedProjectDefaults({ isInProject: inProject });
                setFormData(prev => ({
                    ...prev,
                    workspaceName: inProject ? prev.workspaceName : defaults.projectName,
                    projectHandle: inProject ? prev.projectHandle : defaults.projectHandle,
                    integrationName: defaults.integrationName,
                    packageName: defaults.packageName,
                }));
            } catch {
                // defaults unavailable — leave form empty
            }
        });
    }, []);

    const handleConvertPathChange = (value: string) => {
        // The field shows the full destination path; its last segment is the project
        // folder name (editable). Editing it away from the name-derived default takes
        // manual control so subsequent name edits no longer overwrite it.
        const { base, name } = splitPath(value);
        setConvertBaseDir(base);
        setConvertDirName(name);
        setConvertDirTouched(name !== autoConvertDirName);
        setConvertPathError(null);
    };

    const handleConvertPathSelect = async () => {
        try {
            const selected = await rpcClient.getCommonRpcClient().selectFileOrDirPath({});
            if (selected?.path) {
                setConvertBaseDir(selected.path);
                setConvertPathError(null);
            }
        } catch (error) {
            console.error("Failed to select path:", error);
            setConvertPathError("Failed to select path. Please try again.");
        }
    };

    const handleAddProject = async () => {
        setIsLoading(true);
        setPathValidationError(null);
        setConvertPathError(null);
        setPackageNameValidationError(null);
        setProjectNameValidationError(null);

        // For convert, the destination is the user-chosen location + folder name.
        const basePathForRequest = isInProject ? targetPath : convertBaseDir;

        if (!isInProject && (!basePathForRequest?.trim() || !effectiveConvertDirName)) {
            setConvertPathError("Please select a location for your project");
            setIsLoading(false);
            return;
        }

        try {
            const validationResult = await rpcClient.getBIDiagramRpcClient().validateProjectPath({
                projectPath: basePathForRequest,
                projectName: isInProject ? formData.packageName : formData.workspaceName,
                createDirectory: true,
                createAsWorkspace: !isInProject,
                directoryName: isInProject ? undefined : effectiveConvertDirName,
            });

            if (!validationResult.isValid) {
                // Show error on the appropriate field
                if (validationResult.errorField === ValidateProjectFormErrorField.PATH) {
                    if (isInProject) {
                        setPathValidationError(validationResult.errorMessage || `Invalid ${resourceTypeLabel.toLowerCase()} path`);
                    } else {
                        setConvertPathError(validationResult.errorMessage || "Invalid project path");
                    }
                } else if (validationResult.errorField === ValidateProjectFormErrorField.NAME) {
                    if (isInProject) {
                        setPackageNameValidationError(
                            validationResult.errorMessage || `Invalid ${resourceTypeLabel.toLowerCase()} name`
                        );
                    } else {
                        setProjectNameValidationError(
                            validationResult.errorMessage || "Invalid project name"
                        );
                    }
                }
                setIsLoading(false);
                return;
            }

            const orgHandle = sanitizeOrgHandle(formData.orgName);

            // If validation passes, add the project
            rpcClient.getBIDiagramRpcClient().addProjectToWorkspace({
                projectName: formData.integrationName,
                packageName: formData.packageName,
                convertToWorkspace: isConvert,
                addNewAfterConvert: isConvertAndAdd,
                path: basePathForRequest,
                directoryName: isInProject ? undefined : effectiveConvertDirName,
                workspaceName: formData.workspaceName,
                orgName: formData.orgName || undefined,
                orgHandle,
                version: formData.version || undefined,
                isLibrary: formData.isLibrary,
                projectHandle: formData.projectHandle,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "An error occurred during validation";
            if (isInProject) {
                setPathValidationError(message);
            } else {
                setConvertPathError(message);
            }
            setIsLoading(false);
        }
    };

    const goBack = () => {
        rpcClient.getVisualizerRpcClient().goBack();
    };

    return (
        <PageWrapper>
            <FormContainer>
                <TitleContainer>
                    <IconButton onClick={goBack}>
                        <Icon name="bi-arrow-back" iconSx={{ color: "var(--vscode-foreground)" }} />
                    </IconButton>
                    <Typography variant="h2">
                        {isInProject
                            ? `Add New ${resourceTypeLabel}`
                            : isConvertAndAdd
                                ? `Convert to Project & Add New ${resourceTypeLabel}`
                                : "Convert to Project"}
                    </Typography>
                </TitleContainer>

                <ScrollableContent>
                    <AddProjectFormFields
                        formData={formData}
                        onFormDataChange={handleFormDataChange}
                        isInProject={isInProject}
                        addNewAfterConvert={addNewAfterConvert}
                        onAddNewAfterConvertChange={setAddNewAfterConvert}
                        packageNameValidationError={packageNameValidationError || undefined}
                        projectNameValidationError={projectNameValidationError || undefined}
                        convertPath={convertFullPath}
                        onConvertPathChange={handleConvertPathChange}
                        onConvertPathSelect={handleConvertPathSelect}
                        convertPathError={convertPathError || undefined}
                    />
                </ScrollableContent>

                <ButtonWrapper>
                    {isInProject && pathValidationError && (
                        <Typography 
                            variant="body2" 
                            sx={{ 
                                color: "var(--vscode-errorForeground)", 
                                marginRight: "16px",
                                flex: 1
                            }}
                        >
                            {pathValidationError}
                        </Typography>
                    )}
                    <Button
                        disabled={!isFormValidAddProject(formData, isInProject, addNewAfterConvert) || isLoading || (isConvert && !!convertPathError)}
                        onClick={handleAddProject}
                        appearance="primary"
                    >
                        {isLoading ? (
                            <Typography variant="progress">
                                {isInProject
                                    ? "Adding..."
                                    : isConvertAndAdd
                                        ? "Converting & Adding..."
                                        : "Converting..."}
                            </Typography>
                        ) : (
                            isInProject
                                ? `Add ${resourceTypeLabel}`
                                : isConvertAndAdd
                                    ? `Convert & Add ${resourceTypeLabel}`
                                    : "Convert to Project"
                        )}
                    </Button>
                </ButtonWrapper>
            </FormContainer>
        </PageWrapper>
    );
}
