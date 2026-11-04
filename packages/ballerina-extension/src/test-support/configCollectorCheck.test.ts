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

/**
 * ConfigCollector check mode: a package with no Config.toml yet is a normal state, and in a
 * workspace an omitted packagePath means the active package.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("@wso2/ballerina-core", () => ({}));
jest.mock("../features/ai/state/ApprovalManager", () => ({ approvalManager: { requestConfiguration: jest.fn() } }));
jest.mock("../features/ai/activator", () => ({ langClient: {} }));
jest.mock("../BalExtensionContext", () => ({ extension: {} }));
jest.mock("../rpc-managers/platform-ext/managed-connections", () => ({ getManagedLibraries: jest.fn() }));

import { workspace } from "./__mocks__/vscode";
import { ConfigCollectorTool } from "../features/ai/agent/tools/config-collector";

const PACKAGE_TOML = '[package]\norg = "myorg"\nname = "orders"\nversion = "0.1.0"\n';
let root: string;
const check = (paths: { activePackagePath?: string }, input: Record<string, unknown> = {}) =>
    ConfigCollectorTool({ mode: "check", ...input } as never, jest.fn(), { tempPath: root, workspacePath: root, ...paths });

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "config-check-"));
    workspace.textDocuments = [];
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

it("reports a package with no Config.toml as nothing configured, not a failure", async () => {
    fs.writeFileSync(path.join(root, "Ballerina.toml"), PACKAGE_TOML);
    const result = await check({}, { variableNames: ["apiKey"] });
    expect(result).toMatchObject({ success: true, status: { apiKey: "missing" } });
    expect(result.message).toContain("Config.toml does not exist yet");
});

it("checks the active package of a workspace when packagePath is omitted", async () => {
    fs.writeFileSync(path.join(root, "Ballerina.toml"), '[workspace]\npackages = ["orders"]\n');
    fs.mkdirSync(path.join(root, "orders"));
    fs.writeFileSync(path.join(root, "orders", "Ballerina.toml"), PACKAGE_TOML);
    fs.writeFileSync(path.join(root, "orders", "Config.toml"), '[myorg.orders]\napiKey = "x"\n');
    expect(await check({ activePackagePath: "orders" })).toMatchObject({ success: true, status: { apiKey: "filled" } });
    // Without an active package the workspace still needs an explicit packagePath.
    await expect(check({})).resolves.toMatchObject({ success: false });
});
