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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { Icon, ThemeColors, Typography } from "@wso2/ui-toolkit";
import { Stepper } from "@wso2/ui-toolkit/lib/components/Stepper/Stepper";
import {
    PendingIntegrationArtifactPayload,
    ServiceInitModel,
    TriggerModelsResponse,
    ValidateProjectFormErrorField,
} from "@wso2/ballerina-core";
import { useBiWsContext } from "../wsManager/WsClientContext";
import { HeaderRow, HeaderSubtitle, HeaderText, IconButton } from "../ImportIntegration/styles";
import { BackButtonSlot, StepBody, StepPinnedHeader, StepScrollArea, StepSectionLabel, WizardPage, WizardTopBar } from "./styles";
import { joinPath, sanitizePackageName, splitPath, validateComponentName } from "../ProjectForm/utils";
import { ArtifactCard } from "./artifactCatalog";
import { BasicInfo, ProjectContext, ScaffoldState, WizardStep } from "./types";
import { useRealtimeProjectPathValidation } from "./hooks/useRealtimeProjectPathValidation";
import { BasicInfoStep } from "./steps/BasicInfoStep";
import { IntegrationTypeStep } from "./steps/IntegrationTypeStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { WizardFooter } from "./components/WizardFooter";

const ErrorBanner = styled.div`
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 4px;
    border: 1px solid ${ThemeColors.ERROR};
    color: ${ThemeColors.ERROR};
    font-size: 13px;
`;

const WIZARD_STEPS = ["Basics", "Configure"];
const DEFAULT_INTEGRATION_NAME = "Untitled";
const REQUIRED_PATH_MESSAGE = "Path is required";
const INVALID_PATH_MESSAGE = "Please select a valid directory";
const NAME_EXISTS_MESSAGE = "An integration or library with this name already exists in the project";
const MAX_DEFAULT_DIRECTORY_ATTEMPTS = 50;

interface CreateIntegrationWizardProps {
    /** Hide the page header when the embedding host renders its own chrome. */
    showHeader?: boolean;
    /**
     * The project the integration is created into, resolved by the unified Create
     * chooser. When provided, the path is seeded from `workspacePath` (rather than
     * the open folder / default creation path) and the artifact is created inside
     * that workspace — freshly scaffolded when `isNewProject`.
     */
    projectContext?: ProjectContext;
    /**
     * Returns to the chooser (screen 1). When provided, the top-bar back arrow is
     * shown on step 0 too and invokes this instead of decrementing the step.
     */
    onBackToChooser?: () => void;
    /**
     * Renders the wizard to fill a bounded parent (the unified Create shell)
     * instead of the standalone viewport. When true, the self-height-locking
     * layout effect is skipped — the shell already bounds the height, so the
     * pinned-stepper / scrolling-step-body flex layout works directly.
     */
    embedded?: boolean;
}

/**
 * The 3-step Create Integration wizard (Basic Info → Integration Type → Configure).
 *
 * The whole wizard runs pre-project: the package is scaffolded silently on disk
 * when step 3 is entered (so the LS can serve the artifact's config model), and
 * the single `vscode.openFolder` reload happens only at final submit — with the
 * configured artifact persisted as a pending entry the extension generates
 * post-reload. Skipping at any step creates an empty integration.
 */
