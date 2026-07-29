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

import io.ballerina.centralconnector.response.PackageResponse;
import io.ballerina.servicemodelgenerator.extension.model.TriggerBasicInfo;
import org.testng.Assert;
import org.testng.annotations.Test;

import java.util.List;
import java.util.Set;

/**
 * Unit tests for {@link TriggerSearchUtil}: the Central trigger-identification heuristic and the
 * package -> {@link TriggerBasicInfo} mapping/filtering, exercised without a network call.
 *
 * @since 1.8.0
 */
public class TriggerSearchUtilTest {

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
    public void testListenerBackedPackageIncludedWithoutTriggerKeyword() {
        // activemq/aws.sqs/smb are triggers but may lack an 'event'/'trigger'/'listener' keyword. They
        // must still appear when they export a Listener (the authoritative signal).
        PackageResponse response = new PackageResponse(
                List.of(
                        pkg("ballerinax", "activemq", "1.0.0", List.of("messaging", "jms"), "ActiveMQ", "amq-icon"),
                        pkg("ballerinax", "somehttpclient", "2.0.0", List.of("http", "client"), "", "")),
                List.of(), null, 2, 0, 30);

        // Pretend only activemq exports a Listener.
        java.util.function.Predicate<PackageResponse.Package> exportsListener =
                p -> "activemq".equals(p.name());
        List<TriggerBasicInfo> results = TriggerSearchUtil.toTriggerResults(response, Set.of(), exportsListener);

        Assert.assertEquals(results.size(), 1, "only the listener-backed package is included");
        Assert.assertEquals(results.getFirst().packageName(), "activemq");
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
}
