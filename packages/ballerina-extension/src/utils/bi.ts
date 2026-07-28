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
import { commands, workspace, Uri } from "vscode";
import * as fs from 'fs';
import * as os from 'os';
import path from "path";
import {
    AddProjectToWorkspaceRequest,
    BallerinaProjectComponents,
    ComponentRequest,
    CreateComponentResponse,
    createFunctionSignature,
    EVENT_TYPE,
    isPathInside,
    MigrateRequest,
    NodePosition,
    ProjectMigrationResult,
    ProjectRequest,
    STModification,
    SyntaxTreeResponse,
    WorkspaceTomlValues,
    ValidateProjectFormErrorField,
    SuggestedProjectDefaultsResponse
} from "@wso2/ballerina-core";
import { StateMachine, history, openView } from "../stateMachine";
import { applyModifications, modifyFileContent, writeBallerinaFileDidOpen } from "./modification";
import { ModulePart, STKindChecker } from "@wso2/syntax-tree";
import { URI } from "vscode-uri";
import { debug } from "./logger";
import { parse } from "@iarna/toml";
import { getProjectTomlValues, VALIDATOR_PACKAGE_NAME } from "./config";
import { extension } from "../BalExtensionContext";
import { scheduleMigrationEnhancement, writeEnhanceToml } from "../features/ai/migration/orchestrator";
import { runBackgroundTerminalCommand } from "./runCommand";
import { stringify as stringifyYaml } from "yaml";

export const README_FILE = "README.md";
export const FUNCTIONS_FILE = "functions.bal";
export const DATA_MAPPING_FILE = "data_mappings.bal";

/**
 * Interface for the processed project information
 */
interface ProcessedProjectInfo {
    sanitizedPackageName: string;
    projectRoot: string;
    finalOrgName: string;
    finalVersion: string;
    packageName: string;
    integrationName: string;
    orgHandle: string;
}

const settingsJsonContent = `
{
    "ballerina.isBI": true
}
`;

const launchJsonContent = `
{
    // Use IntelliSense to learn about possible attributes.
    // Hover to view descriptions of existing attributes.
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Ballerina Debug",
            "type": "ballerina",
            "request": "launch",
            "programArgs": [],
            "commandOptions": [],
            "env": {}
        },
        {
            "name": "Ballerina Test",
            "type": "ballerina",
            "request": "launch",
            "debugTests": true,
            "programArgs": [],
            "commandOptions": [],
            "env": {}
        },
        {
            "name": "Ballerina Remote",
            "type": "ballerina",
            "request": "attach",
            "debuggeeHost": "127.0.0.1",
            "debuggeePort": "5005"
        }
    ]
}
`;

const gitignoreContent = `
# Ballerina generates this directory during the compilation of a package.
# It contains compiler-generated artifacts and the final executable if this is an application package.
target/

# Ballerina maintains the compiler-generated source code here.
# Remove this if you want to commit generated sources.
generated/

# Contains configuration values used during development time.
# See https://ballerina.io/learn/provide-values-to-configurable-variables/ for more details.
Config.toml

# File used to enable development-time tracing.
# This should not be committed to version control.
trace_enabled.bal
`;

export function getUsername(): string {
    // Get current username from the system across different OS platforms
    let username: string;
    if (process.platform === 'win32') {
        // Windows
        username = process.env.USERNAME || 'myOrg';
    } else {
        // macOS and Linux
        username = process.env.USER || 'myOrg';
    }
    return username;
}

/**
 * Validates the project path before creating a new project
 * @param projectPath - The directory path where the project will be created
 * @param projectName - The name of the project (used if createDirectory is true). For workspace projects, this contains the workspace name.
 * @param createDirectory - Whether a new directory will be created
 * @param createAsWorkspace - Whether this is a workspace project creation
 * @returns Validation result with error message and field information if invalid
 */
/**
 * Classifies the Ballerina project rooted at `dir` by inspecting its
 * `Ballerina.toml`. A `[workspace]` section marks a multi-package workspace
 * (what the UI calls a "project"); a `[package]` section marks a single
 * integration or library package. Returns `null` when there is no readable
 * Ballerina.toml at `dir`.
 */
function classifyBallerinaProject(dir: string): 'workspace' | 'package' | null {
    const ballerinaTomlPath = path.join(dir, 'Ballerina.toml');
    if (!fs.existsSync(ballerinaTomlPath)) {
        return null;
    }
    try {
        const tomlData = parse(fs.readFileSync(ballerinaTomlPath, 'utf8')) as { workspace?: unknown; package?: unknown };
        if (tomlData?.workspace) {
            return 'workspace';
        }
        return 'package';
    } catch {
        // A Ballerina.toml exists but could not be parsed — treat the directory as an
        // occupied Ballerina package so we never create a new project on top of it.
        return 'package';
    }
}

export interface EnclosingProjectStatus {
    /**
     * 'none' — no ancestor Ballerina.toml found; the package is genuinely standalone.
     * 'member' — the nearest ancestor is a workspace and this package IS listed in
     *     its `packages` — already a project member, just opened in isolation.
     * 'orphaned' — the nearest ancestor is a workspace but this package is NOT
     *     listed — sitting inside a project folder without being registered.
     * 'invalid' — the nearest ancestor Ballerina.toml is itself a `[package]` (a
     *     package nested inside another package) — an already-broken layout.
     */
    status: 'none' | 'member' | 'orphaned' | 'invalid';
    projectPath?: string;
    projectName?: string;
}

/**
 * Walks up from a standalone package's directory looking for an existing Ballerina
 * project it may already be nested inside. Integrations can live at any depth
 * inside a project (`<project>/<pkg>` or `<project>/<subdir>/<pkg>`), so this
 * checks every ancestor in turn rather than only the immediate parent — the first
 * ancestor with a `Ballerina.toml` decides the outcome.
 */
export function getEnclosingProjectStatus(packagePath: string): EnclosingProjectStatus {
    let dir = path.dirname(packagePath);
    let parent = path.dirname(dir);

    while (true) {
        const kind = classifyBallerinaProject(dir);
        if (kind === 'workspace') {
            let packages: string[] = [];
            let title: string | undefined;
            try {
                const tomlData = parse(fs.readFileSync(path.join(dir, 'Ballerina.toml'), 'utf8')) as Partial<WorkspaceTomlValues>;
                packages = tomlData?.workspace?.packages ?? [];
                const rawTitle = (tomlData?.workspace as { title?: unknown } | undefined)?.title;
                if (typeof rawTitle === 'string' && rawTitle.trim()) {
                    title = rawTitle.trim();
                }
            } catch {
                // Unreadable workspace toml — can't confirm membership; treat as orphaned.
            }
            const relativeToProject = path.normalize(path.relative(dir, packagePath));
            const isMember = packages.some((pkg) => path.normalize(pkg) === relativeToProject);
            return {
                status: isMember ? 'member' : 'orphaned',
                projectPath: dir,
                projectName: title ?? path.basename(dir),
            };
        }
        if (kind === 'package') {
            return { status: 'invalid', projectPath: dir };
        }
        if (dir === parent) {
            // Reached the filesystem root without finding a Ballerina.toml.
            return { status: 'none' };
        }
        dir = parent;
        parent = path.dirname(dir);
    }
}

