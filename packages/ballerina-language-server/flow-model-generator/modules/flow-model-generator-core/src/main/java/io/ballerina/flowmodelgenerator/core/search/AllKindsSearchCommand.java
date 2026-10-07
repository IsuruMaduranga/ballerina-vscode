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

package io.ballerina.flowmodelgenerator.core.search;

import io.ballerina.flowmodelgenerator.core.model.Item;
import io.ballerina.modelgenerator.commons.SearchResult;
import io.ballerina.projects.Document;
import io.ballerina.projects.Project;
import io.ballerina.tools.text.LineRange;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Search command behind the node panel's master search. It runs the function search and the connector search side by
 * side and merges their results, so the master search returns exactly what "Call a Function" and "Add Connection"
 * return for the same query: the same data source (Ballerina Central, falling back to the local index), the same
 * organization and package filters, and the same categories.
 *
 * <p>The function results keep their own categories (current integration or workspace, agent tools, imported
 * functions, standard library and extended library). The connector search returns its nodes ungrouped, so they are
 * placed under a single {@value #CONNECTORS_CATEGORY} category.</p>
 *
 * @since 1.7.0
 */
public class AllKindsSearchCommand extends SearchCommand {

    private static final String CONNECTORS_CATEGORY = "Connectors";
    private static final int MIN_KIND_LIMIT = 10;

    private final Document functionsDoc;

    public AllKindsSearchCommand(Project project, LineRange position, Map<String, String> queryMap,
                                 Document functionsDoc) {
        super(project, position, queryMap);
        this.functionsDoc = functionsDoc;
    }

    @Override
    protected List<Item> defaultView() {
        return searchAllKinds();
    }

    @Override
    protected List<Item> search() {
        return searchAllKinds();
    }

    @Override
    protected Map<String, List<SearchResult>> fetchPopularItems() {
        // The delegated commands fetch and cache their own popular items.
        return Map.of();
    }

    /**
     * Runs the function and connector searches in parallel and merges their results. Both searches wait on Ballerina
     * Central, so running them side by side bounds the latency to the slower of the two rather than their sum.
     */
    private List<Item> searchAllKinds() {
        SearchCommand functionSearch = new FunctionSearchCommand(project, position, kindQueryMap(), functionsDoc);
        SearchCommand connectorSearch = new ConnectorSearchCommand(project, position, kindQueryMap());

        ExecutorService executorService = Executors.newFixedThreadPool(2);
        try {
            CompletableFuture<List<Item>> functionItems =
                    CompletableFuture.supplyAsync(() -> run(functionSearch), executorService);
            CompletableFuture<List<Item>> connectorItems =
                    CompletableFuture.supplyAsync(() -> run(connectorSearch), executorService);

            List<Item> functions = join(functionItems);
            List<Item> connectors = join(connectorItems);

            List<Item> allItems = new ArrayList<>(functions);
            if (!connectors.isEmpty()) {
                allItems.add(rootBuilder.stepIn(CONNECTORS_CATEGORY, null, null).items(connectors).build());
            }
            return allItems;
        } finally {
            executorService.shutdown();
        }
    }

    /**
     * Runs a delegated command the same way {@link SearchCommand#execute()} would for this request.
     */
    private List<Item> run(SearchCommand command) {
        return query.isEmpty() ? command.defaultView() : command.search();
    }

    private static List<Item> join(CompletableFuture<List<Item>> future) {
        try {
            List<Item> items = future.join();
            return items != null ? items : List.of();
        } catch (CompletionException e) {
            // One kind failing must not hide the results of the other.
            return List.of();
        }
    }

    /**
     * The query map for a delegated command. The page is split evenly between functions and connectors.
     */
    private Map<String, String> kindQueryMap() {
        Map<String, String> kindQueryMap = new HashMap<>();
        kindQueryMap.put("q", query);
        kindQueryMap.put("limit", String.valueOf(Math.max(MIN_KIND_LIMIT, limit / 2)));
        kindQueryMap.put("offset", String.valueOf(offset));
        return kindQueryMap;
    }
}
