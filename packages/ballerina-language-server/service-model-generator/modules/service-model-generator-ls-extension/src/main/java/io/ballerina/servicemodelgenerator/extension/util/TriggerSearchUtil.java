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

package io.ballerina.servicemodelgenerator.extension.util;

import io.ballerina.centralconnector.CentralAPI;
import io.ballerina.centralconnector.response.PackageResponse;
import io.ballerina.servicemodelgenerator.extension.model.TriggerBasicInfo;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Discovers event-integration <b>trigger</b> packages on Ballerina Central for the "Search more"
 * flow. This complements the locally-bundled trigger index ({@code getTriggerModels}) with a live
 * Central search, so a connector that ships its trigger models can be found and added without a
 * language-server release.
 *
 * <p>Central returns generic package results; a package is treated as a trigger when its keywords
 * signal a listener/trigger, or its module name uses the {@code trigger.*} convention. The pure
 * mapping/filtering helpers are package-visible for unit testing without a network call.
 *
 * @since 1.8.0
 */
public final class TriggerSearchUtil {

    private static final int DEFAULT_LIMIT = 30;
    private static final String EVENT_TYPE = "event";
    private static final String DEFAULT_QUERY = "trigger";
    private static final Set<String> TRIGGER_KEYWORDS = Set.of("trigger", "listener", "event");
    private static final String TRIGGER_TAG_KEYWORD = "type/trigger";
    private static final String TRIGGER_MODULE_PREFIX = "trigger.";
    private static final List<String> ALLOWED_ORGS = List.of("ballerina", "ballerinax");

    private TriggerSearchUtil() {
    }

    /**
     * Searches Central for trigger packages matching {@code query}, restricted to
     * {@code ballerina}/{@code ballerinax}, excluding those already known locally
     * ({@code existingKeys}, each {@code org/name}). Returns an empty list on any failure (e.g.
     * offline) so the caller degrades gracefully to the local list.
     */
    public static List<TriggerBasicInfo> searchCentral(CentralAPI central, String query, Integer limit,
                                                       Integer offset, Set<String> existingKeys) {
        try {
            String effectiveQuery = (query == null || query.isBlank()) ? DEFAULT_QUERY : query.trim();
            int effectiveLimit = limit == null || limit <= 0 ? DEFAULT_LIMIT : limit;
            int effectiveOffset = offset == null || offset < 0 ? 0 : offset;

            // One org can't be expressed per call (see ALLOWED_ORGS), so the per-org Central calls are
            // independent - run them concurrently rather than paying their latency serially.
            List<CompletableFuture<List<TriggerBasicInfo>>> futures = ALLOWED_ORGS.stream()
                    .map(org -> CompletableFuture.supplyAsync(() -> {
                        Map<String, String> queryMap = new HashMap<>();
                        queryMap.put("q", effectiveQuery + " org:" + org);
                        queryMap.put("limit", String.valueOf(effectiveLimit));
                        queryMap.put("offset", String.valueOf(effectiveOffset));
                        PackageResponse response = central.searchPackages(queryMap);
                        return toTriggerResults(response, existingKeys);
                    }))
                    .toList();

            List<TriggerBasicInfo> results = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (CompletableFuture<List<TriggerBasicInfo>> future : futures) {
                for (TriggerBasicInfo info : future.join()) {
                    if (seen.add(info.orgName() + "/" + info.packageName())) {
                        results.add(info);
                    }
                }
            }
            return results.size() > effectiveLimit ? results.subList(0, effectiveLimit) : results;
        } catch (Throwable e) {
            return List.of();
        }
    }

    /**
     * Filters a Central package response to trigger packages and maps them to {@link TriggerBasicInfo},
     * skipping any already present locally. Pure; unit-testable without a network call.
     */
    static List<TriggerBasicInfo> toTriggerResults(PackageResponse response, Set<String> existingKeys) {
        List<TriggerBasicInfo> results = new ArrayList<>();
        if (response == null || response.packages() == null) {
            return results;
        }
        Set<String> known = existingKeys == null ? Set.of() : existingKeys;
        for (PackageResponse.Package pkg : response.packages()) {
            if (pkg == null || pkg.isDeprecated()) {
                continue;
            }
            if (known.contains(key(pkg.organization(), pkg.name()))) {
                continue;
            }
            if (!isTriggerPackage(pkg.keywords(), pkg.name())) {
                continue;
            }
            results.add(toTriggerBasicInfo(pkg));
        }
        return results;
    }

    /**
     * Whether a Central package is an event-integration trigger, based on its {@code Type/Trigger}
     * classification tag, a bare trigger/listener/event keyword, or the {@code trigger.*} module-name
     * convention. {@code Type/Trigger} is Central's own curated classification (e.g. {@code aws.sqs},
     * {@code kafka}, {@code rabbitmq}). A package that exports a Listener but carries none of these
     * signals (e.g. {@code smb}, {@code mqtt}) is not detected -- there is no network-bound fallback.
     */
    static boolean isTriggerPackage(List<String> keywords, String name) {
        if (name != null && name.toLowerCase(Locale.US).startsWith(TRIGGER_MODULE_PREFIX)) {
            return true;
        }
        if (keywords == null) {
            return false;
        }
        return keywords.stream()
                .filter(Objects::nonNull)
                .map(k -> k.toLowerCase(Locale.US))
                .anyMatch(k -> TRIGGER_KEYWORDS.contains(k) || TRIGGER_TAG_KEYWORD.equals(k));
    }

    static TriggerBasicInfo toTriggerBasicInfo(PackageResponse.Package pkg) {
        String protocol = ServiceModelUtils.getProtocol(pkg.name());
        return new TriggerBasicInfo(
                pkg.id(),
                pkg.name(),
                pkg.organization(),
                pkg.name(),
                pkg.name(),
                pkg.version(),
                EVENT_TYPE,
                displayName(pkg.name()),
                pkg.summary() == null ? "" : pkg.summary(),
                protocol,
                pkg.icon() == null ? "" : pkg.icon());
    }

    private static String key(String org, String name) {
        return org + "/" + name;
    }

    /**
     * Humanizes a Central package name for display: drops the leading org/family segment up to the
     * last {@code .} (e.g. {@code trigger.github} -> {@code github}, {@code confluent.cavroserdes} ->
     * {@code cavroserdes}), then Title-Cases every {@code -}/{@code _}-separated word (e.g.
     * {@code cdc-mysql} -> {@code Cdc Mysql}). Central package names are conventionally all-lowercase, so
     * every word needs capitalizing here, unlike {@code TriggerModelSynthesizer.humanize} which only
     * capitalizes the first letter of an already-camelCased identifier.
     */
    static String displayName(String name) {
        if (name == null || name.isEmpty()) {
            return name;
        }
        String segment = name.substring(name.lastIndexOf('.') + 1);
        StringBuilder result = new StringBuilder();
        for (String word : segment.replace('_', ' ').replace('-', ' ').trim().split("\\s+")) {
            if (word.isEmpty()) {
                continue;
            }
            if (!result.isEmpty()) {
                result.append(' ');
            }
            result.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
        }
        return result.isEmpty() ? segment : result.toString();
    }
}