/**
 * Registers an already-existing, orphaned package directory into an enclosing
 * project's workspace `Ballerina.toml` (the `getEnclosingProjectStatus` 'orphaned'
 * case) — no files are moved, only the workspace `packages` list is updated.
 */
export function adoptOrphanedPackageIntoProject(packagePath: string, projectPath: string): void {
    const relativeToProject = path.normalize(path.relative(projectPath, packagePath));
    addToWorkspaceToml(projectPath, relativeToProject);
}

/**
 * Inspects a directory the user picked as an "existing project" (via the Create
 * chooser's "Open an existing project" action). Returns whether it is a Ballerina
 * workspace — what the UI calls a project — and, when it is, its display name read
 * from the workspace `Ballerina.toml` `[workspace].title`, falling back to the
 * folder name.
 */
export function getExistingProjectInfo(dir: string): { isProject: boolean; name?: string; path: string } {
    if (!dir || classifyBallerinaProject(dir) !== 'workspace') {
        return { isProject: false, path: dir };
    }

    let name: string | undefined;
    try {
        const tomlData = parse(fs.readFileSync(path.join(dir, 'Ballerina.toml'), 'utf8')) as Partial<WorkspaceTomlValues>;
        const title = (tomlData?.workspace as { title?: unknown } | undefined)?.title;
        if (typeof title === 'string' && title.trim()) {
            name = title.trim();
        }
    } catch (error) {
        console.warn('Failed to read project name from Ballerina.toml:', error);
    }

    return { isProject: true, name: name ?? path.basename(dir), path: dir };
}

/**
 * Gathers the folder names and component titles already in use within a project
 * directory, so a default integration/library name AND folder can be chosen that
 * collides with neither. `folders` covers on-disk subdirectories plus any packages
 * registered in the workspace `Ballerina.toml`; `titles` are the `[package].title`
 * values read from each package's `Ballerina.toml`. Returns empty lists for a
 * brand-new project directory that does not exist yet.
 */
export function getProjectComponentNames(projectPath: string): { folders: string[]; titles: string[] } {
    const folders = new Set<string>();
    const titles: string[] = [];
    if (!projectPath) {
        return { folders: [], titles };
    }

    // On-disk subdirectories directly under the project.
    try {
        for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                folders.add(entry.name);
            }
        }
    } catch {
        // The project directory does not exist yet (a brand-new project) — nothing taken.
    }

    if (classifyBallerinaProject(projectPath) === 'workspace') {
        try {
            const tomlData = parse(fs.readFileSync(path.join(projectPath, 'Ballerina.toml'), 'utf8')) as Partial<WorkspaceTomlValues>;
            for (const pkg of tomlData?.workspace?.packages ?? []) {
                folders.add(path.basename(path.normalize(pkg)));
            }
        } catch {
            // Unreadable workspace toml — rely on the on-disk folders gathered above.
        }
        // Read each package folder's `[package].title`.
        for (const folder of folders) {
            try {
                const pkgToml = parse(fs.readFileSync(path.join(projectPath, folder, 'Ballerina.toml'), 'utf8')) as { package?: { title?: unknown } };
                const title = pkgToml?.package?.title;
                if (typeof title === 'string' && title.trim()) {
                    titles.push(title.trim());
                }
            } catch {
                // Not a package folder (or no title) — skip.
            }
        }
    }

    return { folders: Array.from(folders), titles };
}

