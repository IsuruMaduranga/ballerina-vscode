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

import { formatReaderAnswer, readerCalledATool } from "../features/ai/agent/tools/web-fetch-reader";

describe("web_fetch reader", () => {
    it("counts a direct web_fetch call as a fetch", () => {
        expect(readerCalledATool([{ toolCalls: [{ toolName: "web_fetch" }], content: [{ type: "text" }] }])).toBe(true);
    });

    it("counts a tool result without a matching call, as dynamic filtering can return", () => {
        expect(readerCalledATool([{ toolCalls: [], content: [{ type: "tool-result" }, { type: "text" }] }])).toBe(true);
        expect(readerCalledATool([{ content: [{ type: "tool-error" }] }])).toBe(true);
    });

    it("treats a text-only answer as not fetched", () => {
        expect(readerCalledATool([{ toolCalls: [], content: [{ type: "reasoning" }, { type: "text" }] }])).toBe(false);
        expect(readerCalledATool([])).toBe(false);
        expect(readerCalledATool(undefined)).toBe(false);
    });

    it("returns an answer under its source URL", () => {
        expect(formatReaderAnswer("https://example.com", "  2201.13.6\n", "stop"))
            .toEqual({ output: "Source: https://example.com\n\n2201.13.6", failed: false });
    });

    it("marks the reader's fetch failure as a failed tool call", () => {
        expect(formatReaderAnswer("https://example.com", "Fetch failed: url_not_accessible (HTTP 404)", "stop"))
            .toEqual({ output: "Web fetch failed for https://example.com: url_not_accessible (HTTP 404)", failed: true });
    });

    it("marks an empty answer as a failure", () => {
        expect(formatReaderAnswer("https://example.com", "   ", "stop").failed).toBe(true);
    });

    it("says when the answer was cut off at the output limit", () => {
        const { output, failed } = formatReaderAnswer("https://example.com", "Partial", "length");
        expect(failed).toBe(false);
        expect(output).toBe("Source: https://example.com\n\nPartial\n\n(The answer was cut off at the reader's output limit.)");
    });
});
