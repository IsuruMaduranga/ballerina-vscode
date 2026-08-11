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

// L2: `hidden` must hide the footer WITHOUT unmounting it. An approval prompt renders its own
// footer in the composer's place, and the composer owns the user's draft and attachments as local
// state — so conditionally rendering it, the obvious way to write this, silently discards both.
// Nothing on screen distinguishes "hidden" from "unmounted", which is why it is pinned here.

import React from "react";
import { createRoot, Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The core barrel pulls in ESM-only LS transport modules that jest cannot load. Footer only reads
// TemplateId, and only for the suggestion chips this test does not render.
jest.mock("@wso2/ballerina-core", () => ({
    __esModule: true,
    TemplateId: { Wildcard: "Wildcard" },
}));

jest.mock("../../../commandTemplates/data/commandTemplates.const", () => ({
    __esModule: true,
    commandTemplates: {},
    suggestedCommandTemplates: [],
}));

jest.mock("../../../commandTemplates/utils/utils", () => ({
    __esModule: true,
    getTemplateTextById: () => "",
}));

jest.mock("../../CodeContextCard", () => ({
    __esModule: true,
    default: () => null,
}));

// Reaches @wso2/ballerina-rpc-client, which ships ESM. Only the loading indicator draws the orb.
jest.mock("../../../../../components/AgentStatusOrb/shared", () => ({
    __esModule: true,
    Sphere: () => null,
    Gloss: () => null,
    ORB_COLORS: { running: [] },
    ORB_ENERGY: { running: 0 },
}));

// Stands in for the composer. Its presence in the DOM is the whole point: the draft lives inside
// the real one as local state, so "still rendered" is what "draft preserved" reduces to.
jest.mock("../../AIChatInput", () => ({
    __esModule: true,
    default: React.forwardRef(() => <div data-testid="composer" />),
}));

import Footer from "./index";

const noop = () => undefined;
const baseProps = {
    aiChatInputRef: React.createRef<any>(),
    tagOptions: {} as any,
    attachmentOptions: {} as any,
    inputPlaceholder: "What would you like to change?",
    onSend: async () => undefined,
    onStop: noop,
    isLoading: false,
    showSuggestedCommands: false,
};

describe("Footer hidden prop", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const render = (hidden?: boolean) => {
        act(() => {
            root.render(<Footer {...baseProps} hidden={hidden} />);
        });
        return container.querySelector("footer") as HTMLElement;
    };

    it("keeps the composer mounted while hiding the footer", () => {
        const footer = render(true);
        expect(footer.style.display).toBe("none");
        expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    });

    it("shows the footer when not hidden", () => {
        const footer = render(false);
        expect(footer.style.display).toBe("");
        expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    });

    it("does not remount the composer when hidden is toggled", () => {
        render(false);
        const before = container.querySelector('[data-testid="composer"]');
        render(true);
        expect(container.querySelector('[data-testid="composer"]')).toBe(before);
    });
});