export function validateProjectPath(
    projectPath: string,
    projectName: string,
    createDirectory: boolean,
    createAsWorkspace?: boolean,
    directoryName?: string,
    allowExistingDirectory?: boolean
): { isValid: boolean; errorMessage?: string; errorField?: ValidateProjectFormErrorField; existingWorkspace?: boolean } {
    try {
        // Check if projectPath is provided and not empty
        if (!projectPath || projectPath.trim() === '') {
            return { isValid: false, errorMessage: 'Project path is required', errorField: ValidateProjectFormErrorField.PATH };
        }

        // For workspace projects, validate workspace name specifically
        if (createAsWorkspace && createDirectory && (!projectName || projectName.trim() === '')) {
            return { isValid: false, errorMessage: 'Project name is required', errorField: ValidateProjectFormErrorField.NAME };
        }

        // Check if the base directory exists
        if (!fs.existsSync(projectPath)) {
            // Check if parent directory exists and we can create the path
            const parentDir = path.dirname(projectPath);
            if (!fs.existsSync(parentDir)) {
                return { isValid: false, errorMessage: 'Directory path does not exist', errorField: ValidateProjectFormErrorField.PATH };
            }
        }

        // Determine the final project path. When the caller supplies an explicit
        // directory name (the editable last path segment, decoupled from the
        // package name), it is used verbatim; otherwise fall back to deriving the
        // folder from the sanitized project name for backwards compatibility.
        const folderSegment = directoryName ?? sanitizeName(projectName);
        const finalPath = createDirectory ? path.join(projectPath, folderSegment) : projectPath;

        // If not creating a new directory, check if the target directory already has a Ballerina project
        if (!createDirectory) {
            const ballerinaTomlPath = path.join(finalPath, 'Ballerina.toml');
            if (fs.existsSync(ballerinaTomlPath)) {
                return { isValid: false, errorMessage: 'Existing Ballerina project detected in the selected directory', errorField: ValidateProjectFormErrorField.PATH };
            }
        } else if (fs.existsSync(finalPath)) {
            // The target directory already exists. When the caller allows creating
            // into an existing directory (the integration wizard/library form, where
            // the path field is the exact project root), the outcome depends on what
            // kind of Ballerina project — if any — already lives there.
            if (allowExistingDirectory) {
                const finalPathKind = classifyBallerinaProject(finalPath);
                if (createAsWorkspace) {
                    // Project creation: a new project can never be created on top of
                    // an existing Ballerina project, integration, or library.
                    if (finalPathKind === 'workspace') {
                        return { isValid: false, errorMessage: 'An Integrator project already exists in the selected directory', errorField: ValidateProjectFormErrorField.PATH };
                    }
                    if (finalPathKind === 'package') {
                        return { isValid: false, errorMessage: 'An integration or library already exists in the selected directory', errorField: ValidateProjectFormErrorField.PATH };
                    }
                } else {
                    // Integration/library creation: adding INTO an existing project
                    // (workspace) is allowed — the new package will be registered in
                    // the workspace. Adding on top of an existing package is not.
                    if (finalPathKind === 'workspace') {
                        return { isValid: true, existingWorkspace: true };
                    }
                    if (finalPathKind === 'package') {
                        return { isValid: false, errorMessage: 'An integration or library already exists in the selected directory', errorField: ValidateProjectFormErrorField.PATH };
                    }
                }
                // finalPath exists but is not a Ballerina project — fall through to
                // the parent-workspace check and write-permission check below.
            } else {
                return { isValid: false, errorMessage: `A directory with this name already exists at the selected location`, errorField: ValidateProjectFormErrorField.PATH};
            }
        }

        // Detect when the new package's parent directory is itself a Ballerina
        // workspace root — the common "browse into an existing project" case, where
        // the new package folder does not exist yet. Only relevant when creating a
        // component into an existing directory (not when creating a new workspace).
        if (allowExistingDirectory && !createAsWorkspace && classifyBallerinaProject(projectPath) === 'workspace') {
            return { isValid: true, existingWorkspace: true };
        }

        // Validate write permission against the nearest EXISTING ancestor. The
        // target and one or more of its parents may not exist yet — e.g. creating a
        // new project folder AND a package inside it in one go (`<base>/default` +
        // `<base>/default/<pkg>`), where `projectPath` itself does not exist —
        // so checking `projectPath` directly would wrongly report "no write
        // permission" simply because the directory has not been created yet.
        let writeCheckDir = projectPath;
        while (writeCheckDir && !fs.existsSync(writeCheckDir)) {
            const parent = path.dirname(writeCheckDir);
            if (parent === writeCheckDir) {
                break;
            }
            writeCheckDir = parent;
        }
        try {
            fs.accessSync(writeCheckDir, fs.constants.W_OK);
        } catch (error) {
            return { isValid: false, errorMessage: 'No write permission for the selected directory', errorField: ValidateProjectFormErrorField.PATH };
        }

        return { isValid: true };
    } catch (error) {
        return { isValid: false, errorMessage: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`, errorField: ValidateProjectFormErrorField.PATH };
    }
}

/**
 * Generic function to resolve directory paths and create directories if needed
 * Can be used for both project and workspace directory creation
 * @param basePath - Base directory path
 * @param directoryName - Name of the directory to create (optional)
 * @param shouldCreateDirectory - Whether to create a new directory
 * @returns The resolved directory path
 */
function resolveDirectoryPath(basePath: string, directoryName?: string, shouldCreateDirectory: boolean = true): string {
    const resolvedPath = directoryName
        ? path.join(basePath, directoryName)
        : basePath;

    if (shouldCreateDirectory && !fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
    }

    return resolvedPath;
}

/**
 * Creates .vscode folder and settings.json file
 * @param projectRoot - Root directory of the project
 */
function createVSCodeSettings(projectRoot: string): void {
    const vscodeDir = path.join(projectRoot, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        // Recursive so it also creates the project root when it does not exist yet.
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    const settingsPath = path.join(vscodeDir, 'settings.json');
    fs.writeFileSync(settingsPath, settingsJsonContent);
}

/**
 * Creates .vscode folder with both settings.json and launch.json files
 * @param projectRoot - Root directory of the project
 */
function createVSCodeSettingsWithLaunch(projectRoot: string): void {
    createVSCodeSettings(projectRoot);

    const vscodeDir = path.join(projectRoot, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    fs.writeFileSync(launchPath, launchJsonContent.trim());
}

/**
 * Resolves the project root path and creates the directory if needed
 * @param projectPath - Base project path
 * @param sanitizedPackageName - Sanitized package name for directory creation
 * @param createDirectory - Whether to create a new directory
 * @returns The resolved project root path
 */
function resolveProjectPath(projectPath: string, sanitizedPackageName: string, createDirectory: boolean): string {
    return resolveDirectoryPath(
        projectPath,
        createDirectory ? sanitizedPackageName : undefined,
        createDirectory
    );
}

/**
 * Resolves the workspace root path and creates the directory
 * @param basePath - Base path where workspace should be created
 * @param workspaceName - Name of the workspace directory
 * @returns The resolved workspace root path
 */
function resolveWorkspacePath(basePath: string, workspaceName: string): string {
    return resolveDirectoryPath(basePath, workspaceName, true);
}

/**
 * Extracts the Ballerina version number from the ballerinaVersion string
 * @returns The version number (e.g., "2201.13.0") or undefined if not available
 */
function getBallerinaDistribution(): string | undefined {
    try {
        const ballerinaVersion = extension.ballerinaExtInstance?.ballerinaVersion;
        if (!ballerinaVersion) {
            return undefined;
        }
        
        // Extract version number from strings like "Ballerina 2201.13.0" or "2201.13.0"
        // Match pattern: <numbers>.<numbers>.<numbers>
        const versionMatch = ballerinaVersion.match(/(\d+\.\d+\.\d+)/);
        return versionMatch ? versionMatch[1] : undefined;
    } catch (error) {
        debug(`Failed to extract Ballerina distribution version: ${error}`);
        return undefined;
    }
}

/**
 * Orchestrates the setup of project information
 * @param projectRequest - The project request containing all necessary information
 * @returns Processed project information ready for use
 */
function setupProjectInfo(projectRequest: ProjectRequest): ProcessedProjectInfo {
    const sanitizedPackageName = sanitizeName(projectRequest.packageName);
    // The folder the project is created in. When the caller provides an explicit
    // directory name (the editable last path segment), it is used verbatim so the
    // directory can differ from the Ballerina package name; otherwise the folder
    // is derived from the package name (legacy behaviour).
    const folderName = projectRequest.directoryName ?? sanitizedPackageName;
    const projectRoot = resolveProjectPath(
        projectRequest.projectPath,
        folderName,
        projectRequest.createDirectory
    );
    const finalOrgName = projectRequest.orgName || getUsername();
    const finalVersion = projectRequest.version || "0.1.0";

    return {
        sanitizedPackageName,
        projectRoot,
        finalOrgName,
        finalVersion,
        packageName: projectRequest.packageName,
        integrationName: projectRequest.projectName,
        orgHandle: projectRequest.orgHandle
    };
}

/**
 * Writes a local context file for the given project.
 * Creates (if missing) `{projectRoot}/.wso2/context.yaml` and stores the org/project handles with `local: true`.
 * @param projectRoot - Absolute path to the project root directory
 * @param orgHandle - Choreo organization handle
 * @param projectHandle - Choreo project handle
 */
export async function writeLocalContextYaml(
    projectRoot: string,
    orgHandle: string,
    projectHandle: string
): Promise<void> {
    try {
        const choreoDir = path.join(projectRoot, '.wso2');
        const localProjectFile = path.join(choreoDir, 'context.yaml');
        const content = stringifyYaml([{ org: orgHandle, project: projectHandle, local: true }]);
        await fs.promises.mkdir(choreoDir, { recursive: true });
        await fs.promises.writeFile(localProjectFile, content, { encoding: 'utf8' });
    } catch (error) {
        console.warn("Failed to write context.yaml (non-critical):", error);
    }
}

export async function createEmptyBIWorkspace(projectRequest: ProjectRequest): Promise<string> {
    const ballerinaTomlContent = `
[workspace]
title = "${projectRequest.workspaceName}"
packages = []

`;

    // Use the workspace-specific directory resolver. The editable directory name
    // (last path segment) is honored when provided so the on-disk folder can differ
    // from the project/workspace name; otherwise fall back to the legacy handle/name.
    const workspaceRoot = resolveWorkspacePath(
        projectRequest.projectPath,
        projectRequest.directoryName ?? projectRequest?.projectHandle ?? projectRequest.workspaceName
    );

    // Create Ballerina.toml file
    const ballerinaTomlPath = path.join(workspaceRoot, 'Ballerina.toml');
    writeBallerinaFileDidOpen(ballerinaTomlPath, ballerinaTomlContent);

    // create settings.json file
    createVSCodeSettings(workspaceRoot);

    console.log(`Project(default profile) created successfully at ${workspaceRoot}`);
    return workspaceRoot;
}

export async function createBIWorkspaceWithProject(projectRequest: ProjectRequest): Promise<string> {
    const ballerinaTomlContent = `
[workspace]
title = "${projectRequest.workspaceName}"
packages = ["${sanitizeName(projectRequest.packageName)}"]

`;

    // Use the workspace-specific directory resolver. The editable directory name
    // (last path segment) is honored when provided so the on-disk folder can differ
    // from the project/workspace name; otherwise fall back to the legacy handle/name.
    const workspaceRoot = resolveWorkspacePath(
        projectRequest.projectPath,
        projectRequest.directoryName ?? projectRequest?.projectHandle ?? projectRequest.workspaceName
    );

    // Create Ballerina.toml file
    const ballerinaTomlPath = path.join(workspaceRoot, 'Ballerina.toml');
    writeBallerinaFileDidOpen(ballerinaTomlPath, ballerinaTomlContent);

    // Create Ballerina Package. The workspace folder is already the target root, so
    // the inner package derives its own folder from the package name (drop the
    // workspace-level directory name to avoid reusing it for the package folder).
    await createBIProjectPure({ ...projectRequest, projectPath: workspaceRoot, directoryName: undefined, createDirectory: true });

    // create settings.json file
    createVSCodeSettings(workspaceRoot);

    console.log(`Project(default profile) with integration created successfully at ${workspaceRoot}`);
    return workspaceRoot;
}

export async function createBIProjectPure(projectRequest: ProjectRequest): Promise<string> {
    const projectInfo = setupProjectInfo(projectRequest);
    const {
        projectRoot,
        finalOrgName,
        finalVersion,
        packageName,
        integrationName,
        orgHandle
    } = projectInfo;

    const EMPTY = "\n";

    // Get the Ballerina distribution version
    const distribution = getBallerinaDistribution();
    
    // Build the distribution line if version is available
    const distributionLine = distribution ? `distribution = "${distribution}"\n` : '';

    const ballerinaTomlContent = `
[package]
org = "${orgHandle ?? finalOrgName}"
name = "${packageName}"
version = "${finalVersion}"
${distributionLine}title = "${integrationName}"

[build-options]
sticky = true

`;

    if (projectRequest.isLibrary) {
        const libraryBal = path.join(projectRoot, 'lib.bal');
        const libraryBalContent = `import ${VALIDATOR_PACKAGE_NAME} as _;`;
        writeBallerinaFileDidOpen(libraryBal, libraryBalContent);
        try {
            await runBackgroundTerminalCommand(`bal pull ${VALIDATOR_PACKAGE_NAME}`);
        } catch (error) {
            console.error('Failed to pull library validator package:', error);
        }
    }

    // Create Ballerina.toml file
    const ballerinaTomlPath = path.join(projectRoot, 'Ballerina.toml');
    writeBallerinaFileDidOpen(ballerinaTomlPath, ballerinaTomlContent);

    // Create connections.bal file
    const connectionsBalPath = path.join(projectRoot, 'connections.bal');
    writeBallerinaFileDidOpen(connectionsBalPath, EMPTY);

    // Create config.bal file
    const configurationsBalPath = path.join(projectRoot, 'config.bal');
    writeBallerinaFileDidOpen(configurationsBalPath, EMPTY);

    // Create types.bal file
    const typesBalPath = path.join(projectRoot, 'types.bal');
    writeBallerinaFileDidOpen(typesBalPath, EMPTY);

    // Create agents.bal file
    const agentsBal = path.join(projectRoot, 'agents.bal');
    writeBallerinaFileDidOpen(agentsBal, EMPTY);

    // Create functions.bal file
    const functionsBal = path.join(projectRoot, 'functions.bal');
    writeBallerinaFileDidOpen(functionsBal, EMPTY);

    // Create datamappings.bal file
    const datamappingsBalPath = path.join(projectRoot, 'data_mappings.bal');
    writeBallerinaFileDidOpen(datamappingsBalPath, EMPTY);

    if (!projectRequest.isLibrary) {
        // Create main.bal file
        const mainBal = path.join(projectRoot, 'main.bal');
        writeBallerinaFileDidOpen(mainBal, EMPTY);

        // Create automation.bal file
        const automationBal = path.join(projectRoot, 'automation.bal');
        writeBallerinaFileDidOpen(automationBal, EMPTY);
    }

    // Create .vscode configuration files
    createVSCodeSettingsWithLaunch(projectRoot);

    // Create .gitignore file
    const gitignorePath = path.join(projectRoot, '.gitignore');
    fs.writeFileSync(gitignorePath, gitignoreContent.trim());

    console.log(`Integration(default profile) created successfully at ${projectRoot}`);
    return projectRoot;
}

export async function convertProjectToWorkspace(params: AddProjectToWorkspaceRequest) {
    const currentProjectPath = StateMachine.context().projectPath;
    const tomlValues = await getProjectTomlValues(currentProjectPath);
    const currentPackageName = tomlValues?.package?.name;
    if (!currentPackageName) {
        throw new Error('No package name found in Ballerina.toml');
    }

    // The destination is user-selectable: `params.path` is the parent location
    // (defaulting to the current integration's parent) and the folder name comes
    // from the editable directory name (falling back to the handle/project name).
    const baseDir = params.path?.trim() ? params.path : path.dirname(currentProjectPath);
    const projectDirectoryName = params.directoryName?.trim() ? params.directoryName : (params.projectHandle ?? params.workspaceName);
    const newDirectory = path.join(baseDir, projectDirectoryName);

    // The current integration is moved into the new project directory, so the
    // destination cannot be the integration itself or a directory inside it.
    if (isPathInside(currentProjectPath, newDirectory)) {
        throw new Error('The project location cannot be inside the integration being converted. Please choose a different location.');
    }

    // A new project can never be created inside an already-existing Ballerina
    // project (workspace or package) — e.g. converting an integration whose real
    // parent directory is itself an unopened project would otherwise nest a new
    // project inside it. `getEnclosingProjectStatus` checks `newDirectory`'s own
    // parent chain, so this also catches a destination pointed AT an ancestor of
    // the current integration. Safety net behind the UI, which should route this
    // case to "Open Project"/"Add to Project" before ever reaching here.
    const enclosing = getEnclosingProjectStatus(newDirectory);
    if (enclosing.status !== 'none') {
        throw new Error(`The selected location is already inside an existing Ballerina project (${enclosing.projectPath}). Choose a location outside that project, or open/add to it instead of converting.`);
    }

    try {
        fs.mkdirSync(newDirectory);
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
            throw new Error(`A directory named "${projectDirectoryName}" already exists at the selected location`);
        }
        throw err;
    }

    const updatedProjectPath = path.join(newDirectory, path.basename(currentProjectPath));
    fs.renameSync(currentProjectPath, updatedProjectPath);

    const existingProjectDirName = path.basename(currentProjectPath);
    createWorkspaceToml(newDirectory, params.workspaceName, existingProjectDirName);

    if (params.addNewAfterConvert) {
        // Resolved AFTER the move above and after `createWorkspaceToml`, so the
        // existing integration's folder is already on disk and listed — the new
        // package can never be scaffolded on top of the one just moved in.
        const packageFolder = resolvePackageFolderInWorkspace(newDirectory, params);
        addToWorkspaceToml(newDirectory, packageFolder);
        await createProjectInWorkspace(params, newDirectory, packageFolder);
    }

    // create settings.json file
    createVSCodeSettings(newDirectory);
    // write local context file
    await writeLocalContextYaml(newDirectory, params.orgHandle, params.projectHandle);

    openInVSCode(newDirectory);
}

export async function addProjectToExistingWorkspace(params: AddProjectToWorkspaceRequest): Promise<void> {
    const workspacePath = StateMachine.context().workspacePath;
    const packageFolder = resolvePackageFolderInWorkspace(workspacePath, params);
    addToWorkspaceToml(workspacePath, packageFolder);

    await createProjectInWorkspace(params, workspacePath, packageFolder);
}

function createWorkspaceToml(workspacePath: string, projectTitle: string, packageName: string) {
    const ballerinaTomlContent = `
[workspace]
title = "${projectTitle}"
packages = ["${packageName}"]
`;
    const ballerinaTomlPath = path.join(workspacePath, 'Ballerina.toml');
    writeBallerinaFileDidOpen(ballerinaTomlPath, ballerinaTomlContent);
}

function addToWorkspaceToml(workspacePath: string, packageName: string) {
    const ballerinaTomlPath = path.join(workspacePath, 'Ballerina.toml');

    if (!fs.existsSync(ballerinaTomlPath)) {
        return;
    }

    try {
        const ballerinaTomlContent = fs.readFileSync(ballerinaTomlPath, 'utf8');
        const tomlData = parse(ballerinaTomlContent) as Partial<WorkspaceTomlValues>;
        const existingPackages: string[] = tomlData?.workspace?.packages ?? [];

        if (existingPackages.includes(packageName)) {
            return; // Package already exists
        }

        const updatedContent = addPackageToToml(ballerinaTomlContent, packageName);
        fs.writeFileSync(ballerinaTomlPath, updatedContent);
    } catch (error) {
        console.error('Failed to update project Ballerina.toml:', error);
    }
}

/**
 * Resolves a collision-free package folder name inside an existing workspace.
 * A candidate is taken when either a directory with that name already exists on
 * disk or the workspace `Ballerina.toml` already lists it. Falls back to the
 * base name after a bounded number of attempts.
 */
function resolveAvailablePackageFolder(workspaceRoot: string, base: string): string {
    const MAX_ATTEMPTS = 50;
    let existingPackages: string[] = [];
    try {
        const tomlPath = path.join(workspaceRoot, 'Ballerina.toml');
        const tomlData = parse(fs.readFileSync(tomlPath, 'utf8')) as Partial<WorkspaceTomlValues>;
        existingPackages = tomlData?.workspace?.packages ?? [];
    } catch {
        // Unreadable workspace toml — fall back to the on-disk check only.
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`;
        const taken = fs.existsSync(path.join(workspaceRoot, candidate))
            || existingPackages.some((p) => path.normalize(p) === candidate);
        if (!taken) {
            return candidate;
        }
    }
    return base;
}

/**
 * Determines whether a component-creation request targets an existing Ballerina
 * workspace, resolving the workspace root and a collision-free package folder to
 * create inside it. Returns null when the target is not inside a workspace (the
 * caller should create a standalone package instead).
 */
function resolveExistingWorkspaceTarget(projectRequest: ProjectRequest): { workspaceRoot: string; packageFolder: string } | null {
    const sanitizedPackageName = sanitizeName(projectRequest.packageName);
    const folderName = projectRequest.directoryName?.trim() || sanitizedPackageName;
    const finalPath = path.join(projectRequest.projectPath, folderName);

    // Case (a): the chosen path itself is a workspace root — the user pointed at
    // the project. Add a new, auto-named package folder inside it.
    if (classifyBallerinaProject(finalPath) === 'workspace') {
        return {
            workspaceRoot: finalPath,
            packageFolder: resolveAvailablePackageFolder(finalPath, sanitizedPackageName),
        };
    }

    // Case (b): the parent directory is a workspace root — the user browsed into
    // the project, leaving the new package folder as the last path segment.
    if (classifyBallerinaProject(projectRequest.projectPath) === 'workspace') {
        return {
            workspaceRoot: projectRequest.projectPath,
            packageFolder: resolveAvailablePackageFolder(projectRequest.projectPath, folderName),
        };
    }

    return null;
}

/**
 * Adds a new integration/library package into an existing Ballerina workspace:
 * scaffolds the package inside the workspace root and registers it in the
 * workspace `Ballerina.toml`. Returns the package root and the workspace root.
 */
async function addComponentToExistingWorkspace(
    workspaceRoot: string,
    packageFolder: string,
    projectRequest: ProjectRequest
): Promise<{ packageRoot: string; workspaceRoot: string }> {
    const request: ProjectRequest = {
        ...projectRequest,
        projectPath: workspaceRoot,
        directoryName: packageFolder,
        createDirectory: true,
    };
    const packageRoot = await createBIProjectPure(request);
    addToWorkspaceToml(workspaceRoot, packageFolder);
    return { packageRoot, workspaceRoot };
}

/**
 * Converts the currently open standalone integration into a new workspace at
 * `projectRequest.projectPath` and creates the requested new integration package
 * inside it. The existing package is moved into the new workspace folder (matching
 * {@link convertProjectToWorkspace}), the workspace `Ballerina.toml` is written
 * listing both packages, then the new configured package is scaffolded and
 * registered. Used by the "Convert to Project & add a new integration" flow so it
 * goes through the same wizard (and pending-artifact reload) as the initial Create
 * experience. Returns the new package root (for pending-artifact scheduling) and
 * the workspace root (to open).
 */
async function convertAndAddComponent(projectRequest: ProjectRequest): Promise<{ packageRoot: string; openRoot: string }> {
    const currentProjectPath = StateMachine.context().projectPath;
    if (!currentProjectPath) {
        throw new Error('No integration is open to convert into a project.');
    }

    const workspaceRoot = projectRequest.projectPath;

    // The current integration is moved into the new project directory, so the
    // destination cannot be the integration itself or a directory inside it.
    if (isPathInside(currentProjectPath, workspaceRoot)) {
        throw new Error('The project location cannot be inside the integration being converted. Please choose a different location.');
    }

    // Never clobber an existing project: converting always creates a fresh workspace.
    const existing = classifyBallerinaProject(workspaceRoot);
    if (existing === 'workspace' || existing === 'package') {
        throw new Error('A project already exists at the selected location');
    }

    // Create the workspace folder and move the current integration inside it.
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const existingProjectDirName = path.basename(currentProjectPath);
    const movedProjectPath = path.join(workspaceRoot, existingProjectDirName);
    fs.renameSync(currentProjectPath, movedProjectPath);

    // Write the workspace toml (listing the moved package) and editor settings.
    createWorkspaceToml(workspaceRoot, projectRequest.workspaceName ?? path.basename(workspaceRoot), existingProjectDirName);
    createVSCodeSettings(workspaceRoot);

    // Scaffold the new configured integration package inside the workspace and
    // register it in the workspace toml (collision-resolved against the moved one).
    const base = projectRequest.directoryName?.trim() || sanitizeName(projectRequest.packageName);
    const packageFolder = resolveAvailablePackageFolder(workspaceRoot, base);
    const { packageRoot } = await addComponentToExistingWorkspace(workspaceRoot, packageFolder, projectRequest);

    return { packageRoot, openRoot: workspaceRoot };
}

/**
 * Scaffolds a brand-new Ballerina workspace at `projectRequest.projectPath` and
 * creates the requested integration/library package inside it. Used by the
 * unified Create flow's always-workspace model: a fresh project (workspace) is
 * created and the new component added as its first package. Returns the package
 * root (for pending-artifact scheduling) and the workspace root (to open).
 */
async function createComponentInNewWorkspace(projectRequest: ProjectRequest): Promise<{ packageRoot: string; openRoot: string }> {
    const workspaceRoot = projectRequest.projectPath;

    // Guard the workspace toml write: never clobber an existing project. If the
    // target is already a workspace (e.g. the pre-existing Default project, or a
    // stale "new" flag), add the package into it instead of rewriting the toml; a
    // package at the target is an error. Only a fresh/non-Ballerina directory gets
    // a new workspace scaffolded.
    const existing = classifyBallerinaProject(workspaceRoot);
    if (existing === 'package') {
        throw new Error('An integration or library already exists at the selected location');
    }
    if (existing !== 'workspace') {
        // Ensure the workspace folder exists before writing into it — for a brand
        // new project neither it nor its parents exist yet (unlike the other
        // workspace helpers, which create it via resolveWorkspacePath).
        fs.mkdirSync(workspaceRoot, { recursive: true });
        const workspaceTomlContent = `
[workspace]
title = "${projectRequest.workspaceName ?? path.basename(workspaceRoot)}"
packages = []

`;
        writeBallerinaFileDidOpen(path.join(workspaceRoot, 'Ballerina.toml'), workspaceTomlContent);
        createVSCodeSettings(workspaceRoot);
    }

    // The package folder is the editable directory name (falling back to the
    // sanitized package name), collision-resolved within the workspace.
    const base = projectRequest.directoryName?.trim() || sanitizeName(projectRequest.packageName);
    const packageFolder = resolveAvailablePackageFolder(workspaceRoot, base);
    const { packageRoot } = await addComponentToExistingWorkspace(workspaceRoot, packageFolder, projectRequest);
    return { packageRoot, openRoot: workspaceRoot };
}

/**
 * Creates a new integration/library package. When `newProject` is set the target
 * path is scaffolded as a fresh workspace and the package created inside it. When
 * the resolved path is inside an existing Ballerina workspace, the package is
 * created within that workspace and registered in its `Ballerina.toml`; otherwise
 * it is created as a standalone package. Returns the package root and the folder
 * to open in the editor (the workspace root when in a workspace, else the package
 * root).
 */
export async function createBIComponent(projectRequest: ProjectRequest): Promise<{ packageRoot: string; openRoot: string }> {
    if (projectRequest.convertToWorkspace) {
        return convertAndAddComponent(projectRequest);
    }
    if (projectRequest.newProject) {
        return createComponentInNewWorkspace(projectRequest);
    }
    const workspaceTarget = resolveExistingWorkspaceTarget(projectRequest);
    if (workspaceTarget) {
        const { packageRoot, workspaceRoot } = await addComponentToExistingWorkspace(
            workspaceTarget.workspaceRoot,
            workspaceTarget.packageFolder,
            projectRequest
        );
        return { packageRoot, openRoot: workspaceRoot };
    }
    const packageRoot = await createBIProjectPure(projectRequest);
    return { packageRoot, openRoot: packageRoot };
}

export function deleteProjectFromWorkspace(workspacePath: string, packagePath: string) {
    const relativeProjectPath = path.relative(workspacePath, packagePath);
    console.log(">>> relative project path", relativeProjectPath);

    const ballerinaTomlPath = path.join(workspacePath, 'Ballerina.toml');
    if (!fs.existsSync(ballerinaTomlPath)) {
        return;
    }
    
    try {
        const ballerinaTomlContent = fs.readFileSync(ballerinaTomlPath, 'utf8');
        const tomlData = parse(ballerinaTomlContent) as Partial<WorkspaceTomlValues>;
        const existingPackages: string[] = tomlData?.workspace?.packages ?? [];

        const matchedEntry = existingPackages.find(p => path.normalize(p) === relativeProjectPath);
        if (!matchedEntry) {
            return; // Package not found
        }

        const updatedContent = removePackageFromToml(ballerinaTomlContent, matchedEntry);
        fs.writeFileSync(ballerinaTomlPath, updatedContent);

        // send didChange event to the language server
        StateMachine.langClient().didChange({
            contentChanges: [
                {
                    text: updatedContent
                }
            ],
            textDocument: {
                uri: Uri.file(ballerinaTomlPath).toString(),
                version: 1
            }
        });

        // delete the project directory
        fs.rmdirSync(packagePath, { recursive: true });
    } catch (error) {
        console.error(">>> error deleting integration from project", error);
    }
}

function addPackageToToml(tomlContent: string, packageName: string): string {
    const packagesRegex = /packages\s*=\s*\[([\s\S]*?)\]/;
    const match = tomlContent.match(packagesRegex);

    if (match) {
        const currentArrayContent = match[1].trim();
        const newArrayContent = currentArrayContent === ''
            ? `"${packageName}"`
            : `${currentArrayContent}, "${packageName}"`;

        return tomlContent.replace(packagesRegex, `packages = [${newArrayContent}]`);
    } else {
        return tomlContent + `\npackages = ["${packageName}"]\n`;
    }
}

function removePackageFromToml(tomlContent: string, packagePath: string): string {
    const packagesRegex = /packages\s*=\s*\[([\s\S]*?)\]/;
    const match = tomlContent.match(packagesRegex);

    if (match) {
        const currentArrayContent = match[1].trim();
        
        // Split by comma, trim whitespace, and filter out the package to remove
        const packages = currentArrayContent
            .split(',')
            .map(pkg => pkg.trim())
            .filter(pkg => pkg && pkg !== `"${packagePath}"`);
        
        const newArrayContent = packages.length > 0 ? packages.join(', ') : '';
        return tomlContent.replace(packagesRegex, `packages = [${newArrayContent}]`);
    } else {
        return tomlContent;
    }
}

/**
 * Scaffolds the new integration/library package inside `workspacePath`.
 *
 * `packageFolder` is the on-disk folder name, resolved by the caller via
 * {@link resolvePackageFolderInWorkspace} — it is deliberately independent of the
 * Ballerina package name, matching how the integration wizard has always worked.
 */
async function createProjectInWorkspace(
    params: AddProjectToWorkspaceRequest,
    workspacePath: string,
    packageFolder: string
): Promise<string> {
    const projectRequest: ProjectRequest = {
        projectName: params.projectName,
        packageName: params.packageName,
        projectPath: workspacePath,
        directoryName: packageFolder,
        createDirectory: true,
        orgName: params.orgName,
        orgHandle: params.orgHandle,
        version: params.version,
        isLibrary: params.isLibrary,
        projectHandle: params.projectHandle
    };

    return await createBIProjectPure(projectRequest);
}

/**
 * Resolves the folder the new package is created in, inside `workspaceRoot`.
 *
 * Prefers the caller-supplied `packageDirectoryName` (derived from the artifact's
 * display name) and falls back to the sanitized package name for older callers that
 * send none. Always passed through {@link resolveAvailablePackageFolder}: the
 * scaffold creates its directory with `mkdir -p`, which silently succeeds on an
 * existing folder and would write over a package already living there, so an
 * unavailable name must be indexed rather than reused. The UI blocks a colliding
 * name well before this point — this is the last line of defence.
 */
function resolvePackageFolderInWorkspace(workspaceRoot: string, params: AddProjectToWorkspaceRequest): string {
    const base = params.packageDirectoryName?.trim() || sanitizeName(params.packageName);
    return resolveAvailablePackageFolder(workspaceRoot, base);
}

/**
 * Whether `projectRoot` is already one of the currently open workspace folders.
 * Exported so callers can choose a live, in-place refresh instead of routing
 * through `openInVSCode` (which reloads the whole window in this case).
 */
export function isAlreadyOpenFolder(projectRoot: string): boolean {
    const resolvedRoot = path.resolve(projectRoot);
    return (workspace.workspaceFolders ?? []).some(
        (folder) => path.resolve(folder.uri.fsPath) === resolvedRoot
    );
}

export function openInVSCode(projectRoot: string) {
    const resolvedRoot = path.resolve(projectRoot);

    // `vscode.openFolder` is a no-op when the target is already the open workspace
    // folder — the window would not reload and any caller awaiting the reload (e.g.
    // the Create Integration wizard) would hang. This happens when the project is
    // created in place inside a directory that is already open. In that case reload
    // the window so the extension re-initialises the folder as a Ballerina project.
    // Callers adding a component into a workspace that is ALREADY open should
    // prefer `isAlreadyOpenFolder` + a live in-place refresh instead of calling
    // this at all — see `createIntegration` in integration-wizard.ts.
    if (isAlreadyOpenFolder(resolvedRoot)) {
        commands.executeCommand('workbench.action.reloadWindow');
        return;
    }

    commands.executeCommand('vscode.openFolder', Uri.file(resolvedRoot));
}

export async function createBIProjectFromMigration(params: MigrateRequest) {
    const projectInfo = setupProjectInfo(params.project);
    const { projectRoot, sanitizedPackageName } = projectInfo;

    const EMPTY = "\n";
    // Write files based on keys in params.textEdits
    for (const [fileName, fileContent] of Object.entries(params.textEdits)) {
        let content = fileContent;
        const filePath = path.join(projectRoot, fileName);

        if (fileName === "Ballerina.toml") {
            if (params.projects && params.projects.length > 0) {
                // Multi-project migration: this is a workspace-level Ballerina.toml ([workspace] section).
                // The packages list from the LS reflects the CLI's directory naming convention,
                // which may differ from the projectName values used to create actual directories.
                // Rebuild the packages list from the actual project names.
                const packageList = params.projects.map(p => `"${p.projectName}"`).join(', ');
                content = content.replace(/packages\s*=\s*\[[\s\S]*?\]/, `packages = [${packageList}]`);
            } else {
                // Single-project migration: this is a package-level Ballerina.toml ([package] section).
                content = content.replace(/name = ".*?"/, `name = "${sanitizedPackageName}"`);
                content = content.replace(/org = ".*?"/, `org = "${projectInfo.orgHandle ?? projectInfo.finalOrgName}"`);

                // Remove any existing distribution line
                content = content.replace(/^\s*distribution\s*=\s*".*?"\n?/m, '');

                // Get the Ballerina distribution version
                const distribution = getBallerinaDistribution();
                const distributionLine = distribution ? `\ndistribution = "${distribution}"` : '';

                content = content.replace(/version = ".*?"/, `version = "${projectInfo.finalVersion}"${distributionLine}\ntitle = "${projectInfo.integrationName}"`);
            }
        }

        writeBallerinaFileDidOpen(filePath, content || EMPTY);
    }

    params.projects?.forEach(project => {
        createProjectFiles(project, projectRoot);
    });

    // Create .vscode configuration files
    createVSCodeSettingsWithLaunch(projectRoot);

    // Create .gitignore file
    const gitignorePath = path.join(projectRoot, '.gitignore');
    fs.writeFileSync(gitignorePath, gitignoreContent.trim());

    debug(`BI project created successfully at ${projectRoot}`);

    const resolvedRoot = path.resolve(projectRoot);
    const aiEnabled = params.aiFeatureUsed ?? false;

    // Write the AI enhancement state file – acts as the source of truth for the
    // migration UI banner.  This is done for ALL values of aiFeatureUsed so
    // the card can offer a "Start Enhancement" button even when the user skipped.
    writeEnhanceToml(resolvedRoot, aiEnabled, false, params.sourcePath);

    if (aiEnabled) {
        // When AI enhancement is enabled, return the project root to the caller
        // so the wizard can run the enhancement pipeline before opening the folder.
        // The caller (RPC manager) will notify the webview with the project root
        // and kick off the agent; vscode.openFolder is deferred until the
        // enhancement completes or the user skips.
        return resolvedRoot;
    }

    // No AI enhancement – open the project immediately.
    scheduleMigrationEnhancement(aiEnabled, resolvedRoot, params.sourcePath);
    commands.executeCommand('vscode.openFolder', Uri.file(resolvedRoot));
    return resolvedRoot;
}

async function createProjectFiles(project: ProjectMigrationResult, projectRoot: string) {
    for (const [fileName, fileContent] of Object.entries(project.textEdits)) {
        const filePath = path.join(projectRoot, project.projectName, fileName);
        const fileDir = path.dirname(filePath);
        if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
        }
        writeBallerinaFileDidOpen(filePath, fileContent || "\n");
    }

    // Save migration report for this project
    if (project.report) {
        const reportPath = path.join(projectRoot, project.projectName, 'migration_report.html');
        fs.writeFileSync(reportPath, project.report);
    }
}

