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

// L2: the "Imported libraries" tree of the Configurable Variables view. Every module the LS
// returns for an imported library must be reachable from the tree — issue 2738 was the
// submodules of ballerina/workflow being returned but never listed.

import React from "react";
import { createRoot, Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import fixture from "./fixtures/issue-2738.json";

jest.mock("@wso2/ballerina-core", () => ({
    __esModule: true,
    isSamePath: (a: string, b: string) => a === b,
}));

jest.mock("@wso2/ballerina-rpc-client", () => {
    const h = require("../../../../test/rpcHarness");
    return { __esModule: true, useRpcContext: h.useRpcContext, Context: h.TestRpcContext };
});

// The real TreeView/TreeViewItem are kept: their nesting and styles are what the tree is made of.
// They come from the toolkit's source because its lib/ is ESM. The rest is chrome around the tree.
jest.mock("@wso2/ui-toolkit", () => ({
    __esModule: true,
    TreeView: jest.requireActual("@wso2/ui-toolkit/src/components/TreeView/TreeView").TreeView,
    TreeViewItem: jest.requireActual("@wso2/ui-toolkit/src/components/TreeView/TreeViewItem").TreeViewItem,
    Typography: ({ children, sx }: any) => <p style={sx}>{children}</p>,
    Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
    Codicon: ({ name }: any) => <i data-codicon={name} />,
    Dropdown: (): null => null,
    ErrorBanner: (): null => null,
    Icon: (): null => null,
    TextField: (): null => null,
    Tooltip: ({ children }: any) => <>{children}</>,
    SplitView: ({ children }: any) => <div>{children}</div>,
    View: ({ children }: any) => <div>{children}</div>,
    ViewContent: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("../../../../components/TopNavigationBar", () => ({ __esModule: true, TopNavigationBar: (): null => null }));
jest.mock("../../../../components/TitleBar", () => ({ __esModule: true, TitleBar: (): null => null }));
jest.mock("../../../../components/RelativeLoader", () => ({ __esModule: true, RelativeLoader: (): null => null }));
jest.mock("../AddConfigurableVariables", () => ({ __esModule: true, AddForm: (): null => null }));
jest.mock("../ConfigurableItem", () => ({
    __esModule: true,
    default: ({ variable }: any) => <div data-testid="config-item">{variable.properties.variable.value}</div>,
}));

import { TestRpcContext } from "../../../../test/rpcHarness";
import { ViewConfigurableVariables } from "./index";

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_PATH = "/ws/sample";
const INTEGRATION = "wso2/sample";
type Fixture = Record<string, Record<string, { properties: { variable: { value: string } } }[]>>;
const CONFIG_VARIABLES = fixture.configVariables as Fixture;

const rpcClient = {
    getBIDiagramRpcClient: () => ({
        getProjectStructure: () => Promise.resolve({ projects: [{ projectPath: PROJECT_PATH, projectName: "sample" }] }),
        getConfigVariablesV2: () => Promise.resolve({ configVariables: CONFIG_VARIABLES }),
    }),
    onProjectContentUpdated: (): void => undefined,
};

describe("ViewConfigurableVariables imported libraries", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root.render(
                <TestRpcContext.Provider value={{ rpcClient }}>
                    <ViewConfigurableVariables projectPath={PROJECT_PATH} fileName="config.bal" org="wso2" />
                </TestRpcContext.Provider>
            );
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const libraryTree = () => container.querySelector("#package-treeview") as HTMLElement; // TreeView ids never reach the DOM
    const row = (text: string) => Array.from(libraryTree().querySelectorAll("p, span, div"))
        .find(el => el.childElementCount === 0 && el.textContent === text) as HTMLElement;
    const shownVariables = () => Array.from(container.querySelectorAll("[data-testid='config-item']"))
        .map(el => el.textContent);
    const click = async (el: HTMLElement) => {
        await act(async () => {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
    };

    const libraries = Object.keys(CONFIG_VARIABLES).filter(category => category !== INTEGRATION);

    it("lists every imported library", () => {
        for (const library of libraries) {
            expect(row(library)).toBeTruthy();
        }
    });

    it.each(libraries)("reaches every module of %s from the tree", async (library) => {
        await click(row(library));
        for (const [module, variables] of Object.entries(CONFIG_VARIABLES[library])) {
            if (module !== "") {
                await click(row(module));
            }
            expect(shownVariables()).toEqual(variables.map(v => v.properties.variable.value));
        }
    });

    it("opens the first submodule from the library row when the default module has none", async () => {
        await click(row("wso2/notifier"));
        expect(shownVariables()).toEqual(["timeout"]);
    });

    it("renders the library tree with submodules expanded", async () => {
        for (const library of libraries) {
            await click(row(library));
        }
        expect(libraryTree()).toMatchSnapshot();
    });
});
