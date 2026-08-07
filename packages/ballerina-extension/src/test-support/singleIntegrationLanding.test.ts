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

import type {
    MACHINE_VIEW as MachineView,
    ProjectStructure,
    ProjectStructureResponse,
    VisualizerLocation,
} from "@wso2/ballerina-core";

// The real barrel pulls in a WebSocket LS client that jest cannot load, so stub it. The view
// names must match the real enum values — the assertions below compare against them.
const MACHINE_VIEW = {
    PackageOverview: "Overview",
    WorkspaceOverview: "Workspace Overview",
    ServiceDesigner: "Service Designer",
} as unknown as typeof MachineView;
jest.mock("@wso2/ballerina-core", () => ({
    MACHINE_VIEW,
    DIRECTORY_MAP: {},
    EVENT_TYPE: {},
    FOCUS_FLOW_DIAGRAM_VIEW: {},
    isSamePath: (a: string, b: string) => a === b,
}));

jest.mock("../stateMachine", () => ({
    StateMachine: { context: jest.fn() },
    openView: jest.fn(),
}));

import { getSoleIntegration, resolveSingleIntegrationOverride } from "../utils/state-machine-utils";

const WORKSPACE_ROOT = "/workspace";

function pkg(name: string, isLibrary = false): ProjectStructure {
    return {
        projectName: name,
        projectPath: `${WORKSPACE_ROOT}/${name}`,
        isLibrary,
        directoryMap: {} as ProjectStructure["directoryMap"],
    };
}

function workspaceOf(...projects: ProjectStructure[]): ProjectStructureResponse {
    return { workspaceName: "orders", workspacePath: WORKSPACE_ROOT, projects };
}

describe("getSoleIntegration", () => {
    it("returns the only integration of a single-integration workspace", () => {
        expect(getSoleIntegration(workspaceOf(pkg("orders")))?.projectPath).toBe(`${WORKSPACE_ROOT}/orders`);
    });

    it("returns nothing once there is more than one package to choose between", () => {
        expect(getSoleIntegration(workspaceOf(pkg("orders"), pkg("shipping")))).toBeUndefined();
        expect(getSoleIntegration(workspaceOf(pkg("orders"), pkg("utils", true)))).toBeUndefined();
    });

    it("returns nothing when the workspace has no integration to land on", () => {
        expect(getSoleIntegration(workspaceOf())).toBeUndefined();
        expect(getSoleIntegration(workspaceOf(pkg("utils", true)))).toBeUndefined();
        expect(getSoleIntegration(undefined)).toBeUndefined();
    });

    // `projectPath` is optional on ProjectStructure. The package overview resolves its contents
    // by path, so redirecting to a pathless package would hang on a spinner forever — worse than
    // the one-item list it replaced.
    it("returns nothing for a sole integration with no project path", () => {
        expect(getSoleIntegration(workspaceOf({ ...pkg("orders"), projectPath: undefined }))).toBeUndefined();
    });
});

describe("resolveSingleIntegrationOverride", () => {
    const soleIntegration = { workspacePath: WORKSPACE_ROOT, projectStructure: workspaceOf(pkg("orders")) };
    const expected = { view: MACHINE_VIEW.PackageOverview, projectPath: `${WORKSPACE_ROOT}/orders` };

    // Both shapes a navigation can take, since the caller cannot tell them apart: the project
    // explorer names the workspace overview outright, other entry points send a bare location
    // and let `findView` resolve it.
    it.each<[string, VisualizerLocation]>([
        ["an explicit workspace overview", { view: MACHINE_VIEW.WorkspaceOverview }],
        ["a bare navigation with no view", {}],
        ["a bare navigation carrying only a document", { documentUri: "/workspace/orders/main.bal" }],
    ])("redirects %s to the sole integration", (_label, viewLocation) => {
        expect(resolveSingleIntegrationOverride(viewLocation, soleIntegration)).toEqual(expected);
    });

    it.each<[string, VisualizerLocation]>([
        ["a view other than the workspace overview", { view: MACHINE_VIEW.ServiceDesigner }],
        ["a navigation that already names a package", { projectPath: `${WORKSPACE_ROOT}/orders` }],
        ["a navigation resolving an artifact position", { position: { startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 } }],
    ])("leaves %s alone", (_label, viewLocation) => {
        expect(resolveSingleIntegrationOverride(viewLocation, soleIntegration)).toBeUndefined();
    });

    it("names the package it redirects to — the overview renders nothing without one", () => {
        expect(resolveSingleIntegrationOverride({}, soleIntegration).projectPath).toBeTruthy();
    });

    it("leaves every navigation alone outside a single-integration workspace", () => {
        const multi = { workspacePath: WORKSPACE_ROOT, projectStructure: workspaceOf(pkg("orders"), pkg("shipping")) };
        expect(resolveSingleIntegrationOverride({ view: MACHINE_VIEW.WorkspaceOverview }, multi)).toBeUndefined();
        expect(resolveSingleIntegrationOverride({}, multi)).toBeUndefined();
        expect(
            resolveSingleIntegrationOverride({}, { projectPath: "/standalone", projectStructure: workspaceOf(pkg("standalone")) })
        ).toBeUndefined();
    });
});
