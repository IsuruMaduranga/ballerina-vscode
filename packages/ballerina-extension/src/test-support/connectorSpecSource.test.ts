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
 * upload card the user believes they have already answered. Anything supplied that is not a usable
 * spec has to fall back to that card rather than fail in the generator.
 */

import {
    collectThreadAttachments,
    MAX_SPEC_BYTES,
    notAnOpenApiSpec,
    readLimited,
    resolveProvidedSpec,
    SpecFetch,
} from "../features/ai/agent/tools/connector-spec-source";

const SPEC = "openapi: 3.0.3\ninfo:\n  title: Orders\n  version: 1.0.0\npaths: {}\n";
const SWAGGER_JSON = JSON.stringify({ swagger: "2.0", info: { title: "Legacy", version: "1" }, paths: {} });
const URL = "https://example.com/openapi.yaml";

const attachments = [
    { fileName: "diagram.png", content: "data:image/png;base64,AAAA", mimeType: "image/png" },
    { fileName: "notes.txt", content: "Remember to add auth." },
    { fileName: "order-api.yaml", content: SPEC },
];

const fetchReturning = (body: string, status = 200, contentType = "application/yaml"): SpecFetch =>
    jest.fn(async () => ({ ok: status >= 200 && status < 300, status, contentType, text: async () => body }));

const noFetch: SpecFetch = jest.fn(async () => { throw new Error("fetch must not be called"); });

describe("resolveProvidedSpec", () => {
    it("asks the user when no spec was supplied", async () => {
        const result = await resolveProvidedSpec({ serviceName: "Orders" }, { attachments }, noFetch);
        expect(result).toEqual({ kind: "none" });
        expect(noFetch).not.toHaveBeenCalled();
    });

    it.each([
        ["exact name", "order-api.yaml"],
        ["different case", "Order-API.yaml"],
        ["a path prefix", "/Users/someone/Downloads/order-api.yaml"],
    ])("reads an attached spec referenced by %s", async (_label, attachmentFileName) => {
        const result = await resolveProvidedSpec({ serviceName: "Orders", attachmentFileName }, { attachments }, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "attachment" });
    });

    it("uses pasted spec text", async () => {
        const result = await resolveProvidedSpec({ serviceName: "Orders", specContent: SWAGGER_JSON }, {}, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SWAGGER_JSON, source: "inline" });
    });

    it("fetches a spec URL the user wrote", async () => {
        const fetchSpec = fetchReturning(SPEC);
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", specUrl: ` ${URL} ` }, { userText: `Build a client from ${URL} please` }, fetchSpec);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "url" });
        expect(fetchSpec).toHaveBeenCalledWith(URL);
    });

    it("prefers an attachment over the other sources", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "order-api.yaml", specContent: SWAGGER_JSON, specUrl: URL },
            { attachments, userText: URL }, noFetch);
        expect(result).toMatchObject({ kind: "resolved", source: "attachment" });
    });

    it("falls through to the next source when the attachment is missing", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "missing.yaml", specContent: SPEC }, { attachments }, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "inline" });
    });

    it("never fetches a URL the user did not write", async () => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", specUrl: "http://169.254.169.254/latest/meta-data" },
            { userText: "Create an API using the attached definition" }, noFetch);
        expect(result.kind).toBe("unresolved");
        expect(noFetch).not.toHaveBeenCalled();
    });

    it.each([
        ["an unknown attachment", { attachmentFileName: "missing.yaml" }, noFetch],
        ["an image attachment", { attachmentFileName: "diagram.png" }, noFetch],
        ["an attachment that is not a spec", { attachmentFileName: "notes.txt" }, noFetch],
        ["pasted text that is not a spec", { specContent: "just some notes" }, noFetch],
        ["a URL that fails", { specUrl: URL }, fetchReturning("", 404)],
        ["a URL that returns an HTML page", { specUrl: URL }, fetchReturning("<html>Swagger UI</html>", 200, "text/html; charset=utf-8")],
        ["a URL that returns a JSON error", { specUrl: URL }, fetchReturning('{"error":"not found"}', 200, "application/json")],
        ["a URL that throws", { specUrl: URL },
            jest.fn(async () => { throw new Error("ECONNREFUSED"); }) as SpecFetch],
    ])("reports %s as unresolved so the user is asked instead", async (_label, input, fetchSpec) => {
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", ...input }, { attachments, userText: URL }, fetchSpec);
        expect(result.kind).toBe("unresolved");
    });
});

describe("collectThreadAttachments", () => {
    it("reads a spec attached in an earlier turn, preferring the newest copy", async () => {
        const older = { fileName: "order-api.yaml", content: SPEC.replace("Orders", "Old Orders") };
        const thread = collectThreadAttachments(
            [], [{ fileAttachments: [older] }, { fileAttachments: [] }, { fileAttachments: [attachments[2]] }]);
        const result = await resolveProvidedSpec(
            { serviceName: "Orders", attachmentFileName: "order-api.yaml" }, { attachments: thread }, noFetch);
        expect(result).toEqual({ kind: "resolved", spec: SPEC, source: "attachment" });
    });

    it("puts the current turn first and drops images", () => {
        const current = { fileName: "new.yaml", content: SPEC };
        const thread = collectThreadAttachments([current, attachments[0]], [{ fileAttachments: attachments }]);
        expect(thread.map(a => a.fileName)).toEqual(["new.yaml", "notes.txt", "order-api.yaml"]);
    });
});

describe("notAnOpenApiSpec", () => {
    it.each([[SPEC], [SWAGGER_JSON]])("accepts an OpenAPI or Swagger document", (text) => {
        expect(notAnOpenApiSpec(text)).toBeUndefined();
    });

    it.each([
        ["invalid YAML", "a: [unclosed"],
        ["a scalar", "hello"],
        ["an array", "- a\n- b"],
        ["an object without openapi/swagger", "info:\n  title: x"],
    ])("rejects %s", (_label, text) => {
        expect(notAnOpenApiSpec(text)).toEqual(expect.any(String));
    });
});

describe("readLimited", () => {
    it("reads a body within the limit", async () => {
        await expect(readLimited(new Response(SPEC))).resolves.toBe(SPEC);
    });

    it("rejects a body over the limit", async () => {
        await expect(readLimited(new Response(new Uint8Array(MAX_SPEC_BYTES + 1)))).rejects.toThrow("larger than");
    });
});
