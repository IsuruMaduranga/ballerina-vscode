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

import { useState, useEffect, useRef, useMemo } from "react";
import debounce from "lodash/debounce";
import { Button, DirectorySelector, Icon, TextField } from "@wso2/ui-toolkit";
import styled from "@emotion/styled";
import { useVisualizerContext } from "./context/WsClientContext";
import { useCloudContext, useWorkspaceRoot } from "./providers";
import {
    sanitizePackageName,
    validateComponentName,
    validatePackageName,
    validateOrgName,
    joinPath,
    splitPath,
    extractBase,
    sanitizeOrgHandle,
} from "./utils";
import { AdvancedConfigurationSection } from "./components";
import { SectionDivider } from "./styles";
import { ValidateProjectFormErrorField } from "./shims/wi-core";
import {
    PageBackdrop,
    PageContainer,
    HeaderRow,
    BackButton,
    HeaderText,
    HeaderTitle,
    HeaderSubtitle,
    FormPanel,
    FormPanelHeader,
    FormBody,
    FormContent,
    FormFooter,
} from "./shared/FormPageLayout";
import { DEFAULT_LIBRARY_NAME, DEFAULT_PACKAGE_NAME } from "./types";
import { useRealtimeProjectPathValidation } from "./useRealtimeProjectPathValidation";

const FieldGroup = styled.div`
    margin-bottom: 20px;
`;


const MAX_DIRECTORY_ATTEMPTS = 50;
const DIRECTORY_EXISTS_MESSAGE = "A directory with this name already exists at the selected location";

interface LibraryFormData {
    libraryName: string;
    packageName: string;
    path: string;
    orgName: string;
    version: string;
}

