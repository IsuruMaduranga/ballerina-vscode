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
import { Button, Typography } from "@wso2/ui-toolkit";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { AddProjectFormFields } from "./AddProjectFormFields";
import { AddProjectFormData } from "./types";
import { isFormValidAddProject, joinPath, sanitizeOrgHandle, sanitizePackageName, splitPath } from "./utils";
import { useRealtimeProjectPathValidation } from "../CreateIntegrationWizard/hooks/useRealtimeProjectPathValidation";
import { ValidateProjectFormErrorField } from "@wso2/ballerina-core";
import { CreateIntegrationWizard } from "../CreateIntegrationWizard";
import { ProjectContext } from "../CreateIntegrationWizard/types";
import { BiWsClientProvider } from "../wsManager/WsClientContext";
import { CreateFlowShell } from "./embedded/integrator-form/shared/CreateFlowShell";
import { FormFooter } from "./embedded/integrator-form/shared/FormPageLayout";
import { useDirectoryNameCoupling } from "./hooks/useDirectoryNameCoupling";
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
    // "chooser" = pick project + starting point; "integration" = the full Create
    // Integration wizard mounted in place (library stays inline on the chooser).
    const [screen, setScreen] = useState<"chooser" | "integration">("chooser");
    const [targetPath, setTargetPath] = useState<string>("");
    // Convert flow: the destination is user-selectable. `convertBaseDir` is the
    // parent location (defaults to the current integration's parent) and the
    // directory name (last path segment) defaults to the project name but can be
    // edited independently once the user touches it.
    const [convertBaseDir, setConvertBaseDir] = useState<string>("");
    const convertDirCoupling = useDirectoryNameCoupling("", sanitizePackageName);
    const [convertPathError, setConvertPathError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [pathValidationError, setPathValidationError] = useState<string | null>(null);
    const [packageNameValidationError, setPackageNameValidationError] = useState<string | null>(null);
    const [projectNameValidationError, setProjectNameValidationError] = useState<string | null>(null);
    const resourceTypeLabel = formData.isLibrary ? "Library" : "Integration";
    const isConvert = !isInProject;
    const isConvertAndAdd = isConvert && addNewAfterConvert;
    // Whether a starting point (integration/library) is being added (vs a plain convert).
    const isAddingComponent = isInProject || addNewAfterConvert;
    // Integration is created through the full wizard (next screen), matching the
    // initial Create experience; a library is configured inline and submitted here.
    const routeToWizard = isAddingComponent && !formData.isLibrary;

    // The name-derived default for the destination folder segment.
    const autoConvertDirName = formData.projectHandle?.trim()
        ? formData.projectHandle
        : sanitizePackageName(formData.workspaceName || "");
    // The folder segment actually used: the manually edited value once the user has
    // taken control, otherwise the name-derived default.
    const effectiveConvertDirName = convertDirCoupling.dirTouched
        ? convertDirCoupling.directoryName.trim()
        : autoConvertDirName;
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
        convertDirCoupling.handleDirectoryNameEdit(name, autoConvertDirName);
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

    // The project the wizard adds the new integration into: the existing workspace
    // when adding from within a project, or a brand-new workspace created by
    // converting the current standalone integration (the wizard performs the
    // convert-and-add on submit).
    const integrationProjectContext: ProjectContext = isInProject
        ? { isNewProject: false, workspacePath: targetPath }
        : {
            isNewProject: true,
            workspacePath: convertFullPath,
            workspaceName: formData.workspaceName?.trim() || undefined,
            convertToWorkspace: true,
        };

    // Convert-flow "Next" is disabled until the project name + a valid location are set;
    // the add-from-workspace flow has no project fields, so it is always enabled.
    const nextDisabled =
        isLoading ||
        (isConvert &&
            (!formData.workspaceName?.trim() ||
                !convertBaseDir.trim() ||
                !effectiveConvertDirName ||
                !!convertPathError ||
                !!projectNameValidationError));

    /** Chooser → integration wizard. In the convert flow the project name + location
     *  are captured (and validated) here first; the wizard then owns naming and
     *  configuring the integration and performs the convert-and-add on submit. */
    const handleNext = () => {
        if (isConvert) {
            if (!formData.workspaceName?.trim()) {
                setProjectNameValidationError("Project name is required");
                return;
            }
            if (!convertBaseDir.trim() || !effectiveConvertDirName) {
                setConvertPathError("Please select a location for your project");
                return;
            }
            if (convertPathError) {
                return;
            }
        }
        setScreen("integration");
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

    if (screen === "integration") {
        return (
            <CreateFlowShell
                title="New Integration"
                subtitle={isInProject ? undefined : `In project ${formData.workspaceName?.trim() || "your new project"}`}
                onBack={() => setScreen("chooser")}
                bodyFill
                fill
            >
                <BiWsClientProvider onBack={() => setScreen("chooser")}>
                    <CreateIntegrationWizard embedded showHeader={false} projectContext={integrationProjectContext} />
                </BiWsClientProvider>
            </CreateFlowShell>
        );
    }

    const chooserTitle = isInProject
        ? `Add New ${resourceTypeLabel}`
        : isConvertAndAdd
            ? `Convert to Project & Add New ${resourceTypeLabel}`
            : "Convert to Project";
    const chooserSubtitle = isInProject
        ? "Add an integration or library to your project."
        : "Organize your current integration inside a project.";

    return (
        <CreateFlowShell title={chooserTitle} subtitle={chooserSubtitle} onBack={goBack} fill>
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

            <FormFooter>
                {isInProject && pathValidationError && (
                    <Typography
                        variant="body2"
                        sx={{
                            color: "var(--vscode-errorForeground)",
                            marginRight: "16px",
                            flex: 1,
                        }}
                    >
                        {pathValidationError}
                    </Typography>
                )}
                {routeToWizard ? (
                    <Button disabled={nextDisabled} onClick={handleNext} appearance="primary">
                        Next
                    </Button>
                ) : (
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
                )}
            </FormFooter>
        </CreateFlowShell>
    );
}
