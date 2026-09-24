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

import * as fs from 'fs';
import * as path from 'path';
import { commands, ProgressLocation, Range, TextDocument, Uri, window, workspace, WorkspaceEdit } from 'vscode';
import { ConnectorReference, ConnectorUpgradeAdvice } from '@wso2/ballerina-core';
import { StateMachine } from '../../stateMachine';
import { runCommandWithOutput } from '../../utils/runCommand';
import { buildOutputChannel } from '../../utils/logger';
import { quoteShellPath } from '../../utils/config';
import { extension } from '../../BalExtensionContext';

/** {@code CommandConstants.ARG_KEY_DOC_URI} on the LS side -- see PullModuleExecutor.java. */
const ARG_KEY_DOC_URI = 'doc.uri';
/** {@code CommandConstants.ARG_KEY_PACKAGES} on the LS side -- see PullModuleExecutor.java. */
const ARG_KEY_PACKAGES = 'packages';
const PULL_MODULE_COMMAND = 'PULL_MODULE';
const EXECUTE_COMMAND_FAILURE = false;
const RELOAD_WINDOW_COMMAND = 'workbench.action.reloadWindow';
const BALLERINA_TOML = 'Ballerina.toml';
const DEPENDENCIES_TOML = 'Dependencies.toml';
const MAIN_BAL = 'main.bal';
const BACKUP_SUFFIX = '.bak';

const UPGRADE_PROMPT_MESSAGE = "This project's connectors need an update to work with Service Designer.";
const UPGRADE_PROGRESS_TITLE = 'Updating connectors';
const PULLING_PROGRESS_MESSAGE = 'Pulling the required connector versions...';
const UPDATING_MANIFEST_PROGRESS_MESSAGE = 'Updating Ballerina.toml...';
const REBUILDING_PROGRESS_MESSAGE = 'Rebuilding the project...';
const PULL_FAILED_MESSAGE = "Couldn't pull the required connector versions:";
const MANIFEST_UPDATE_FAILED_MESSAGE = "Couldn't update the connector versions in Ballerina.toml:";
const REBUILD_FAILED_MESSAGE = "Couldn't clean and rebuild the project. See the build output for details.";
const RELOAD_PROMPT_MESSAGE = "This project's connectors are updated. Reload the window to finish.";
const RELOAD_WINDOW_ACTION = 'Reload Window';

enum BalCommand {
    Clean = 'clean',
    Build = 'build'
}

enum UpgradeAction {
    Update = 'Update',
    NotNow = 'Not Now'
}

const pendingReloadConnectors = new Map<string, Map<string, ConnectorReference>>();

interface PackageCoordinate {
    org: string;
    name: string;
    version: string;
}

interface DependencyPin {
    document: TextDocument;
    versionRange: Range;
    version: string;
}

/**
 * Checks the current project for connectors used as a `service ... on <module>:Listener` whose
 * resolved version predates schema-driven trigger support, and prompts for consent to update.
 */
export async function checkAndPromptConnectorUpgrades(projectPath: string): Promise<void> {
    if (!projectPath) {
        return;
    }
    const advice = await fetchUpgradeAdvice(projectPath);
    if (advice.length === 0) {
        return;
    }
    const selection = await window.showInformationMessage(
        UPGRADE_PROMPT_MESSAGE,
        UpgradeAction.Update,
        UpgradeAction.NotNow
    );
    if (selection === UpgradeAction.Update) {
        await upgradeConnectors(advice, projectPath, true);
    }
}

/** The connectors of {@code projectPath} upgraded in this session that still wait for a window reload. */
export function getPendingReloadConnectors(projectPath: string): ConnectorReference[] {
    return Array.from(pendingReloadConnectors.get(projectPath)?.values() ?? []);
}

/**
 * Upgrades every connector in {@code advice} to its minimum supported version:
 *
 * <ol>
 * <li>Pulls the exact required versions through {@code PULL_MODULE}. A plain re-resolution pulls nothing,
 * since an older bala of each connector is already cached.</li>
 * <li>Raises explicit {@code Ballerina.toml} {@code [[dependency]]} pins to the pulled versions.</li>
 * <li>When a {@code Dependencies.toml} exists, removes it and runs {@code bal build} to regenerate it,
 * since the locked versions would otherwise keep winning over the pulled ones.</li>
 * </ol>
 *
 * With {@code promptReload}, the upgraded connectors are recorded as waiting for a reload and the user is
 * asked to reload the window so every open view is rebuilt against the new versions.
 *
 * @returns whether the upgrade completed
 */
