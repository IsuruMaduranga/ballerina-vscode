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
 * The connector generator must ask the user for an OpenAPI spec only when none was supplied. A spec
 * the user already attached, pasted or linked has to be used directly, otherwise the run blocks on an
 * upload card the user believes they have already answered.
 */

import { resolveProvidedSpec, SpecFetch } from "../features/ai/agent/tools/connector-spec-source";

const SPEC = "openapi: 3.0.3\ninfo:\n  title: Orders\n  version: 1.0.0\npaths: {}\n";

const attachments = [
    { fileName: "diagram.png", content: "data:image/png;base64,AAAA", mimeType: "image/png" },
    { fileName: "order-api.yaml", content: SPEC },
];

const fetchReturning = (body: string, status = 200): SpecFetch =>
    jest.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));

const noFetch: SpecFetch = jest.fn(async () => { throw new Error("fetch must not be called"); });

describe("resolveProvidedSpec", () => {
    it("asks the user when no spec was supplied", async () => {
        const result = await resolveProvidedSpec({ serviceName: "Orders" }, attachments, noFetch);
        expect(result).toEqual({ kind: "none" });
        expect(noFetch).not.toHaveBeenCalled();
    });

    it.each([
        ["exact name", "order-api.yaml"],
        ["different case", "Order-API.yaml"],
        ["a path prefix", "/Users/someone/Downloads/order-api.yaml"],
    ])("reads an attached spec referenced by %s", async (_label, attachmentFileName) => {
        const result = await resolveProvidedSpec({ serviceName: "Orders", attachmentFileName }, attachments, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "attachment" });
    });

    it("never treats an image attachment as a spec", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "diagram.png" }, attachments, noFetch);
        expect(result.kind).toBe("unresolved");
    });

    it("uses pasted spec text", async () => {
        const result = await resolveProvidedSpec({ serviceName: "Orders", specContent: SPEC }, [], noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "inline" });
    });

    it("fetches a spec URL", async () => {
        const fetchSpec = fetchReturning(SPEC);
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", specUrl: " https://example.com/openapi.yaml " }, [], fetchSpec);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "url" });
        expect(fetchSpec).toHaveBeenCalledWith("https://example.com/openapi.yaml");
    });

    it("prefers an attachment over the other sources", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "order-api.yaml", specContent: "other", specUrl: "https://x" },
            attachments, noFetch);
        expect(result).toMatchObject({ kind: "resolved", source: "attachment" });
    });

    it("falls through to the next source when the attachment is missing", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "missing.yaml", specContent: SPEC }, attachments, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "inline" });
    });

    it.each([
        ["an unknown attachment", { attachmentFileName: "missing.yaml" }, noFetch],
        ["a URL that fails", { specUrl: "https://example.com/gone" }, fetchReturning("", 404)],
        ["a URL with an empty body", { specUrl: "https://example.com/empty" }, fetchReturning("   ")],
        ["a URL that throws", { specUrl: "https://example.com/down" },
            jest.fn(async () => { throw new Error("ECONNREFUSED"); }) as SpecFetch],
    ])("reports %s as unresolved so the user is asked instead", async (_label, input, fetchSpec) => {
        const result = await resolveProvidedSpec({ serviceName: "Orders", ...input }, attachments, fetchSpec);
        expect(result.kind).toBe("unresolved");
    });
});