export function CreateIntegrationWizard({ showHeader = true, projectContext, onBackToChooser, embedded = false }: CreateIntegrationWizardProps) {
    const { wsClient, onBack } = useBiWsContext();

    const [step, setStep] = useState<WizardStep>(0);
    const [basicInfo, setBasicInfo] = useState<BasicInfo>({
        integrationName: DEFAULT_INTEGRATION_NAME,
        baseDir: "",
        directoryName: sanitizePackageName(DEFAULT_INTEGRATION_NAME),
        dirTouched: false,
        pathTouched: false,
    });
    const [nameError, setNameError] = useState<string | null>(null);
    const [pathError, setPathError] = useState<string | null>(null);
    const [existingWorkspace, setExistingWorkspace] = useState(false);
    // Folder names and component titles already used in the target project, so a
    // name the user types can be flagged live if it collides with an existing one.
    const [takenNames, setTakenNames] = useState<{ folders: Set<string>; titles: Set<string> }>(
        { folders: new Set(), titles: new Set() }
    );
    const [triggers, setTriggers] = useState<TriggerModelsResponse | null>(null);
    const [selection, setSelection] = useState<ArtifactCard | null>(null);
    // Service model cached across step navigation (keyed by the selected card),
    // so re-entering step 3 skips the model fetch / package pull.
    const [serviceModelCache, setServiceModelCache] = useState<{ id: string; model: ServiceInitModel } | null>(null);
    const [scaffold, setScaffold] = useState<ScaffoldState>({ status: "idle" });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const scaffoldRef = useRef<ScaffoldState>(scaffold);
    scaffoldRef.current = scaffold;
    const rootRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        // Root cause of the whole-page scroll: the embedding chrome (host
        // CreationView; native panel) sizes its wrappers with `min-height`, so
        // no ancestor has a *definite* height. Our scroll host's `overflow:auto`
        // therefore never engages, and long content grows the document instead
        // of scrolling internally. The fix is to give the scroll host a definite
        // height derived from the viewport (so its overflow engages and it stops
        // growing the page) and lock the document from scrolling as a guarantee.
        // Once the host is bounded, pure CSS flex (WizardPage → StepBody →
        // StepScrollArea) pins the stepper/footer and scrolls only the middle.
        // Embedded in the Create shell: the parent already provides a definite,
        // bounded height, so the flex chain (WizardPage → StepBody → StepScrollArea)
        // scrolls on its own — the viewport height-locking below is not needed and
        // would fight the shell's layout.
        if (embedded) {
            return;
        }

        const root = rootRef.current;
        if (!root) {
            return;
        }

        const findScrollHost = (start: HTMLElement): HTMLElement | null => {
            for (let node = start.parentElement; node && node !== document.body; node = node.parentElement) {
                const overflowY = getComputedStyle(node).overflowY;
                if (overflowY === "auto" || overflowY === "scroll") {
                    return node;
                }
            }
            return null;
        };

        const scrollHost = findScrollHost(root);
        const target = scrollHost ?? root;
        const MIN_HEIGHT = 200;

        // Lock the document itself so the page can never scroll, regardless of
        // any residual overflow from the embedding chrome's paddings/borders.
        const docEl = document.documentElement;
        const body = document.body;
        const prevDocOverflow = docEl.style.overflow;
        const prevBodyOverflow = body.style.overflow;
        docEl.style.overflow = "hidden";
        body.style.overflow = "hidden";

        // Preserve the styles we override on the (host-owned) scroll host.
        const prevHeight = target.style.height;
        const prevFlex = target.style.flex;
        const prevOverflow = target.style.overflow;
        let lastHeight = -1;

        const measure = () => {
            // The target's top is fixed by the chrome above it and does not
            // depend on its own height, so no clear-and-remeasure is needed.
            const top = target.getBoundingClientRect().top;

            // Space below the target that must remain visible (the form panel's
            // bottom border, backdrop bottom padding, etc.) — summed generically
            // from the ancestors' bottom paddings/borders and the nodes' margins.
            let belowChrome = 0;
            for (let node: HTMLElement | null = target; node && node !== body; node = node.parentElement) {
                belowChrome += parseFloat(getComputedStyle(node).marginBottom) || 0;
                const parent = node.parentElement;
                if (!parent) {
                    break;
                }
                const parentStyle = getComputedStyle(parent);
                belowChrome += parseFloat(parentStyle.paddingBottom) || 0;
                belowChrome += parseFloat(parentStyle.borderBottomWidth) || 0;
            }

            const height = Math.max(Math.floor(window.innerHeight - top - belowChrome), MIN_HEIGHT);
            if (height === lastHeight) {
                return;
            }
            lastHeight = height;
            // flex:none stops the flex chain from overriding the fixed height;
            // overflow:hidden hands scrolling to our inner StepScrollArea.
            target.style.flex = "0 0 auto";
            target.style.height = `${height}px`;
            target.style.overflow = "hidden";
        };

        measure();
        // Re-measure after paint settles (fonts / host chrome finishing layout),
        // then keep it correct across viewport resizes. Content changes don't
        // matter — the height is viewport-derived, not content-derived.
        const raf1 = requestAnimationFrame(measure);
        const timer = window.setTimeout(measure, 250);
        window.addEventListener("resize", measure);

        return () => {
            cancelAnimationFrame(raf1);
            window.clearTimeout(timer);
            window.removeEventListener("resize", measure);
            docEl.style.overflow = prevDocOverflow;
            body.style.overflow = prevBodyOverflow;
            target.style.height = prevHeight;
            target.style.flex = prevFlex;
            target.style.overflow = prevOverflow;
        };
    }, [showHeader, embedded]);

    const effectiveName = basicInfo.integrationName.trim() || DEFAULT_INTEGRATION_NAME;
    const packageName = sanitizePackageName(effectiveName) || "untitled";
    // The name-derived default for the directory segment (empty until a name is typed).
    const autoDirectoryName = basicInfo.integrationName.trim() ? sanitizePackageName(basicInfo.integrationName) : "";
    // The folder segment actually used. When the user has taken manual control of
    // the path, it is honored exactly — including an empty segment, which means
    // "create the integration directly in the parent directory" (no new folder).
    // Otherwise it falls back to the name-derived package name.
    const effectiveDirectoryName = basicInfo.dirTouched
        ? basicInfo.directoryName.trim()
        : basicInfo.directoryName.trim() || packageName;
    // Full creation path shown in the path field.
    const fullPath = joinPath(basicInfo.baseDir, basicInfo.directoryName);

    useEffect(() => {
        // Discard any temp staging package left by a previously abandoned session
        // (the unmount cancel can be lost when the embedded remote is torn down
        // before it flushes). Staging lives in the OS temp dir and never touches
        // the user's path, so this is purely housekeeping.
        wsClient
            .cleanupAbandonedIntegrationScaffolds()
            .catch((error: unknown) => console.error(">>> Error cleaning up staging package", error));

        // Seed the path field: prefer the currently open workspace folder (matching
        // the native/embedded project & library forms), falling back to the default
        // creation directory only when no folder is open. The default name/folder
        // is "Untitled"/"untitled"; if the target project already has a component
        // with that folder OR that title, an indexed variant is used for BOTH the
        // name and folder ("Untitled_2" / "untitled_2", …) so the new integration
        // collides with neither an existing folder nor an existing integration name.
        const resolveDefaultNameAndDirectory = (
            takenFolders: Set<string>,
            takenTitles: Set<string>
        ): { name: string; directoryName: string } => {
            const nameBase = DEFAULT_INTEGRATION_NAME;
            for (let attempt = 0; attempt < MAX_DEFAULT_DIRECTORY_ATTEMPTS; attempt++) {
                const name = attempt === 0 ? nameBase : `${nameBase}_${attempt + 1}`;
                const directoryName = sanitizePackageName(name);
                if (!takenFolders.has(directoryName.toLowerCase()) && !takenTitles.has(name.trim().toLowerCase())) {
                    return { name, directoryName };
                }
            }
            return { name: nameBase, directoryName: sanitizePackageName(nameBase) };
        };

        // When the chooser resolved a project, the integration lives inside that
        // workspace folder — seed the path from it directly. Otherwise fall back to
        // the open folder / default creation path (standalone wizard entry).
        const seedBaseDir = projectContext?.workspacePath
            ? Promise.resolve(projectContext.workspacePath)
            : wsClient.getWorkspaceRoot().then(async (res: { path: string }) => res.path || (await wsClient.getDefaultCreationPath()).path);

        seedBaseDir
            .then(async (seedPath: string) => {
                // Fetch the project's existing folders + component titles once: used
                // to pick a collision-free default AND to flag name collisions live.
                let takenFolders = new Set<string>();
                let takenTitles = new Set<string>();
                try {
                    const taken = await wsClient.getProjectComponentNames({ projectPath: seedPath });
                    takenFolders = new Set((taken?.folders ?? []).map((f: string) => f.toLowerCase()));
                    takenTitles = new Set((taken?.titles ?? []).map((t: string) => t.trim().toLowerCase()));
                } catch (error) {
                    console.error(">>> Error fetching existing component names", error);
                }
                setTakenNames({ folders: takenFolders, titles: takenTitles });
                const { name, directoryName } = resolveDefaultNameAndDirectory(takenFolders, takenTitles);
                setBasicInfo((prev) => (prev.baseDir ? prev : { ...prev, baseDir: seedPath, integrationName: name, directoryName }));
            })
            .catch((error: unknown) => console.error(">>> Error seeding the creation path", error));

        wsClient
            .getTriggerModels({ query: "" })
            .then((res) => setTriggers(res))
            .catch((error: unknown) => console.error(">>> Error fetching trigger models", error));
    }, [wsClient, projectContext?.workspacePath]);

    useEffect(() => {
        // Leaving the wizard discards the temp staging package (best-effort;
        // the mount-time sweep is the race-free backstop).
        return () => {
            if (scaffoldRef.current.status === "ready") {
                wsClient.cancelIntegrationWizard({}).catch(() => { });
            }
        };
    }, [wsClient]);

    useRealtimeProjectPathValidation({
        wsClient,
        projectPath: basicInfo.baseDir,
        projectName: packageName,
        createAsWorkspace: false,
        // Validate as soon as there is a real target — i.e. once the path has been
        // seeded and a directory segment is present, even before the path is
        // edited — so a "directory already exists" conflict surfaces live under
        // the path field. Gated on baseDir too so the default "Untitled" name
        // doesn't flash a "Path is required" error before seeding resolves.
        pathTouched:
            basicInfo.pathTouched ||
            (basicInfo.baseDir.trim().length > 0 && basicInfo.directoryName.trim().length > 0),
        requiredPathMessage: REQUIRED_PATH_MESSAGE,
        invalidPathMessage: INVALID_PATH_MESSAGE,
        onPathErrorChange: useCallback((error: string | null) => setPathError(error), []),
        onExistingWorkspaceChange: useCallback((isWorkspace: boolean) => setExistingWorkspace(isWorkspace), []),
        directoryName: effectiveDirectoryName,
        // The path field is the exact project root — allow creating into an
        // existing (non-Ballerina) directory instead of forcing a new folder.
        allowExistingDirectory: true,
    });

    /** Returns a diagnostic when the name collides with an existing integration or
     *  library in the target project (by folder or by title), else null. */
    const checkNameCollision = (value: string): string | null => {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const folder = sanitizePackageName(trimmed);
        if (takenNames.folders.has(folder.toLowerCase()) || takenNames.titles.has(trimmed.toLowerCase())) {
            return NAME_EXISTS_MESSAGE;
        }
        return null;
    };

    /** Integration name change — also re-derives the directory segment while the
     *  user has not taken manual control of it. */
    const handleNameChange = (value: string) => {
        setBasicInfo((prev) => ({
            ...prev,
            integrationName: value,
            directoryName: prev.dirTouched
                ? prev.directoryName
                : value.trim()
                    ? sanitizePackageName(value)
                    : "",
        }));
        setNameError(validateComponentName(value, false) || checkNameCollision(value));
    };

    /** Path field edit — re-split into parent directory + directory name. Editing
     *  the last segment away from the name-derived default takes manual control of
     *  it (so subsequent name edits no longer overwrite it). */
    const handlePathChange = (value: string) => {
        const { base, name } = splitPath(value);
        setBasicInfo((prev) => ({
            ...prev,
            baseDir: base,
            directoryName: name,
            dirTouched: name !== autoDirectoryName,
            pathTouched: true,
        }));
    };

    const handleBrowse = async () => {
        try {
            const res = await wsClient.selectFileOrDirPath({});
            if (res?.path) {
                setBasicInfo((prev) => ({ ...prev, baseDir: res.path, pathTouched: true }));
            }
        } catch (error) {
            console.error(">>> Error selecting directory", error);
        }
    };

    /** Submit-time path check shared by Continue and every skip path. */
    const validatePathForSubmit = async (): Promise<boolean> => {
        const trimmedPath = basicInfo.baseDir.trim();
        if (!trimmedPath) {
            setPathError(REQUIRED_PATH_MESSAGE);
            return false;
        }
        try {
            const result = await wsClient.validateProjectPath({
                projectPath: trimmedPath,
                projectName: packageName,
                createDirectory: true,
                directoryName: effectiveDirectoryName,
                allowExistingDirectory: true,
            });
            if (!result.isValid) {
                if (result.errorField === ValidateProjectFormErrorField.NAME) {
                    setNameError(result.errorMessage || "Invalid integration name");
                } else {
                    setPathError(result.errorMessage || INVALID_PATH_MESSAGE);
                }
                setStep(0);
                return false;
            }
            return true;
        } catch (error) {
            console.error(">>> Error validating project path", error);
            setPathError(INVALID_PATH_MESSAGE);
            setStep(0);
            return false;
        }
    };

    const validateBasicInfo = (): boolean => {
        const nameValidation = basicInfo.integrationName.trim()
            ? (validateComponentName(basicInfo.integrationName, false) || checkNameCollision(basicInfo.integrationName))
            : null;
        setNameError(nameValidation);
        return !nameValidation;
    };

    /**
     * Ensures the throwaway staging package (for the Configure step's model
     * fetching) exists. It is name/path agnostic, so it is created once and reused
     * for the rest of the session — back-navigation and name changes need no
     * re-scaffold.
     */
    const ensureScaffold = async () => {
        if (scaffold.status === "ready" || scaffold.status === "creating") {
            return;
        }
        setScaffold({ status: "creating" });
        try {
            const res = await wsClient.scaffoldIntegrationProject({});
            setScaffold({ status: "ready", projectRoot: res.projectRoot });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(">>> Error preparing the integration form", error);
            setScaffold({ status: "error", error: `Failed to set up the integration: ${message}` });
        }
    };

    /** Step 1 → 2: the name and artifact type are captured together on the first
     *  step, so validate the name (and, when standalone, the path) and require a
     *  selection before advancing to Configure. */
    const handleContinueToConfigure = async () => {
        if (!basicInfo.integrationName.trim()) {
            setNameError("Integration name is required");
            return;
        }
        if (!validateBasicInfo() || !selection) {
            return;
        }
        // Embedded in the Create flow the project (location) was already validated
        // by the chooser; only the standalone wizard owns and re-validates the path.
        if (!embedded && !(await validatePathForSubmit())) {
            return;
        }
        setStep(1);
        void ensureScaffold();
    };

    /** Final submit — with an artifact after Configure, without one on any skip.
     *  The real project is created fresh at the final path here (and only here);
     *  the standalone wizard re-validates the path (the embedded flow trusts the
     *  chooser's validation). */
    const handleCreateIntegration = async (artifact?: PendingIntegrationArtifactPayload) => {
        setSubmitError(null);
        if (!embedded && !(await validatePathForSubmit())) {
            return;
        }
        setIsSubmitting(true);
        try {
            await wsClient.createIntegration({
                project: {
                    integrationName: effectiveName,
                    packageName,
                    projectPath: basicInfo.baseDir.trim(),
                    directoryName: effectiveDirectoryName,
                    newProject: projectContext?.isNewProject,
                    workspaceName: projectContext?.workspaceName,
                },
                artifact,
            });
            // The extension opens the project (window reload) — keep the wizard
            // in its submitting state until teardown.
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(">>> Error creating integration", error);
            setSubmitError(`Failed to create the integration: ${message}`);
            setIsSubmitting(false);
        }
    };

    return (
        <WizardPage ref={rootRef} embedded={embedded}>
            {showHeader && (
                <HeaderRow>
                    <IconButton type="button" onClick={onBack} title="Go back">
                        <Icon
                            name="arrow-left"
                            isCodicon
                            sx={{ width: "16px", height: "16px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                            iconSx={{ color: "var(--vscode-foreground)", fontSize: "16px", lineHeight: 1 }}
                        />
                    </IconButton>
                    <HeaderText>
                        <Typography variant="h2" sx={{ margin: 0, fontWeight: 600 }}>
                            Create Integration
                        </Typography>
                        <HeaderSubtitle>Start building a new integration.</HeaderSubtitle>
                    </HeaderText>
                </HeaderRow>
            )}
            <WizardTopBar>
                {(step > 0 || onBackToChooser) && (
                    <BackButtonSlot>
                        <IconButton
                            type="button"
                            onClick={() => (step > 0 ? setStep((step - 1) as WizardStep) : onBackToChooser?.())}
                            disabled={isSubmitting}
                            title={step > 0 ? "Previous step" : "Back"}
                        >
                            <Icon
                                name="arrow-left"
                                isCodicon
                                sx={{ width: "16px", height: "16px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                                iconSx={{ color: "var(--vscode-foreground)", fontSize: "16px", lineHeight: 1 }}
                            />
                        </IconButton>
                    </BackButtonSlot>
                )}
                <Stepper alignment="center" steps={WIZARD_STEPS} currentStep={step} />
            </WizardTopBar>
            <StepBody>
                {step === 0 && (
                    <StepPinnedHeader>
                        <BasicInfoStep
                            integrationName={basicInfo.integrationName}
                            fullPath={fullPath}
                            nameError={nameError}
                            pathError={pathError}
                            existingWorkspace={existingWorkspace}
                            onNameChange={handleNameChange}
                            onPathChange={handlePathChange}
                            onBrowse={handleBrowse}
                            hidePath={embedded}
                        />
                        <StepSectionLabel>Select the type of integration to build</StepSectionLabel>
                    </StepPinnedHeader>
                )}
                <StepScrollArea>
                    {step === 0 && (
                        <IntegrationTypeStep
                            triggers={triggers}
                            selection={selection}
                            onSelect={(card) => {
                                if (card.id !== selection?.id) {
                                    setServiceModelCache(null);
                                }
                                setSelection(card);
                            }}
                        />
                    )}
                    {step === 1 && selection && (
                        <ConfigureStep
                            wsClient={wsClient}
                            selection={selection}
                            scaffold={scaffold}
                            isSubmitting={isSubmitting}
                            cachedServiceModel={serviceModelCache?.id === selection.id ? serviceModelCache.model : null}
                            onServiceModelLoaded={(model) => setServiceModelCache({ id: selection.id, model })}
                            onSubmit={(artifact) => handleCreateIntegration(artifact)}
                        />
                    )}
                </StepScrollArea>
                {submitError && <ErrorBanner>{submitError}</ErrorBanner>}
                {step === 0 && (
                    <WizardFooter
                        primaryLabel="Continue"
                        onPrimary={handleContinueToConfigure}
                        primaryDisabled={isSubmitting || !!nameError || (!embedded && !!pathError) || !selection}
                        skipLabel="Create Empty Integration"
                        onSkip={() => handleCreateIntegration()}
                        skipDisabled={isSubmitting || !!nameError || (!embedded && !!pathError)}
                    />
                )}
            </StepBody>
        </WizardPage>
    );
}

export default CreateIntegrationWizard;
