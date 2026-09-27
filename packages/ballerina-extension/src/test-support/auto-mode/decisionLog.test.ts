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

/** The decision log, ported from an earlier harness's decision-log test suite. */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendDecision, decisionEntry } from "../../features/ai/agent/auto-mode/decision-log";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-decision-log-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("decision log", () => {
    it("appends one JSON line per decision, creating the directory", () => {
        const file = join(dir, "nested", "auto-mode-decisions.jsonl");
        appendDecision(file, decisionEntry({ tool: "bash", subject: "npm test", outcome: "allow", source: "pre-gate" }));
        appendDecision(
            file,
            decisionEntry({
                tool: "bash",
                subject: "git push --force",
                outcome: "block",
                source: "classifier",
                tier: "soft_deny",
                ruleId: "S1",
                model: "openai/gpt-5-mini",
            }),
        );
        const lines = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ tool: "bash", outcome: "allow", source: "pre-gate" });
        expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(lines[1]).toMatchObject({ ruleId: "S1", model: "openai/gpt-5-mini" });
    });

    it("clips the subject so a huge command cannot bloat the log", () => {
        const entry = decisionEntry({ tool: "bash", subject: "x".repeat(5000), outcome: "allow", source: "pre-gate" });
        expect(entry.subject.length).toBeLessThan(350);
        expect(entry.subject.endsWith("…")).toBe(true);
    });

    it("swallows write failures rather than breaking the gate", () => {
        // A gate that blocks tool calls because its diary is unwritable has its
        // priorities backwards.
        expect(() =>
            appendDecision(
                join("/nonexistent-root-for-tests", "x.jsonl"),
                decisionEntry({ tool: "bash", subject: "ls", outcome: "allow", source: "pre-gate" }),
            ),
        ).not.toThrow();
    });
});
