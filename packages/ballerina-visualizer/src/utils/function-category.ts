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

import type { AvailableNode, Category, CodeData, FunctionKind } from "@wso2/ballerina-core";
import type { Category as PanelCategory } from "@wso2/ballerina-side-panel";

export const CURRENT_INTEGRATION_CATEGORY_TITLE = "Current Integration";

const CURRENT_INTEGRATION_CATEGORY_ALIASES = new Set([
    CURRENT_INTEGRATION_CATEGORY_TITLE,
    "Project",
    "Current Project",
    "Workflows",
    "Activities",
]);

export function normalizeFunctionSearchCategories(categories: Category[]): Category[] {
    return categories.map(normalizeFunctionSearchCategory);
}

function normalizeFunctionSearchCategory(category: Category): Category {
    if (!category || !Array.isArray(category.items)) {
        return category;
    }
    const originalLabel = category?.metadata?.label;
    const label = CURRENT_INTEGRATION_CATEGORY_ALIASES.has(originalLabel)
        ? CURRENT_INTEGRATION_CATEGORY_TITLE
        : originalLabel;
    return {
        ...category,
        metadata: {
            ...category.metadata,
            label,
        },
        items: category.items.map((item) => {
            if (!item || "codedata" in item || !("items" in item)) {
                return item;
            }
            return normalizeFunctionSearchCategory(item as Category);
        }),
    };
}

export function findCurrentIntegrationCategory(categories: PanelCategory[]): PanelCategory | undefined {
    for (const category of categories) {
        if (category.title === CURRENT_INTEGRATION_CATEGORY_TITLE
                || category.title.endsWith(`(${CURRENT_INTEGRATION_CATEGORY_TITLE})`)) {
            return category;
        }
        const childCategories = category.items.filter(
            (item): item is PanelCategory => "items" in item
        );
        const currentIntegration = findCurrentIntegrationCategory(childCategories);
        if (currentIntegration) {
            return currentIntegration;
        }
    }
    return undefined;
}

export function getItemKind(codedata: CodeData | undefined, fallback: FunctionKind): FunctionKind {
    const relation = codedata?.data?.moduleRelation;
    if (relation === "CURRENT_MODULE") {
        return "CURRENT";
    }
    if (relation === "SAME_PACKAGE_MODULE" || relation === "WORKSPACE_PACKAGE_MODULE") {
        return "IMPORTED";
    }
    return fallback;
}

export function getHelperCategoryPath(parents: string[], category: Category): string[] {
    const containsModuleItems = category.items.some((item) =>
        "codedata" in item && Boolean((item as AvailableNode).codedata?.data?.moduleKind)
    );
    return containsModuleItems ? [category.metadata.label] : [...parents, category.metadata.label];
}