export async function createBIAutomation(params: ComponentRequest): Promise<CreateComponentResponse> {
    return new Promise(async (resolve) => {
        const functionFile = await handleAutomationCreation(params);
        const components = await StateMachine.langClient().getBallerinaProjectComponents({
            documentIdentifiers: [{ uri: URI.file(StateMachine.context().projectPath).toString() }]
        }) as BallerinaProjectComponents;
        const position: NodePosition = {};
        for (const pkg of components.packages) {
            for (const module of pkg.modules) {
                module.automations.forEach(func => {
                    position.startColumn = func.startColumn;
                    position.startLine = func.startLine;
                    position.endLine = func.endLine;
                    position.endColumn = func.endColumn;
                });
            }
        }
        openView(EVENT_TYPE.OPEN_VIEW, { documentUri: functionFile, position });
        history.clear();
        resolve({ response: true, error: "" });
    });
}

export async function createBIFunction(params: ComponentRequest): Promise<CreateComponentResponse> {
    return new Promise(async (resolve) => {
        const isExpressionBodied = params.functionType.isExpressionBodied;
        const projectPath = StateMachine.context().projectPath;
        // Hack to create trasformation function (Use LS API to create the function when available)
        const targetFile = path.join(projectPath, isExpressionBodied ? DATA_MAPPING_FILE : FUNCTIONS_FILE);
        if (!fs.existsSync(targetFile)) {
            writeBallerinaFileDidOpen(targetFile, '');
        }
        const response = await handleFunctionCreation(targetFile, params);
        await modifyFileContent({ filePath: targetFile, content: response.source });
        const modulePart: ModulePart = response.syntaxTree as ModulePart;
        let targetPosition: NodePosition = response.syntaxTree?.position;
        modulePart.members.forEach(member => {
            if (STKindChecker.isFunctionDefinition(member) && member.functionName.value === params.functionType.name.trim()) {
                targetPosition = member.position;
            }
        });
        openView(EVENT_TYPE.OPEN_VIEW, { documentUri: targetFile, position: targetPosition });
        history.clear();
        resolve({ response: true, error: "" });
    });
}

