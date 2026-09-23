// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * Registers files a shell command changed exactly as `persistLiveEdit`
 * (`text-editor.ts`) registers a file tool's write, so the review bar covers
 * shell edits: the generation's modified-file lists, the live-render gate's
 * touched set, a `workspace/didChangeWatchedFiles` for the Language Server's
 * file:// project (the client registers no file watcher, so a write that did
 * not go through VS Code is otherwise unseen), and a frozen ai:// baseline for
 * a package the command created.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Uri } from 'vscode';
import { StateMachine } from '../../../../stateMachine';
import { recordAiTouchedFile } from '../../../../rpc-managers/diagram-validity';
import { seedNewPackageBaseline } from '../../utils/project/ls-schema-notifications';
import { createdPackages, type TouchedFiles } from '../shell/touched-files';

/** LSP `FileChangeType`. */
const FILE_CREATED = 1;
const FILE_CHANGED = 2;
const FILE_DELETED = 3;

const isLsSource = (file: string) => file.endsWith('.bal') || file.endsWith('.toml');

export async function registerShellTouchedFiles(
    workspaceRoot: string,
    touched: TouchedFiles,
    modifiedFiles: string[],
    allModifiedFiles: Set<string>,
): Promise<void> {
    const all = [...touched.created, ...touched.changed, ...touched.deleted];
    for (const file of all) {
        if (!modifiedFiles.includes(file)) { modifiedFiles.push(file); }
        allModifiedFiles.add(file);
        recordAiTouchedFile(path.join(workspaceRoot, file));
    }

    const changes = [
        ...touched.created.filter(isLsSource).map((file) => ({ file, type: FILE_CREATED })),
        ...touched.changed.filter(isLsSource).map((file) => ({ file, type: FILE_CHANGED })),
        ...touched.deleted.filter(isLsSource).map((file) => ({ file, type: FILE_DELETED })),
    ].map(({ file, type }) => ({ uri: Uri.file(path.join(workspaceRoot, file)).toString(), type }));
    if (changes.length > 0) {
        try {
            await StateMachine.langClient().sendNotification('workspace/didChangeWatchedFiles', { changes });
        } catch (error) {
            console.error('[ShellTool] Failed to notify the Language Server of shell edits:', error);
        }
    }

    // A package the command created has no ai:// project yet: freeze its baseline as the new
    // toml plus empty .bal files, so the whole package reads as an addition in the review.
    for (const { packageDir, balFiles } of createdPackages(touched)) {
        const packageRoot = path.join(workspaceRoot, packageDir);
        try {
            const toml = fs.readFileSync(path.join(packageRoot, 'Ballerina.toml'), 'utf8');
            await seedNewPackageBaseline(packageRoot, toml, balFiles);
        } catch (error) {
            console.error(`[ShellTool] Failed to seed the review baseline for new package ${packageRoot}:`, error);
        }
    }
}
