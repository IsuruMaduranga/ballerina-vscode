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

import * as vscode from "vscode";

import { isWebSearchEnabled, setWebSearchEnabled, WEB_SEARCH_SETTING } from "../features/ai/agent/tools/web-search-setting";

const ws = vscode.workspace as any;
const originalGetConfiguration = ws.getConfiguration;

/** Stubs the `ballerina` section with the given scope values and records every update. */
function stubSetting(values: { globalValue?: boolean; workspaceValue?: boolean }) {
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
    ws.getConfiguration = () => ({
        get: (_key: string, defaultValue?: boolean) => values.workspaceValue ?? values.globalValue ?? defaultValue,
        inspect: () => ({ defaultValue: true, ...values }),
        update: (key: string, value: unknown, target: unknown) => {
            updates.push({ key, value, target });
            return Promise.resolve();
        },
    });
    return updates;
}

afterEach(() => {
    ws.getConfiguration = originalGetConfiguration;
});

describe("web search setting", () => {
    it("is on by default", () => {
        stubSetting({});
        expect(isWebSearchEnabled()).toBe(true);
    });

    it("writes the user value when no workspace value is set", async () => {
        const updates = stubSetting({});
        await setWebSearchEnabled(false);
        expect(updates).toEqual([{ key: WEB_SEARCH_SETTING, value: false, target: vscode.ConfigurationTarget.Global }]);
    });

    it("writes the user value over an existing user value", async () => {
        const updates = stubSetting({ globalValue: false });
        await setWebSearchEnabled(true);
        expect(updates).toEqual([{ key: WEB_SEARCH_SETTING, value: true, target: vscode.ConfigurationTarget.Global }]);
    });

    it("writes the workspace value when the workspace overrides the setting", async () => {
        const updates = stubSetting({ globalValue: false, workspaceValue: true });
        await setWebSearchEnabled(false);
        expect(updates).toEqual([{ key: WEB_SEARCH_SETTING, value: false, target: vscode.ConfigurationTarget.Workspace }]);
    });
});
