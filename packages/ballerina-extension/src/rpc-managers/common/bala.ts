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

/**
 * Returns the `.bala` produced by `bal pack` under `target/bala`. The directory also holds
 * non-bala outputs (e.g. the `.cdx.json` SBOM) and may keep balas from earlier packs of
 * another version or platform, so pick the most recently written `.bala`.
 */
export function getBalaPath(projectPath: string): string | null {
    const balaDirPath = path.join(projectPath, 'target', 'bala');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(balaDirPath, { withFileTypes: true });
    } catch {
        return null;
    }
    let latest: { filePath: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.bala') {
            continue;
        }
        const filePath = path.join(balaDirPath, entry.name);
        const { mtimeMs } = fs.statSync(filePath);
        if (!latest || mtimeMs > latest.mtimeMs) {
            latest = { filePath, mtimeMs };
        }
    }
    return latest?.filePath ?? null;
}