export async function upgradeConnectors(
    advice: ConnectorUpgradeAdvice[],
    projectPath: string,
    promptReload: boolean
): Promise<boolean> {
    if (advice.length === 0) {
        return false;
    }
    const upgraded = await window.withProgress(
        { location: ProgressLocation.Notification, title: UPGRADE_PROGRESS_TITLE },
        async (progress) => {
            progress.report({ message: PULLING_PROGRESS_MESSAGE });
            if (!(await pullExactVersions(advice, projectPath))) {
                reportFailure(PULL_FAILED_MESSAGE, advice);
                return false;
            }

            progress.report({ message: UPDATING_MANIFEST_PROGRESS_MESSAGE });
            if (!(await raiseDependencyPins(advice, projectPath))) {
                reportFailure(MANIFEST_UPDATE_FAILED_MESSAGE, advice);
                return false;
            }

            const dependenciesToml = path.join(projectPath, DEPENDENCIES_TOML);
            if (fs.existsSync(dependenciesToml)) {
                progress.report({ message: REBUILDING_PROGRESS_MESSAGE });
                if (!(await regenerateDependenciesToml(dependenciesToml, projectPath))) {
                    window.showErrorMessage(REBUILD_FAILED_MESSAGE);
                    return false;
                }
            }

            return true;
        }
    );
    if (upgraded && promptReload) {
        markPendingReload(advice, projectPath);
        promptWindowReload();
    }
    return upgraded;
}

/**
 * Upgrades every connector the project needs to upgrade, along with {@code requested} even if the
 * language server no longer reports it, so a single reload covers them all.
 */
export async function upgradeProjectConnectors(
    requested: ConnectorUpgradeAdvice,
    projectPath: string
): Promise<boolean> {
    const advice = await fetchUpgradeAdvice(projectPath);
    const isRequestedListed = advice.some((item) =>
        connectorKey(item) === connectorKey(requested));
    return upgradeConnectors(isRequestedListed ? advice : [...advice, requested], projectPath, true);
}

function markPendingReload(advice: ConnectorUpgradeAdvice[], projectPath: string): void {
    const pending = pendingReloadConnectors.get(projectPath) ?? new Map<string, ConnectorReference>();
    for (const item of advice) {
        pending.set(connectorKey(item), { orgName: item.orgName, packageName: item.packageName });
    }
    pendingReloadConnectors.set(projectPath, pending);
}

function promptWindowReload(): void {
    window.showInformationMessage(RELOAD_PROMPT_MESSAGE, RELOAD_WINDOW_ACTION).then((selection) => {
        if (selection === RELOAD_WINDOW_ACTION) {
            commands.executeCommand(RELOAD_WINDOW_COMMAND);
        }
    });
}

function connectorKey(connector: ConnectorReference): string {
    return `${connector.orgName}/${connector.packageName}`;
}

async function fetchUpgradeAdvice(projectPath: string): Promise<ConnectorUpgradeAdvice[]> {
    try {
        const response = await StateMachine.langClient().getConnectorUpgradeAdvice({ filePath: projectPath });
        return response?.advice ?? [];
    } catch (error) {
        console.error('>>> Error fetching connector upgrade advice', error);
        return [];
    }
}

async function pullExactVersions(advice: ConnectorUpgradeAdvice[], projectPath: string): Promise<boolean> {
    const targetFile = advice.find((item) => item.usedInFile)?.usedInFile ?? MAIN_BAL;
    const fileUri = Uri.file(path.isAbsolute(targetFile) ? targetFile : path.join(projectPath, targetFile))
        .toString();
    const packages: PackageCoordinate[] = advice.map((item) => ({
        org: item.orgName,
        name: item.packageName,
        version: item.minSupportedVersion
    }));
    try {
        const result = await StateMachine.langClient().executeCommand({
            command: PULL_MODULE_COMMAND,
            arguments: [
                { key: ARG_KEY_DOC_URI, value: fileUri },
                { key: ARG_KEY_PACKAGES, value: packages }
            ]
        });
        return result !== EXECUTE_COMMAND_FAILURE;
    } catch (error) {
        console.error('>>> Connector upgrade pull failed', error);
        return false;
    }
}

/**
 * Raises every explicit {@code Ballerina.toml} pin of an advised connector to its pulled version. A pin that
 * is already at or above that version is left alone, so an upgrade never downgrades a connector.
 */