// <---------- Task Source Generation START-------->
export async function handleAutomationCreation(params: ComponentRequest) {
    let paramList = '';
    const paramLength = params.functionType?.parameters.length;
    if (paramLength > 0) {
        params.functionType.parameters.forEach((param, index) => {
            let paramValue = param.defaultValue ? `${param.type} ${param.name} = ${param.defaultValue}, ` : `${param.type} ${param.name}, `;
            if (paramLength === index + 1) {
                paramValue = param.defaultValue ? `${param.type} ${param.name} = ${param.defaultValue}` : `${param.type} ${param.name}`;
            }
            paramList += paramValue;
        });
    }
    let funcSignature = `public function main(${paramList}) returns error? {`;
    const balContent = `import ballerina/log;

${funcSignature}
    do {

    } on fail error e {
        log:printError("Error: ", 'error = e);
        return e;
    }
}
`;
    const projectPath = StateMachine.context().projectPath;
    // Create foo.bal file within services directory
    const taskFile = path.join(projectPath, `automation.bal`);
    writeBallerinaFileDidOpen(taskFile, balContent);
    console.log('Task Created.', `automation.bal`);
    return taskFile;
}
// <---------- Task Source Generation END-------->

// <---------- Function Source Generation START-------->
export async function handleFunctionCreation(targetFile: string, params: ComponentRequest): Promise<SyntaxTreeResponse> {
    const modifications: STModification[] = [];
    const { parameters, returnType, name, isExpressionBodied } = params.functionType;
    const parametersStr = parameters
        .map((item) => `${item.type} ${item.name} ${item.defaultValue ? `= ${item.defaultValue}` : ''}`)
        .join(",");

    const returnTypeStr = `returns ${!returnType ? 'error?' : isExpressionBodied ? `${returnType}` : `${returnType}|error?`}`;

    const expBody = `{
    do {

    } on fail error e {
        return e;
    }
}`;

    const document = await workspace.openTextDocument(Uri.file(targetFile));
    const lastPosition = document.lineAt(document.lineCount - 1).range.end;

    const targetPosition: NodePosition = {
        startLine: lastPosition.line,
        startColumn: 0,
        endLine: lastPosition.line,
        endColumn: 0
    };
    modifications.push(
        createFunctionSignature(
            "",
            name,
            parametersStr,
            returnTypeStr,
            targetPosition,
            false,
            params.functionType.isExpressionBodied,
            params.functionType.isExpressionBodied ? `{}` : expBody
        )
    );

    const res = await applyModifications(targetFile, modifications) as SyntaxTreeResponse;
    return res;
}
// <---------- Function Source Generation END-------->
// Test_Integration test_integration   Test Integration testIntegration -> testintegration
export function sanitizeName(name: string): string {
    return name.replace(/[^a-z0-9]_./gi, '_').toLowerCase(); // Replace invalid characters with underscores
}