export function LibraryCreationView({ onBack, ballerinaUnavailable }: { onBack?: () => void; ballerinaUnavailable?: boolean }) {
    const { wsClient } = useVisualizerContext();
    const { authState } = useCloudContext();
    const organizations = (authState?.userInfo?.organizations as Array<{ id?: any; handle: string; name: string }> | undefined);
    const { path: workspacePath, isReady: workspaceReady } = useWorkspaceRoot();
    const firstFieldRef = useRef<HTMLInputElement>(null);
    const orgNameInitialized = useRef(false);
    const defaultPathInitialized = useRef(false);
    const libraryNameTouchedRef = useRef(false);
    const [packageNameTouched, setPackageNameTouched] = useState(false);
    const [directoryName, setDirectoryName] = useState(() => sanitizePackageName(DEFAULT_LIBRARY_NAME));
    const [dirTouched, setDirTouched] = useState(false);
    const [isPackageInfoExpanded, setIsPackageInfoExpanded] = useState(false);
    const [isValidating, setIsValidating] = useState(false);
    const [libraryNameError, setLibraryNameError] = useState<string | null>(null);
    const [pathError, setPathError] = useState<string | null>(null);
    const [packageNameError, setPackageNameError] = useState<string | null>(null);
    const [orgNameError, setOrgNameError] = useState<string | null>(null);
    const [defaultPath, setDefaultPath] = useState("");
    const [pathTouched, setPathTouched] = useState(false);
    const [editablePath, setEditablePath] = useState("");
    const [formData, setFormData] = useState<LibraryFormData>({
        libraryName: DEFAULT_LIBRARY_NAME,
        packageName: DEFAULT_PACKAGE_NAME,
        path: "",
        orgName: "",
        version: "",
    });

    const debouncedSetLibraryNameError = useMemo(
        () => debounce((error: string) => setLibraryNameError(error), 300),
        []
    );

    useEffect(() => {
        if (!workspaceReady) return;
        let mounted = true;

        const resolveDefaultDirectoryName = async (baseDir: string): Promise<string> => {
            const base = sanitizePackageName(DEFAULT_LIBRARY_NAME);
            for (let attempt = 0; attempt < MAX_DIRECTORY_ATTEMPTS; attempt++) {
                const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`;
                try {
                    const result = await wsClient.validateProjectPath({
                        projectPath: baseDir,
                        projectName: candidate,
                        createDirectory: true,
                    });
                    // First candidate that is either valid or fails for a reason other
                    // than an existing directory is the one we keep.
                    if (result.isValid || result.errorMessage !== DIRECTORY_EXISTS_MESSAGE) {
                        return candidate;
                    }
                } catch {
                    return candidate;
                }
            }
            return base;
        };

        (async () => {
            // Seed the default path only once — this effect re-runs on workspacePath
            // changes, and without the guard it would clobber a path the user has since
            // chosen via Browse or by typing.
            if (!defaultPathInitialized.current) {
                const dp = workspacePath || (await wsClient.getDefaultCreationPath()).path;
                if (!mounted) return;
                // Resolve the indexed default directory name BEFORE committing the path so
                // the path field shows the final value immediately (like the wizard), rather
                // than the un-indexed default catching up after an async re-index.
                const dirName = await resolveDefaultDirectoryName(dp);
                if (!mounted) return;
                defaultPathInitialized.current = true;
                // Don't clobber a name the user typed while the seed was resolving.
                if (!libraryNameTouchedRef.current) {
                    setDirectoryName(dirName);
                }
                setDefaultPath(dp);
                setFormData(prev => ({ ...prev, path: dp }));
            }
        })();
        return () => {
            mounted = false;
        };
    }, [workspaceReady, wsClient, workspacePath]);

    // Initialize org name independently of workspace readiness.
    useEffect(() => {
        if (orgNameInitialized.current) return;
        orgNameInitialized.current = true;
        if (organizations && organizations.length > 0) {
            setFormData(prev => ({ ...prev, orgName: organizations[0].handle }));
        } else {
            wsClient.getDefaultOrgName()
                .then(({ orgName }) => setFormData(prev => ({ ...prev, orgName })))
                .catch((error) => console.error("Failed to fetch default org name:", error));
        }
    }, [organizations, wsClient]);

    useEffect(() => {
        const error = validatePackageName(formData.packageName, formData.libraryName);
        setPackageNameError(error);
    }, [formData.packageName, formData.libraryName]);

    useEffect(() => {
        setOrgNameError(validateOrgName(formData.orgName));
    }, [formData.orgName]);

    // Real-time library name validation — clear immediately when valid, debounce new errors
    // to avoid flashing "required" on every keystroke.
    useEffect(() => {
        const error = validateComponentName(formData.libraryName);
        if (!error) {
            debouncedSetLibraryNameError.cancel();
            setLibraryNameError(null);
            return;
        }
        debouncedSetLibraryNameError(error);
        return () => debouncedSetLibraryNameError.cancel();
    }, [formData.libraryName]);

    // Focus and select the first field on mount — VSCodeTextField is a web component,
    // so the real <input> is inside its shadow DOM and needs to be targeted directly.
    useEffect(() => {
        setTimeout(() => {
            const inner = (firstFieldRef.current as any)?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
            inner?.focus();
            inner?.select();
        }, 0);
    }, []);

    // Keep editablePath in sync with the committed path when the user is not actively editing
    useEffect(() => {
        if (!pathTouched) {
            setEditablePath(formData.path || defaultPath);
        }
    }, [formData.path, defaultPath, pathTouched]);

    useRealtimeProjectPathValidation({
        wsClient,
        projectPath: editablePath,
        projectName: formData.packageName,
        directoryName,
        createAsWorkspace: false,
        allowExistingDirectory: true,
        pathTouched,
        requiredPathMessage: "Please select a path for your library",
        invalidPathMessage: "Invalid library path",
        onPathErrorChange: setPathError,
    });

    const resolvedPath = joinPath(editablePath, directoryName);

    const handleLibraryName = (value: string) => {
        libraryNameTouchedRef.current = true;
        const sanitized = sanitizePackageName(value);
        setFormData(prev => ({
            ...prev,
            libraryName: value,
            packageName: packageNameTouched ? prev.packageName : sanitized,
        }));
        // Reflect the derived folder immediately for a responsive path field. Only the
        // default name is auto-indexed (at seed time); a name the user types is used
        // verbatim, matching the integration wizard.
        if (!dirTouched) {
            setDirectoryName(sanitized);
        }
    };

    const handlePathSelection = async () => {
        const result = await wsClient.selectFileOrDirPath({ startPath: editablePath || formData.path || defaultPath });
        if (!result.path) return;
        setPathTouched(false);
        setEditablePath(result.path);
        setFormData(prev => ({ ...prev, path: result.path }));
    };

    const handleCreate = async () => {
        setIsValidating(true);

        // Commit any un-blurred path before submitting
        const currentPath = editablePath || formData.path;
        if (pathTouched && editablePath !== formData.path) {
            setFormData(prev => ({ ...prev, path: editablePath }));
        }

        let hasError = false;

        const libraryNameErr = validateComponentName(formData.libraryName);
        if (libraryNameErr) {
            setLibraryNameError(libraryNameErr);
            hasError = true;
        }

        if (formData.packageName.length < 2) {
            setPackageNameError("Package name must be at least 2 characters");
            setIsPackageInfoExpanded(true);
            hasError = true;
        } else {
            const pkgError = validatePackageName(formData.packageName, formData.libraryName);
            if (pkgError) {
                setPackageNameError(pkgError);
                setIsPackageInfoExpanded(true);
                hasError = true;
            }
        }

        if (!currentPath || currentPath.trim().length < 2) {
            setPathError("Please select a path for your library");
            hasError = true;
        }

        if (orgNameError) {
            setIsPackageInfoExpanded(true);
            hasError = true;
        }

        if (hasError) {
            setIsValidating(false);
            return;
        }

        try {
            const validationResult = await wsClient.validateProjectPath({
                projectPath: currentPath,
                projectName: formData.packageName,
                directoryName,
                createDirectory: true,
                createAsWorkspace: false,
                allowExistingDirectory: true,
            });

            if (!validationResult.isValid) {
                if (validationResult.errorField === ValidateProjectFormErrorField.PATH) {
                    setPathError(validationResult.errorMessage || "Invalid library path");
                } else if (validationResult.errorField === ValidateProjectFormErrorField.NAME) {
                    setPackageNameError(validationResult.errorMessage || "Invalid package name");
                    setIsPackageInfoExpanded(true);
                }
                setIsValidating(false);
                return;
            }

            const orgHandle = organizations?.find(o => o.handle === formData.orgName)?.handle ||
                sanitizeOrgHandle(formData.orgName)

            await wsClient.createBIProject({
                projectName: formData.libraryName.trim(),
                packageName: formData.packageName,
                projectPath: currentPath,
                directoryName,
                createDirectory: true,
                createAsWorkspace: false,
                orgName: formData.orgName || undefined,
                orgHandle: orgHandle,
                version: formData.version || undefined,
                isLibrary: true,
            });
        } catch (error) {
            setPathError("An error occurred during validation");
        } finally {
            setIsValidating(false);
        }
    };

    return (
        <PageBackdrop>
            <PageContainer>

                <FormPanel>
                    <FormPanelHeader>
                        <HeaderRow>
                            <BackButton type="button" onClick={() => onBack?.()} title="Go back">
                                <Icon
                                    name="arrow-left"
                                    isCodicon
                                    sx={{ width: "16px", height: "16px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                                    iconSx={{ color: "var(--vscode-foreground)", fontSize: "16px", lineHeight: 1 }}
                                />
                            </BackButton>
                            <HeaderText>
                                <HeaderTitle variant="h2">Create Library</HeaderTitle>
                                <HeaderSubtitle>
                                    Build reusable components and utilities to share across projects.
                                </HeaderSubtitle>
                            </HeaderText>
                        </HeaderRow>
                    </FormPanelHeader>
                    <FormBody>
                        <FormContent>
                            <FieldGroup>
                                <TextField
                                    ref={firstFieldRef}
                                    onTextChange={handleLibraryName}
                                    value={formData.libraryName}
                                    label="Library Name"
                                    placeholder="Enter a library name"
                                    required={true}
                                    errorMsg={libraryNameError || ""}
                                />
                            </FieldGroup>

                            <FieldGroup>
                                <DirectorySelector
                                    id="library-folder-selector"
                                    label="Select Path"
                                    placeholder="Browse to select a folder..."
                                    selectedPath={resolvedPath}
                                    required={true}
                                    onSelect={handlePathSelection}
                                    onChange={(value) => {
                                        // The field shows the full target path; its last
                                        // segment is the on-disk folder name (editable and
                                        // decoupled from the package name). Editing it takes
                                        // manual control of the folder so auto-indexing stops.
                                        const { name } = splitPath(value);
                                        const base = extractBase(value, name);
                                        setPathTouched(true);
                                        setEditablePath(base);
                                        setDirTouched(true);
                                        setDirectoryName(name);
                                    }}
                                    onBlur={() => {
                                        if (pathTouched && editablePath !== formData.path) {
                                            setFormData(prev => ({ ...prev, path: editablePath }));
                                        }
                                    }}
                                    errorMsg={pathError || undefined}
                                />
                            </FieldGroup>

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
                                    if (data.packageName !== undefined) {
                                        setPackageNameTouched(data.packageName.length > 0);
                                        if (packageNameError) setPackageNameError(null);
                                    }
                                    setFormData(prev => ({ ...prev, ...data }));
                                }}
                                isLibrary={true}
                                packageNameError={packageNameError}
                                orgNameError={orgNameError}
                                organizations={organizations}
                                hasError={!!(packageNameError || orgNameError)}
                            />

                            <FormFooter>
                                <span title={ballerinaUnavailable ? "Ballerina distribution is not set up. Use Configure to set it up." : undefined}>
                                    <Button
                                        disabled={isValidating || ballerinaUnavailable || !!libraryNameError || !!packageNameError || !!orgNameError || !!pathError}
                                        onClick={handleCreate}
                                        appearance="primary"
                                    >
                                        {isValidating ? "Validating..." : "Create Library"}
                                    </Button>
                                </span>
                            </FormFooter>
                        </FormContent>
                    </FormBody>
                </FormPanel>
            </PageContainer>
        </PageBackdrop>
    );
}
