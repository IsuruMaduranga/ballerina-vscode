/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

package io.ballerina.flowmodelgenerator.core;

import io.ballerina.flowmodelgenerator.core.model.AvailableNode;
import io.ballerina.flowmodelgenerator.core.model.Category;
import io.ballerina.flowmodelgenerator.core.model.Codedata;
import io.ballerina.flowmodelgenerator.core.model.Metadata;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import org.testng.Assert;
import org.testng.annotations.Test;

import java.util.List;

/**
 * Tests adaptive package grouping for AI component search results.
 *
 * @since 1.8.0
 */
public class AiUtilsGroupingTest {

    private static final List<String> AI_COMPONENT_CATEGORY_LABELS = List.of(
            "Model Providers", "Embedding Providers", "Vector Stores", "Chunkers", "Data Loaders",
            "Memory Stores", "Knowledge Bases");

    @Test(description = "Keeps packages with a single component as direct selectable leaves.")
    public void testSingleComponentPackageRemainsFlat() {
        AvailableNode openAi = component("OpenAI Model Provider", "ai.openai", "OpenAiModelProvider");

        Category category = AiUtils.buildAdaptiveAiComponentCategory("Model Providers", List.of(openAi), null);

        Assert.assertEquals(category.items(), List.of(openAi));
    }

    @Test(description = "Groups multiple implementations from one package while preserving leaf codedata.")
    public void testMultiComponentPackageIsGrouped() {
        AvailableNode openAi = component("OpenAI Model Provider", "ai.openai", "OpenAiModelProvider");
        AvailableNode azureOpenAi = component("Azure OpenAI Model Provider", "ai.azure", "AzureOpenAiModelProvider");
        AvailableNode azureAnthropic = component("Azure Anthropic Model Provider", "ai.azure",
                "AzureAnthropicModelProvider");

        Category category = AiUtils.buildAdaptiveAiComponentCategory("Model Providers",
                List.of(openAi, azureOpenAi, azureAnthropic), null);

        Assert.assertEquals(category.items().size(), 2);
        Category azure = (Category) category.items().getFirst();
        Assert.assertEquals(azure.metadata().label(), "Azure Model Providers");
        Assert.assertEquals(azure.items(), List.of(azureAnthropic, azureOpenAi));
        Assert.assertSame(((AvailableNode) azure.items().get(1)).codedata(), azureOpenAi.codedata());
        Assert.assertSame(category.items().get(1), openAi);
    }

    @Test(description = "Filters grouped packages by subtype and retains all children when the package matches.")
    public void testGroupedPackageSearch() {
        AvailableNode azureOpenAi = component("Azure OpenAI Model Provider", "ai.azure", "AzureOpenAiModelProvider");
        AvailableNode azureAnthropic = component("Azure Anthropic Model Provider", "ai.azure",
                "AzureAnthropicModelProvider");

        Category subtypeSearch = AiUtils.buildAdaptiveAiComponentCategory("Model Providers",
                List.of(azureOpenAi, azureAnthropic), "Anthropic");
        Category azureFromSubtypeSearch = (Category) subtypeSearch.items().getFirst();
        Assert.assertEquals(azureFromSubtypeSearch.items(), List.of(azureAnthropic));

        Category packageSearch = AiUtils.buildAdaptiveAiComponentCategory("Model Providers",
                List.of(azureOpenAi, azureAnthropic), "Azure");
        Category azureFromPackageSearch = (Category) packageSearch.items().getFirst();
        Assert.assertEquals(azureFromPackageSearch.items(), List.of(azureAnthropic, azureOpenAi));
    }

    @Test(description = "Builds categories for every supported AI component type using the shared grouping helper.")
    public void testAllAiComponentCategoriesUseSharedGrouping() {
        List<AvailableNode> components = List.of(
                component("Azure First", "ai.azure", "AzureFirst"),
                component("Azure Second", "ai.azure", "AzureSecond"));

        for (String categoryLabel : AI_COMPONENT_CATEGORY_LABELS) {
            Category category = AiUtils.buildAdaptiveAiComponentCategory(categoryLabel, components, null);
            Assert.assertEquals(category.metadata().label(), categoryLabel);
            Assert.assertTrue(category.items().getFirst() instanceof Category);
        }
    }

    private static AvailableNode component(String label, String packageName, String object) {
        return new AvailableNode(
                new Metadata(label, label + " description", null, "icon-" + packageName, null, null, null),
                new Codedata(NodeKind.MODEL_PROVIDER, "ballerinax", packageName, packageName, object, "init",
                        "1.0.0", null, null, null, null, null, false, false, null, null),
                true);
    }
}
