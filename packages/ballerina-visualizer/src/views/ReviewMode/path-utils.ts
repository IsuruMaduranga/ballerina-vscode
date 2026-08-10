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

/**
 * Semantic-diff URIs carry the ai:// baseline scheme; package paths are plain, so they only compare
 * once the scheme is dropped. Kept in its own module so it can be tested without pulling the whole
 * ReviewMode view in — same reason position-utils is separate.
 */
export function toComparablePath(uri: string): string {
    return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\\/g, "/");
}

/** Whether a semantic diff's uri falls under the given package root. */
export function diffBelongsToPackage(uri: string, packagePath: string): boolean {
    const uriPath = toComparablePath(uri);
    const pkgPath = packagePath.replace(/\\/g, "/");
    return uriPath.startsWith(`${pkgPath}/`) || uriPath === pkgPath;
}
