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

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import debounce from "lodash/debounce";
import styled from "@emotion/styled";
import { Button, DirectorySelector, Icon, TextField } from "@wso2/ui-toolkit";
import { useVisualizerContext } from "./context/WsClientContext";
import {
    joinPath,
    splitPath,
    sanitizePackageName,
    validateProjectName,
} from "./utils";
import { useRealtimeProjectPathValidation } from "./useRealtimeProjectPathValidation";
import { FieldGroup } from "./styles";
import { DEFAULT_PROJECT_NAME } from "./types";
import { CreateFlowShell } from "./shared/CreateFlowShell";
import { FormFooter } from "./shared/FormPageLayout";
import { useDirectoryNameCoupling } from "../../hooks/useDirectoryNameCoupling";
import { LibraryCreationView } from "./LibraryCreationView";
import { ProjectTypeSelector } from "../../components";
import { CreateIntegrationWizard } from "../../../CreateIntegrationWizard";
import { ProjectContext } from "../../../CreateIntegrationWizard/types";
import { BiWsClient } from "../../../wsManager/WsClient";
import { BiWsClientProvider } from "../../../wsManager/WsClientContext";

const InfoNote = styled.div`
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-descriptionForeground);
`;

/** A group of related fields, separated by generous whitespace rather than a
 *  hard divider so the form reads as a couple of calm sections. */
const Section = styled.section`
    & + & {
        margin-top: 32px;
    }
`;

/** Which screen of the Create flow is showing. */
type Screen = "chooser" | "integration" | "library";

interface CreateProjectChooserProps {
    /** The wizard client (native BI WS) used by the integration route. */
    biWsClient: BiWsClient;
    ballerinaUnavailable?: boolean;
    /** Exit the whole Create flow (back to the welcome view). */
    onBack?: () => void;
}

/**
 * Screen 1 of the unified Create flow: choose (or create) the project and the
 * starting point (integration or library), then route to the 3-step integration
 * wizard or the library form — all inside one shared shell so the flow feels
 * continuous.
 *
 * The Default project (`<defaultLocation>/default`) is pre-selected: if it already
 * exists the new artifact is added into it; otherwise it is created on submit.
 * Editing the name/location or choosing an existing project retargets it, and
 * whether the target is an existing project or a new one is detected live and
 * surfaced under the location field.
 */