export async function getSuggestedProjectDefaults(isInProject: boolean): Promise<SuggestedProjectDefaultsResponse> {
    const BASE_PROJECT_NAME = "Default";
    const BASE_INTEGRATION_NAME = "Untitled";

    if (!isInProject) {
        const currentProjectPath = StateMachine.context().projectPath;
        const parentDir = path.dirname(currentProjectPath);
        const tomlValues = await getProjectTomlValues(currentProjectPath);
        const currentPackageName = tomlValues?.package?.name ?? "";

        const baseHandle = BASE_PROJECT_NAME.toLowerCase();
        let projectName = BASE_PROJECT_NAME;
        let projectHandle = baseHandle;
        if (fs.existsSync(path.join(parentDir, baseHandle))) {
            for (let i = 2; ; i++) {
                projectHandle = `${baseHandle}-${i}`;
                if (!fs.existsSync(path.join(parentDir, projectHandle))) {
                    projectName = `${BASE_PROJECT_NAME} ${i}`;
                    break;
                }
            }
        }

        const basePackageName = BASE_INTEGRATION_NAME.toLowerCase();
        let integrationName = BASE_INTEGRATION_NAME;
        let packageName = basePackageName;
        if (packageName === currentPackageName) {
            for (let i = 2; ; i++) {
                packageName = `${basePackageName}_${i}`;
                if (packageName !== currentPackageName) {
                    integrationName = `${BASE_INTEGRATION_NAME} ${i}`;
                    break;
                }
            }
        }

        return { projectName, projectHandle, integrationName, packageName };
    } else {
        const workspacePath = StateMachine.context().workspacePath;
        const basePackageName = BASE_INTEGRATION_NAME.toLowerCase();
        if (!fs.existsSync(path.join(workspacePath, basePackageName))) {
            return { projectName: BASE_PROJECT_NAME, projectHandle: BASE_PROJECT_NAME.toLowerCase(), integrationName: BASE_INTEGRATION_NAME, packageName: basePackageName };
        }
        for (let i = 2; ; i++) {
            const packageName = `${basePackageName}_${i}`;
            if (!fs.existsSync(path.join(workspacePath, packageName))) {
                return { projectName: BASE_PROJECT_NAME, projectHandle: BASE_PROJECT_NAME.toLowerCase(), integrationName: `${BASE_INTEGRATION_NAME} ${i}`, packageName };
            }
        }
    }
}

const DEFAULT_CREATION_DIRNAME = "WSO2Integrator";

/** Default directory new projects are created under when no path is chosen. */
export function getDefaultCreationPath(): string {
    const dir = path.join(os.homedir(), DEFAULT_CREATION_DIRNAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Full project-creation flow: scaffold the project/workspace, then open it.
 * Wraps the create primitives above.
 */
export async function createBIProject(params: any): Promise<void> {
    if (params.createAsWorkspace) {
        const projectRoot = params.projectName
            ? await createBIWorkspaceWithProject(params)
            : await createEmptyBIWorkspace(params);
        openInVSCode(projectRoot);
        return;
    }
    // Component (integration/library) creation: added into an existing workspace
    // when the target resolves inside one, otherwise created standalone.
    const { openRoot } = await createBIComponent(params);
    openInVSCode(openRoot);
}