async function raiseDependencyPins(advice: ConnectorUpgradeAdvice[], projectPath: string): Promise<boolean> {
    const tomlPath = path.join(projectPath, BALLERINA_TOML);
    const pins = await Promise.all(advice.map(async (item) => ({
        item,
        pin: await findDependencyPin(tomlPath, item.orgName, item.packageName)
    })));
    const pinned = pins.filter((entry): entry is { item: ConnectorUpgradeAdvice; pin: DependencyPin } =>
        entry.pin !== undefined && compareVersions(entry.pin.version, entry.item.minSupportedVersion) < 0);
    if (pinned.length === 0) {
        return true;
    }
    const edit = new WorkspaceEdit();
    for (const { item, pin } of pinned) {
        edit.replace(pin.document.uri, pin.versionRange, item.minSupportedVersion);
    }
    if (!(await workspace.applyEdit(edit))) {
        console.error('>>> Failed to apply Ballerina.toml edits for connector upgrade');
        return false;
    }
    return pinned[0].pin.document.save();
}

/**
 * Moves the stale lock file aside, then runs {@code bal clean} and a real {@code bal build} so the lock file
 * and build artifacts are regenerated from the pulled versions. The old lock file is restored when the
 * lock file is not regenerated.
 */
async function regenerateDependenciesToml(dependenciesToml: string, projectPath: string): Promise<boolean> {
    const backup = `${dependenciesToml}${BACKUP_SUFFIX}`;
    try {
        await fs.promises.rename(dependenciesToml, backup);
    } catch (error) {
        console.error('>>> Failed to move Dependencies.toml aside', error);
        return false;
    }
    const regenerated = await rebuild(dependenciesToml, projectPath);
    try {
        if (regenerated) {
            await fs.promises.rm(backup);
        } else {
            await fs.promises.rename(backup, dependenciesToml);
        }
    } catch (error) {
        console.error('>>> Failed to clean up the Dependencies.toml backup', error);
    }
    return regenerated;
}

/**
 * Runs {@code bal clean} then {@code bal build}. The build counts as successful when it regenerates the lock
 * file, since it can fail on unrelated compile errors after dependency resolution already succeeded.
 */
async function rebuild(dependenciesToml: string, projectPath: string): Promise<boolean> {
    const ballerinaCmd = quoteShellPath(extension.ballerinaExtInstance.getBallerinaCmd());
    const clean = await runCommandWithOutput(`${ballerinaCmd} ${BalCommand.Clean}`, projectPath, buildOutputChannel);
    if (!clean.success) {
        return false;
    }
    await runCommandWithOutput(`${ballerinaCmd} ${BalCommand.Build}`, projectPath, buildOutputChannel);
    return fs.existsSync(dependenciesToml);
}

/**
 * Compares the numeric major/minor/patch parts of two versions. A missing or non-numeric part counts as 0.
 */
function compareVersions(left: string, right: string): number {
    const parse = (version: string) => version.split(/[.+-]/, 3).map((part) => parseInt(part, 10) || 0);
    const [a, b] = [parse(left), parse(right)];
    for (let i = 0; i < 3; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

function reportFailure(message: string, advice: ConnectorUpgradeAdvice[]): void {
    window.showErrorMessage(`${message} ${advice.map((item) => item.moduleName).join(', ')}.`);
}

/**
 * Locates the {@code version} field of the {@code [[dependency]]} table matching
 * {@code orgName}/{@code packageName} in {@code Ballerina.toml}, or {@code undefined} if there is no
 * such {@code Ballerina.toml} or no matching pinned entry.
 */
async function findDependencyPin(
    tomlPath: string, orgName: string, packageName: string
): Promise<DependencyPin | undefined> {
    let document: TextDocument;
    try {
        document = await workspace.openTextDocument(Uri.file(tomlPath));
    } catch {
        return undefined;
    }
    const text = document.getText();

    // [[dependency]] tables run up to the next top-level table header (or EOF).
    const tableRegex = /\[\[dependency\]\][^[]*/g;
    let match: RegExpExecArray | null;
    while ((match = tableRegex.exec(text)) !== null) {
        const block = match[0];
        const orgMatch = block.match(/^\s*org\s*=\s*"([^"]+)"/m);
        const nameMatch = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
        if (orgMatch?.[1] !== orgName || nameMatch?.[1] !== packageName) {
            continue;
        }
        const versionMatch = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
        if (!versionMatch || versionMatch.index === undefined) {
            return undefined;
        }
        const valueStart = match.index + versionMatch.index + versionMatch[0].indexOf(versionMatch[1]);
        const valueEnd = valueStart + versionMatch[1].length;
        return {
            document,
            versionRange: new Range(document.positionAt(valueStart), document.positionAt(valueEnd)),
            version: versionMatch[1]
        };
    }
    return undefined;
}
