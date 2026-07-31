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

import {
    buildHelperCategory,
    CURRENT_INTEGRATION_CATEGORY_TITLE,
    findCurrentIntegrationCategory,
    getHelperCategoryPath,
    getItemKind,
    normalizeFunctionSearchCategories,
} from "./function-category";

const buildTestHelperCategory = (category: any) => buildHelperCategory(
    category,
    "AVAILABLE",
    (item) => item.metadata.label,
    (label, items) => ({ label, items }),
    (label, items, subCategory) => ({ label, items, subCategory }),
    (item) => item.metadata.label !== "Agent Tools"
);

describe("normalizeFunctionSearchCategories", () => {
    it("maps integration-specific and legacy labels to the current-integration category", () => {
        const categories = normalizeFunctionSearchCategories([
            {
                metadata: {
                    label: "Workflows",
                    description: "Workflows defined within the current integration",
                },
                items: [],
            } as any,
        ]);

        expect(categories[0].metadata.label).toBe(CURRENT_INTEGRATION_CATEGORY_TITLE);
        expect(categories[0].metadata.description).toBe("Workflows defined within the current integration");
    });

    it("normalizes aliases recursively without folding workspace categories into the current integration", () => {
        const categories = normalizeFunctionSearchCategories([
            {
                metadata: { label: "Within Project" },
                items: [
                    { metadata: { label: "orders (Current Integration)" }, items: [] },
                ],
            } as any,
        ]);

        expect(categories[0].metadata.label).toBe("Within Project");
        expect((categories[0].items[0] as any).metadata.label)
            .toBe(`orders (${CURRENT_INTEGRATION_CATEGORY_TITLE})`);
    });

    it("leaves unrelated categories unchanged", () => {
        const categories = normalizeFunctionSearchCategories([
            { metadata: { label: "Imported Modules" }, items: [] } as any,
        ]);

        expect(categories[0].metadata.label).toBe("Imported Modules");
    });

    it("preserves missing and non-category entries while normalizing valid categories", () => {
        const categoryWithoutItems = { metadata: { label: "Project" } };
        const nonCategoryItem = { metadata: { label: "Project" } };
        const categories = normalizeFunctionSearchCategories([
            null,
            categoryWithoutItems,
            {
                metadata: { label: "Project" },
                items: [
                    undefined,
                    nonCategoryItem,
                    { metadata: { label: "Activities" }, items: [] },
                ],
            },
        ] as any);

        expect(categories[0]).toBeNull();
        expect(categories[1]).toBe(categoryWithoutItems);
        expect(categories[2].metadata.label).toBe(CURRENT_INTEGRATION_CATEGORY_TITLE);
        expect(categories[2].items[0]).toBeUndefined();
        expect(categories[2].items[1]).toBe(nonCategoryItem);
        expect((categories[2].items[2] as any).metadata.label)
            .toBe(CURRENT_INTEGRATION_CATEGORY_TITLE);
    });
});

describe("getItemKind", () => {
    it("keeps current-module items unqualified", () => {
        expect(getItemKind({ data: { moduleRelation: "CURRENT_MODULE" } }, "AVAILABLE"))
            .toBe("CURRENT");
    });

    it.each(["SAME_PACKAGE_MODULE", "WORKSPACE_PACKAGE_MODULE"] as const)(
        "uses import semantics for %s items in workspace-local categories",
        (moduleRelation) => {
            expect(getItemKind({ data: { moduleRelation } }, "CURRENT"))
                .toBe("IMPORTED");
        }
    );

    it("preserves category fallback for external items", () => {
        expect(getItemKind(undefined, "AVAILABLE")).toBe("AVAILABLE");
    });

    it("preserves category fallback for an unrecognized module relation", () => {
        expect(getItemKind({ data: { moduleRelation: "FUTURE_MODULE_RELATION" } }, "AVAILABLE"))
            .toBe("AVAILABLE");
    });
});

describe("findCurrentIntegrationCategory", () => {
    it("finds the current integration inside the workspace hierarchy", () => {
        const category = findCurrentIntegrationCategory([
            { title: "Imported Modules", items: [] } as any,
            {
                title: "Within Project",
                items: [
                    { title: `orders (${CURRENT_INTEGRATION_CATEGORY_TITLE})`, items: [] },
                ],
            } as any,
        ]);

        expect(category?.title).toBe(`orders (${CURRENT_INTEGRATION_CATEGORY_TITLE})`);
    });
});

describe("getHelperCategoryPath", () => {
    it.each([
        ["DEFAULT_MODULE", "edi_parser"],
        ["SUBMODULE", "edi_parser.mINVOIC"],
    ])("collapses the package path for a %s category", (moduleKind, moduleName) => {
        const path = getHelperCategoryPath(["edi_parser"], {
            metadata: { label: moduleName },
            items: [{
                metadata: { label: "function" },
                codedata: { data: { moduleKind } },
            }],
        } as any);

        expect(path).toEqual([moduleName]);
    });

    it("retains parent labels for non-module categories", () => {
        const path = getHelperCategoryPath(["parent"], {
            metadata: { label: "child" },
            items: [],
        } as any);

        expect(path).toEqual(["parent", "child"]);
    });
});

describe("buildHelperCategory", () => {
    it("maps direct and nested items through the shared category traversal", () => {
        const category = buildTestHelperCategory({
            metadata: { label: "Within Project" },
            items: [
                {
                    metadata: { label: "directFunction" },
                    codedata: { module: "orders" },
                },
                {
                    metadata: { label: "orders.helpers" },
                    items: [{
                        metadata: { label: "helperFunction" },
                        codedata: { module: "orders.helpers" },
                    }],
                },
            ],
        });

        expect(category).toEqual({
            label: "Within Project",
            items: undefined,
            subCategory: [
                { label: "orders", items: ["directFunction"] },
                { label: "orders.helpers", items: ["helperFunction"] },
            ],
        });
    });

    it("omits empty results and filtered Agent Tools categories", () => {
        const category = buildTestHelperCategory({
            metadata: { label: "Current Integration" },
            items: [{
                metadata: { label: "Agent Tools" },
                items: [{
                    metadata: { label: "toolFunction" },
                    codedata: { module: "orders" },
                }],
            }],
        });

        expect(category).toEqual({
            label: "Current Integration",
            items: undefined,
            subCategory: undefined,
        });
    });
});