export function CreateProjectChooser({ biWsClient, ballerinaUnavailable, onBack }: CreateProjectChooserProps) {
    const { wsClient } = useVisualizerContext();
    const firstFieldRef = useRef<HTMLInputElement>(null);
    const defaultPathInitialized = useRef(false);
    const projectNameTouchedRef = useRef(false);

    const [screen, setScreen] = useState<Screen>("chooser");
    const [isLibrary, setIsLibrary] = useState(false);

    const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
    const dirCoupling = useDirectoryNameCoupling(() => sanitizePackageName(DEFAULT_PROJECT_NAME), sanitizePackageName);
    const { directoryName, dirTouched } = dirCoupling;
    const [defaultPath, setDefaultPath] = useState("");
    const [editablePath, setEditablePath] = useState("");
    const [pathTouched, setPathTouched] = useState(false);
    const [projectNameError, setProjectNameError] = useState<string | null>(null);
    const [pathError, setPathError] = useState<string | null>(null);
    const [existingWorkspace, setExistingWorkspace] = useState(false);

    const debouncedSetProjectNameError = useMemo(
        () => debounce((error: string) => setProjectNameError(error), 300),
        []
    );

    const autoDirectoryName = projectName.trim() ? sanitizePackageName(projectName) : "";
    const effectiveDirectoryName = dirTouched ? directoryName.trim() : (directoryName.trim() || autoDirectoryName);
    const resolvedPath = editablePath ? joinPath(editablePath, effectiveDirectoryName) : "";

    // Seed the Default project location once (`<defaultLocation>/default`). The
    // realtime validation then reports whether it already exists (add into it) or
    // is new (created on submit).
    useEffect(() => {
        let mounted = true;
        (async () => {
            if (defaultPathInitialized.current) return;
            try {
                const { path: workspacePath } = await wsClient.getWorkspaceRoot();
                if (!mounted) return;
                const dp = workspacePath || (await wsClient.getDefaultCreationPath()).path;
                if (!mounted) return;
                defaultPathInitialized.current = true;
                setDefaultPath(dp);
                setEditablePath(dp);

                // If the default project already exists, show its real name (from its
                // Ballerina.toml) instead of the "Default" placeholder — matching what
                // Browse does. The folder stays "default"; only the display name changes.
                const defaultProjectPath = joinPath(dp, directoryName);
                const info = await wsClient.getExistingProjectInfo({ projectPath: defaultProjectPath });
                if (!mounted) return;
                if (info?.isProject && info.name && !projectNameTouchedRef.current) {
                    setProjectName(info.name);
                    dirCoupling.setDirTouched(true);
                }
            } catch (error) {
                console.error("Failed to fetch default path:", error);
            }
        })();
        return () => { mounted = false; };
    }, [wsClient]);

    useEffect(() => {
        if (screen !== "chooser") return;
        setTimeout(() => {
            const inner = (firstFieldRef.current as any)?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
            inner?.focus();
            inner?.select();
        }, 0);
    }, [screen]);

    useEffect(() => {
        const error = validateProjectName(projectName);
        if (!error) {
            debouncedSetProjectNameError.cancel();
            setProjectNameError(null);
            return;
        }
        debouncedSetProjectNameError(error);
        return () => debouncedSetProjectNameError.cancel();
    }, [projectName]);

    useRealtimeProjectPathValidation({
        wsClient,
        projectPath: editablePath,
        projectName,
        // Validate as a component target (not a brand-new workspace) so an existing
        // project at the location is ALLOWED and reported via `existingWorkspace`
        // (add into it) rather than blocked.
        createAsWorkspace: false,
        pathTouched: pathTouched || (editablePath.trim().length > 0 && effectiveDirectoryName.length > 0),
        requiredPathMessage: "Please select a location for your project",
        invalidPathMessage: "Invalid project location",
        onPathErrorChange: useCallback((error: string | null) => setPathError(error), []),
        onExistingWorkspaceChange: useCallback((isWorkspace: boolean) => setExistingWorkspace(isWorkspace), []),
        directoryName: effectiveDirectoryName,
        allowExistingDirectory: true,
    });

    const handleNameChange = (value: string) => {
        projectNameTouchedRef.current = true;
        setProjectName(value);
        // Editing the name (re)couples the folder to it — so renaming a browsed
        // existing project retargets to a NEW project at <parent>/<derived-name>.
        dirCoupling.handleDisplayNameChange(value, { recouple: true });
    };

    const handlePathChange = (value: string) => {
        const { base, name } = splitPath(value);
        setPathTouched(true);
        setEditablePath(base);
        dirCoupling.handleDirectoryNameEdit(name, autoDirectoryName);
    };

    /**
     * Browse for the project folder. The picked folder IS the project location
     * (its parent + its own name — not an appended, name-derived subfolder). If it
     * is an existing project, its real name is shown
     * and it is used as-is; otherwise it becomes a new project at that path.
     * Editing the name afterwards retargets to a new sibling project.
     */
    const handlePathSelection = async () => {
        try {
            const result = await wsClient.selectFileOrDirPath({ startPath: resolvedPath || editablePath || defaultPath });
            if (!result.path) return;
            const { base, name: folderName } = splitPath(result.path);
            const info = await wsClient.getExistingProjectInfo({ projectPath: result.path });
            projectNameTouchedRef.current = true;
            setEditablePath(base);
            dirCoupling.setDirectoryName(folderName);
            setProjectName(info?.isProject ? (info.name || folderName) : folderName);
            dirCoupling.setDirTouched(true);
            setPathTouched(true);
        } catch (error) {
            console.error("Failed to select path:", error);
            setPathError("Failed to select the project folder. Please try again.");
        }
    };

    const startingPointNoun = isLibrary ? "library" : "integration";

    /** The resolved project the wizard / library form creates the artifact into. */
    const projectContext: ProjectContext = {
        isNewProject: !existingWorkspace,
        workspacePath: resolvedPath,
        workspaceName: projectName.trim() || DEFAULT_PROJECT_NAME,
    };

    const canProceed =
        !projectNameError && !pathError && !!projectName.trim() && !!editablePath && !!effectiveDirectoryName;

    const handleNext = () => {
        if (!canProceed) return;
        setScreen(isLibrary ? "library" : "integration");
    };

    if (screen === "integration") {
        return (
            <CreateFlowShell
                title="New Integration"
                subtitle={`In project ${projectName.trim() || DEFAULT_PROJECT_NAME}`}
                onBack={() => setScreen("chooser")}
                bodyFill
            >
                <BiWsClientProvider wsClient={biWsClient} onBack={onBack}>
                    <CreateIntegrationWizard embedded showHeader={false} projectContext={projectContext} />
                </BiWsClientProvider>
            </CreateFlowShell>
        );
    }

    if (screen === "library") {
        return (
            <CreateFlowShell
                title="New Library"
                subtitle={`In project ${projectName.trim() || DEFAULT_PROJECT_NAME}`}
                onBack={() => setScreen("chooser")}
            >
                <LibraryCreationView embedded projectContext={projectContext} ballerinaUnavailable={ballerinaUnavailable} />
            </CreateFlowShell>
        );
    }

    return (
        <CreateFlowShell
            title="Create"
            subtitle="A project helps you organize your integrations and libraries."
            onBack={onBack}
        >
            <Section>
                <FieldGroup>
                    <TextField
                        ref={firstFieldRef}
                        onTextChange={handleNameChange}
                        value={projectName}
                        label="Project name"
                        placeholder="Enter a project name"
                        required={true}
                        errorMsg={projectNameError || ""}
                    />
                </FieldGroup>

                <FieldGroup>
                    <DirectorySelector
                        id="project-location-selector"
                        label="Location"
                        placeholder="Browse to select a location..."
                        selectedPath={resolvedPath}
                        required={true}
                        onSelect={handlePathSelection}
                        onChange={handlePathChange}
                        errorMsg={pathError || undefined}
                    />
                    {!pathError && resolvedPath && (
                        <InfoNote>
                            <Icon name="info" isCodicon sx={{ marginTop: "1px" }} />
                            <span>
                                {existingWorkspace
                                    ? <>This is an existing project. Your new {startingPointNoun} will be added here.</>
                                    : <>A new project will be created at this location.</>}
                            </span>
                        </InfoNote>
                    )}
                </FieldGroup>
            </Section>

            <Section>
                <ProjectTypeSelector
                    label="Choose your starting point"
                    value={isLibrary}
                    onChange={setIsLibrary}
                    note="This is just your starting point. You can add more integrations and libraries to the project later."
                />
            </Section>

            <FormFooter>
                <span title={ballerinaUnavailable ? "Ballerina distribution is not set up. Use Configure to set it up." : undefined}>
                    <Button
                        disabled={ballerinaUnavailable || !canProceed}
                        onClick={handleNext}
                        appearance="primary"
                    >
                        Next
                    </Button>
                </span>
            </FormFooter>
        </CreateFlowShell>
    );
}

export default CreateProjectChooser;
