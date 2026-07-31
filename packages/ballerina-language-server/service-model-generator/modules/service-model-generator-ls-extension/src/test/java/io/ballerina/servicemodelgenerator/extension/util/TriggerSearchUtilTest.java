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
import io.ballerina.centralconnector.response.ConnectorResponse;
import io.ballerina.centralconnector.response.ConnectorsResponse;
import io.ballerina.centralconnector.response.DependentPackage;
import io.ballerina.centralconnector.response.FunctionResponse;
import io.ballerina.centralconnector.response.FunctionsResponse;
import io.ballerina.centralconnector.response.Listeners;
import io.ballerina.centralconnector.response.PackageResponse;
import io.ballerina.centralconnector.response.SymbolResponse;
import io.ballerina.servicemodelgenerator.extension.model.TriggerBasicInfo;
import org.testng.Assert;
import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Unit tests for {@link TriggerSearchUtil}: the Central trigger-identification heuristic and the
 * package -> {@link TriggerBasicInfo} mapping/filtering, exercised without a network call.
 *
 * <p>{@link #testSearchLocalRepository()} is the exception: {@code searchLocalRepository} resolves
 * against the real, machine-wide {@code ~/.ballerina/repositories/local} directory (there is no
 * injectable/fake repository root), so that one test writes small fixture packages directly there
 * ({@code @BeforeClass}) and removes them afterward ({@code @AfterClass}).
 *
 * @since 1.8.0
 */
public class TriggerSearchUtilTest {

    private static final String LOCAL_ORG = "triggersearchutiltest";
    private static final String WITH_SCHEMA_PACKAGE = "hasschema";
    private static final String WITHOUT_SCHEMA_PACKAGE = "noschema";
    private static final String LOCAL_VERSION = "0.1.0";

    private static Path localRepoOrgDir() {
        return Path.of(System.getProperty("user.home"), ".ballerina", "repositories", "local", "bala", LOCAL_ORG);
    }

    @BeforeClass
    public void setUpLocalRepositoryFixtures() throws IOException {
        writeFixturePackage(WITH_SCHEMA_PACKAGE, true);
        writeFixturePackage(WITHOUT_SCHEMA_PACKAGE, false);
    }

    @AfterClass
    public void tearDownLocalRepositoryFixtures() throws IOException {
        Path orgDir = localRepoOrgDir();
        if (!Files.exists(orgDir)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(orgDir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // best-effort cleanup of a test-owned fixture directory
                }
            });
        }
    }

    private static void writeFixturePackage(String packageName, boolean withTriggerSchema) throws IOException {
        Path root = localRepoOrgDir().resolve(packageName).resolve(LOCAL_VERSION).resolve("any");
        Files.createDirectories(root.resolve("modules").resolve(packageName));
        Files.createDirectories(root.resolve("docs"));
        Files.writeString(root.resolve("package.json"), """
                {
                  "organization": "%s",
                  "name": "%s",
                  "version": "%s",
                  "export": ["%s"],
                  "ballerina_version": "2201.13.4",
                  "implementation_vendor": "WSO2",
                  "language_spec_version": "2024R1",
                  "platform": "any",
                  "graalvmCompatible": true,
                  "template": false,
                  "readme": "docs/README.md"
                }""".formatted(LOCAL_ORG, packageName, LOCAL_VERSION, packageName));
        Files.writeString(root.resolve("bala.json"), """
                {
                  "bala_version": "3.0.0",
                  "built_by": "WSO2"
                }""");
        Files.writeString(root.resolve("dependency-graph.json"), """
                {
                  "packages": [
                    {"org": "%s", "name": "%s", "version": "%s", "transitive": false,
                     "dependencies": [], "modules": []}
                  ],
                  "modules": [
                    {"org": "%s", "package_name": "%s", "version": "%s", "module_name": "%s",
                     "dependencies": []}
                  ]
                }""".formatted(LOCAL_ORG, packageName, LOCAL_VERSION, LOCAL_ORG, packageName, LOCAL_VERSION,
                packageName));
        Files.writeString(root.resolve("docs").resolve("README.md"), "# " + packageName);
        Files.writeString(root.resolve("modules").resolve(packageName).resolve("main.bal"),
                "public function main() {\n}\n");
        if (withTriggerSchema) {
            Files.createDirectories(root.resolve("resources"));
            Files.writeString(root.resolve("resources").resolve("trigger-ui-schema.json"), """
                    {"schemaVersion": "1.0", "listenerKind": "SINGLE_SELECT_LISTENER"}""");
        }
    }

    @Test
    public void testSearchLocalRepository() {
        List<TriggerBasicInfo> results = TriggerSearchUtil.searchLocalRepository(Set.of());

        Assert.assertTrue(results.stream().anyMatch(r -> LOCAL_ORG.equals(r.orgName())
                        && WITH_SCHEMA_PACKAGE.equals(r.packageName())),
                "a local-repository package shipping trigger-ui-schema.json must be found");
        Assert.assertTrue(results.stream().noneMatch(r -> LOCAL_ORG.equals(r.orgName())
                        && WITHOUT_SCHEMA_PACKAGE.equals(r.packageName())),
                "a local-repository package with no trigger schema file must be excluded");

        List<TriggerBasicInfo> excludingKnown = TriggerSearchUtil.searchLocalRepository(
                Set.of(LOCAL_ORG + "/" + WITH_SCHEMA_PACKAGE));
        Assert.assertTrue(excludingKnown.stream().noneMatch(r -> LOCAL_ORG.equals(r.orgName())
                        && WITH_SCHEMA_PACKAGE.equals(r.packageName())),
                "a package already known locally (existingKeys) must be excluded");
    }

    @Test
    public void testIsTriggerPackage() {
        Assert.assertTrue(TriggerSearchUtil.isTriggerPackage(List.of("messaging", "Trigger"), "salesforce"),
                "keyword 'Trigger' (case-insensitive) marks a trigger");
        Assert.assertTrue(TriggerSearchUtil.isTriggerPackage(List.of("webhook", "listener"), "github"),
                "keyword 'listener' marks a trigger");
        Assert.assertTrue(TriggerSearchUtil.isTriggerPackage(List.of(), "trigger.github"),
                "trigger.* module convention marks a trigger");
        Assert.assertFalse(TriggerSearchUtil.isTriggerPackage(List.of("http", "client"), "foo"),
                "a plain client package is not a trigger");
        Assert.assertFalse(TriggerSearchUtil.isTriggerPackage(null, "foo"),
                "no keywords + non-trigger name -> not a trigger");
    }

    @Test
    public void testTypeTriggerTagIsAuthoritative() {
        // Real Central classification tags (verified against aws.sqs/kafka/rabbitmq), distinct from the
        // bare 'trigger'/'listener'/'event' keywords: 'Type/Trigger' alone must mark a trigger package,
        // case-insensitively, without needing any other keyword or the trigger.* naming convention.
        Assert.assertTrue(TriggerSearchUtil.isTriggerPackage(
                        List.of("IT Operations/Message Brokers", "Vendor/Amazon", "Type/Connector", "Type/Trigger"),
                        "aws.sqs"),
                "the Type/Trigger tag alone marks a trigger");
        Assert.assertTrue(TriggerSearchUtil.isTriggerPackage(List.of("type/trigger"), "kafka"),
                "the Type/Trigger tag is matched case-insensitively");
        Assert.assertFalse(TriggerSearchUtil.isTriggerPackage(List.of("Type/Connector", "Type/Library"), "aws"),
                "Type/Connector or Type/Library alone do not mark a trigger");
    }

    @Test
    public void testDisplayNameHumanizesPackageNames() {
        Assert.assertEquals(TriggerSearchUtil.displayName("trigger.github"), "Github",
                "the trigger. family prefix is dropped, keeping only the connector name");
        Assert.assertEquals(TriggerSearchUtil.displayName("confluent.cavroserdes"), "Cavroserdes",
                "a vendor-namespaced package keeps only the trailing segment");
        Assert.assertEquals(TriggerSearchUtil.displayName("cdc-mysql"), "Cdc Mysql",
                "every hyphen-separated word is Title-Cased, not just the first");
        Assert.assertEquals(TriggerSearchUtil.displayName("kafka"), "Kafka",
                "a single lowercase word is capitalized");
        Assert.assertEquals(TriggerSearchUtil.displayName("googleapis.gmail"), "Gmail",
                "only the trailing segment survives");
    }

    @Test
    public void testToTriggerResultsFiltersAndMaps() {
        PackageResponse response = new PackageResponse(
                List.of(
                        pkg("ballerinax", "mqtt", "1.0.0", List.of("mqtt", "listener"), "MQTT trigger", "mqtt-icon"),
                        pkg("ballerinax", "somehttpclient", "2.0.0", List.of("http", "client"), "", ""),
                        pkg("ballerinax", "kafka", "4.5.0", List.of("kafka", "trigger"), "Kafka", "kafka-icon")),
                List.of(), null, 3, 0, 30);

        // kafka is already known locally, so it must be excluded.
        List<TriggerBasicInfo> results = TriggerSearchUtil.toTriggerResults(response, Set.of("ballerinax/kafka"));

        Assert.assertEquals(results.size(), 1, "only the non-local trigger package survives");
        TriggerBasicInfo mqtt = results.getFirst();
        Assert.assertEquals(mqtt.orgName(), "ballerinax");
        Assert.assertEquals(mqtt.packageName(), "mqtt");
        Assert.assertEquals(mqtt.type(), "event", "results render under Event Integration");
        Assert.assertEquals(mqtt.icon(), "mqtt-icon");
        Assert.assertEquals(mqtt.listenerProtocol(), "mqtt");
    }

    @Test
    public void testPackageWithoutTriggerSignalExcluded() {
        // No network-bound Listener-export fallback exists: a package lacking a trigger keyword, the
        // Type/Trigger tag, and the trigger.* naming convention is excluded even if (like the real
        // smb/mqtt packages) it happens to export a Listener -- there is nothing here that can tell.
        PackageResponse response = new PackageResponse(
                List.of(
                        pkg("ballerinax", "activemq", "1.0.0", List.of("messaging", "jms"), "ActiveMQ", "amq-icon"),
                        pkg("ballerinax", "somehttpclient", "2.0.0", List.of("http", "client"), "", "")),
                List.of(), null, 2, 0, 30);

        List<TriggerBasicInfo> results = TriggerSearchUtil.toTriggerResults(response, Set.of());

        Assert.assertTrue(results.isEmpty(), "neither package carries a trigger signal");
    }

    @Test
    public void testSearchCentralScopesToBallerinaAndBallerinaxOnly() {
        // Central's search-packages 'q' string only accepts a single 'org:<name>' token per call, so
        // searchCentral issues one call per allowed org, concurrently, and merges -- verify both org-scoped
        // queries actually happen (order is not guaranteed since they race), and that a package returned
        // under a non-ballerina/ballerinax org can never appear (the fake never even offers one, mirroring
        // what a real org: filter would enforce).
        FakeCentralAPI central = new FakeCentralAPI();
        central.responsesByOrg.put("ballerina", new PackageResponse(
                List.of(pkg("ballerina", "mqtt", "1.0.0", List.of("mqtt", "listener"), "MQTT", "mqtt-icon")),
                List.of(), null, 1, 0, 30));
        central.responsesByOrg.put("ballerinax", new PackageResponse(
                List.of(pkg("ballerinax", "kafka", "4.5.0", List.of("Type/Trigger"), "Kafka", "kafka-icon")),
                List.of(), null, 1, 0, 30));

        List<TriggerBasicInfo> results = TriggerSearchUtil.searchCentral(central, "trigger", null, null, Set.of());

        Assert.assertEquals(central.queriesSent.size(), 2, "one search call per allowed org");
        Assert.assertTrue(central.queriesSent.stream().anyMatch(q -> q.get("q").endsWith("org:ballerina")));
        Assert.assertTrue(central.queriesSent.stream().anyMatch(q -> q.get("q").endsWith("org:ballerinax")));
        Assert.assertEquals(results.size(), 2, "results from both allowed orgs are merged");
        Assert.assertTrue(results.stream().anyMatch(r -> r.orgName().equals("ballerina")
                && r.packageName().equals("mqtt")));
        Assert.assertTrue(results.stream().anyMatch(r -> r.orgName().equals("ballerinax")
                && r.packageName().equals("kafka")));
    }

    @Test
    public void testDeprecatedPackagesSkipped() {
        PackageResponse response = new PackageResponse(
                List.of(deprecated("ballerinax", "oldtrigger", List.of("trigger"))),
                List.of(), null, 1, 0, 30);
        Assert.assertTrue(TriggerSearchUtil.toTriggerResults(response, Set.of()).isEmpty(),
                "deprecated trigger packages are not offered");
    }

    private static PackageResponse.Package pkg(String org, String name, String version, List<String> keywords,
                                               String summary, String icon) {
        return build(org, name, version, keywords, summary, icon, false);
    }

    private static PackageResponse.Package deprecated(String org, String name, List<String> keywords) {
        return build(org, name, "1.0.0", keywords, "", "", true);
    }

    private static PackageResponse.Package build(String org, String name, String version, List<String> keywords,
                                                 String summary, String icon, boolean deprecatedFlag) {
        return new PackageResponse.Package(
                1, org, name, version, "java21", "2201.0.0", deprecatedFlag, "", "", version, "", "",
                summary, "", false, List.of(), List.of(), "", keywords, "2201.0.0", icon, "", 0L, 0,
                "public", List.of(), "", "true");
    }

    /**
     * A minimal {@link CentralAPI} test double: records every {@code searchPackages} query and returns a
     * canned {@link PackageResponse} keyed by the query's {@code org:<name>} token, so
     * {@code searchCentral}'s per-org querying can be verified without a network call.
     * {@code searchCentral} now issues its per-org queries concurrently, so {@code searchPackages} may be
     * invoked from multiple threads at once -- {@code queriesSent} must therefore be a thread-safe list.
     */
    private static final class FakeCentralAPI implements CentralAPI {

        final Map<String, PackageResponse> responsesByOrg = new HashMap<>();
        final List<Map<String, String>> queriesSent = Collections.synchronizedList(new ArrayList<>());

        @Override
        public PackageResponse searchPackages(Map<String, String> queryMap) {
            queriesSent.add(queryMap);
            String q = queryMap.get("q");
            for (Map.Entry<String, PackageResponse> entry : responsesByOrg.entrySet()) {
                if (q != null && q.endsWith("org:" + entry.getKey())) {
                    return entry.getValue();
                }
            }
            return new PackageResponse(List.of(), List.of(), null, 0, 0, 30);
        }

        @Override
        public SymbolResponse searchSymbols(Map<String, String> queryMap) {
            return null;
        }

        @Override
        public FunctionsResponse functions(String organization, String name, String version) {
            return null;
        }

        @Override
        public Listeners listeners(String organization, String name, String version) {
            return null;
        }

        @Override
        public FunctionResponse function(String organization, String name, String version, String functionName) {
            return null;
        }

        @Override
        public ConnectorsResponse connectors(Map<String, String> queryMap) {
            return null;
        }

        @Override
        public ConnectorResponse connector(String id) {
            return null;
        }

        @Override
        public ConnectorResponse connector(String organization, String name, String version, String clientName) {
            return null;
        }

        @Override
        public String latestPackageVersion(String org, String name) {
            return null;
        }

        @Override
        public List<String> allPackageVersions(String org, String name) {
            return List.of();
        }

        @Override
        public Map<String, List<DependentPackage>> dependentPackages(String org, String packageName,
                                                                      List<String> versions) {
            return Map.of();
        }

        @Override
        public Map<String, List<String>> packageKeywords(List<DependentPackage> modules) {
            return Map.of();
        }

        @Override
        public boolean hasAuthorizedAccess() {
            return false;
        }
    }
}
