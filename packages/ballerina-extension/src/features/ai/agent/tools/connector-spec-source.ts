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
 * Resolves an OpenAPI spec the user has already supplied, so the connector generator only asks for
 * one when there is none. Kept apart from connector-generator.ts because that module imports the
 * language client, which cannot be loaded in a unit test.
 */

import type { FileAttatchment } from "@wso2/ballerina-core";
import type { SpecFetcherInput } from "../../utils/libs/generator/openapi-types";

export type ProvidedSpecSource = "attachment" | "inline" | "url";

export type ProvidedSpecResult =
    | { kind: "none" }
    | { kind: "resolved"; spec: string; source: ProvidedSpecSource }
    | { kind: "unresolved"; reason: string };

export type SpecFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const URL_FETCH_TIMEOUT_MS = 30000;

const defaultFetch: SpecFetch = (url) => fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });

/**
 * Images and PDFs reach the agent as base64 data URLs, never as spec text.
 */
function isTextAttachment(attachment: FileAttatchment): boolean {
    const mimeType = attachment.mimeType ?? "";
    if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
        return false;
    }
    return !attachment.content.startsWith("data:");
}

function baseName(fileName: string): string {
    return fileName.split(/[\\/]/).pop() ?? fileName;
}

export function findAttachment(
    fileName: string,
    attachments: FileAttatchment[] | undefined
): FileAttatchment | undefined {
    const candidates = (attachments ?? []).filter(isTextAttachment);
    const wanted = baseName(fileName.trim()).toLowerCase();
    return candidates.find(a => a.fileName === fileName)
        ?? candidates.find(a => baseName(a.fileName).toLowerCase() === wanted);
}

/**
 * Returns the spec the user supplied through the chat: an attached file, pasted text or a URL, in
 * that order. "none" means nothing was supplied and the user should be asked. "unresolved" means
 * something was supplied but could not be read; asking the user is the fallback there too.
 */
export async function resolveProvidedSpec(
    input: SpecFetcherInput,
    attachments: FileAttatchment[] | undefined,
    fetchSpec: SpecFetch = defaultFetch
): Promise<ProvidedSpecResult> {
    const reasons: string[] = [];

    if (input.attachmentFileName?.trim()) {
        const attachment = findAttachment(input.attachmentFileName, attachments);
        if (attachment?.content.trim()) {
            return { kind: "resolved", spec: attachment.content, source: "attachment" };
        }
        reasons.push(`no attached file named "${input.attachmentFileName}"`);
    }

    if (input.specContent?.trim()) {
        return { kind: "resolved", spec: input.specContent, source: "inline" };
    }

    if (input.specUrl?.trim()) {
        const url = input.specUrl.trim();
        try {
            const response = await fetchSpec(url);
            if (!response.ok) {
                reasons.push(`fetching ${url} returned HTTP ${response.status}`);
            } else {
                const spec = await response.text();
                if (spec.trim()) {
                    return { kind: "resolved", spec, source: "url" };
                }
                reasons.push(`${url} returned an empty body`);
            }
        } catch (error: any) {
            reasons.push(`fetching ${url} failed: ${error?.message ?? String(error)}`);
        }
    }

    return reasons.length > 0 ? { kind: "unresolved", reason: reasons.join("; ") } : { kind: "none" };
}
