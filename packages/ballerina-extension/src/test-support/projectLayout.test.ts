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
 * The project's source is not in the turn, so for a Ballerina workspace the turn names its packages,
 * marks the active one, and says that file paths start with the package path.
 */

let mockProjectKind = "BUILD_PROJECT";

// The barrel pulls in an ESM-only websocket transport; only PROJECT_KIND is needed here.
jest.mock("@wso2/ballerina-core", () => ({
    PROJECT_KIND: { WORKSPACE_PROJECT: "WORKSPACE_PROJECT", BUILD_PROJECT: "BUILD_PROJECT" },
}));

jest.mock("../stateMachine", () => ({
    StateMachine: {
        context: () => ({ projectInfo: { projectKind: mockProjectKind } }),
    },
}));

jest.mock("../rpc-managers/ai-panel/utils", () => ({ addToIntegration: jest.fn() }));

import { formatProjectLayout } from "../features/ai/agent/utils";

const projects = [
    { projectName: "orders", packagePath: "orders", isActive: true, sourceFiles: [] },
    { projectName: "shared", packagePath: "shared", isActive: false, sourceFiles: [] },
] as any;

describe("formatProjectLayout", () => {
    it("names a single package, which its own modules are imported under", () => {
        mockProjectKind = "BUILD_PROJECT";
        expect(formatProjectLayout([projects[0]])).toContain('This is the Ballerina package "orders". Import one of its modules, such as a generated connector under generated/moduleName, as: import orders.moduleName;');
        expect(formatProjectLayout([])).toBe("");
    });

    it("lists a workspace's packages by path, marks the active one, and states the path rule", () => {
        mockProjectKind = "WORKSPACE_PROJECT";
        const text = formatProjectLayout(projects);
        expect(text).toContain("- orders (package orders) — active");
        expect(text).toContain("- shared (package shared)\n");
        expect(text).toContain("start with the package path");
    });
});
