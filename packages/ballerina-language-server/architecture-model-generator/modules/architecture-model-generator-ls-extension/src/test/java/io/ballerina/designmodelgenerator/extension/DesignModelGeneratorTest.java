/*
 *  Copyright (c) 2024, WSO2 LLC. (http://www.wso2.com)
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

package io.ballerina.designmodelgenerator.extension;

import com.google.gson.JsonObject;
import io.ballerina.designmodelgenerator.core.model.Activity;
import io.ballerina.designmodelgenerator.core.model.Automation;
import io.ballerina.designmodelgenerator.core.model.Connection;
import io.ballerina.designmodelgenerator.core.model.DesignModel;
import io.ballerina.designmodelgenerator.core.model.Listener;
import io.ballerina.designmodelgenerator.core.model.Service;
import io.ballerina.designmodelgenerator.core.model.Workflow;
import io.ballerina.designmodelgenerator.extension.request.GetDesignModelRequest;
import io.ballerina.designmodelgenerator.extension.response.GetDesignModelResponse;
import io.ballerina.modelgenerator.commons.AbstractLSTest;
import org.testng.Assert;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Tests for getting the design model for a package.
 *
 * @since 1.0.0
 */
public class DesignModelGeneratorTest extends AbstractLSTest {

    @Override
    @Test(dataProvider = "data-provider")
    public void test(Path config) throws IOException {
        Path configJsonPath = configDir.resolve(config);
        TestConfig testConfig = gson.fromJson(Files.newBufferedReader(configJsonPath), TestConfig.class);
        String sourceFile = sourceDir.resolve(testConfig.projectPath()).toAbsolutePath().toString();
        GetDesignModelRequest request = new GetDesignModelRequest(sourceFile);
        JsonObject jsonObject = getResponse(request);
        GetDesignModelResponse expectedResponse = gson.fromJson(testConfig.output, GetDesignModelResponse.class);
        GetDesignModelResponse actualResponse = gson.fromJson(jsonObject, GetDesignModelResponse.class);
        List<String> failures = new ArrayList<>();
        boolean asserted = assertDesignModel(actualResponse.getDesignModel(), expectedResponse.getDesignModel(),
                failures);
        if (!asserted) {
            TestConfig updatedConfig = new TestConfig(testConfig.description(), testConfig.projectPath(), jsonObject);
//            updateConfig(configJsonPath, updatedConfig);
            Assert.fail(String.format("Failed test: '%s' (%s)%n%s", testConfig.description(), configJsonPath,
                    String.join(System.lineSeparator(), failures)));
        }
    }

    private boolean assertDesignModel(DesignModel actual, DesignModel expected, List<String> failures) {
        boolean automationOk = assertAutomation(actual.automation(), expected.automation(), failures);
        boolean connectionsOk = assertConnections(actual.connections(), expected.connections(), failures);
        boolean listenersOk = assertListeners(actual.listeners(), expected.listeners(), failures);
        boolean servicesOk = assertServices(actual.services(), expected.services(), failures);
        boolean workflowsOk = assertWorkflows(actual.workflows(), expected.workflows(), failures);
        boolean activitiesOk = assertActivities(actual.activities(), expected.activities(), failures);
        return automationOk && connectionsOk && listenersOk && servicesOk && workflowsOk && activitiesOk;
    }

    private boolean assertActivities(List<Activity> actual, List<Activity> expected, List<String> failures) {
        int actualSize = actual == null ? 0 : actual.size();
        int expectedSize = expected == null ? 0 : expected.size();
        if (actualSize != expectedSize) {
            failures.add(String.format("Activities: size mismatch, expected %d, actual %d", expectedSize,
                    actualSize));
            return false;
        }
        if (actual == null || expected == null) {
            return true;
        }
        boolean ok = true;
        for (int i = 0; i < actual.size(); i++) {
            Activity actualActivity = actual.get(i);
            Activity expectedActivity = expected.get(i);
            if (!actualActivity.getSymbol().equals(expectedActivity.getSymbol())) {
                failures.add(String.format("Activity[%d]: symbol mismatch, expected '%s', actual '%s'", i,
                        expectedActivity.getSymbol(), actualActivity.getSymbol()));
                ok = false;
            }
            if (!actualActivity.getLocation().equals(expectedActivity.getLocation())) {
                failures.add(String.format("Activity[%d] ('%s'): location mismatch, expected %s, actual %s", i,
                        actualActivity.getSymbol(), expectedActivity.getLocation(), actualActivity.getLocation()));
                ok = false;
            }
            if (actualActivity.getConnections().size() != expectedActivity.getConnections().size()) {
                failures.add(String.format(
                        "Activity[%d] ('%s'): connections size mismatch, expected %d, actual %d", i,
                        actualActivity.getSymbol(), expectedActivity.getConnections().size(),
                        actualActivity.getConnections().size()));
                ok = false;
            }
            if (actualActivity.getAttachedWorkflows().size() != expectedActivity.getAttachedWorkflows().size()) {
                failures.add(String.format(
                        "Activity[%d] ('%s'): attachedWorkflows size mismatch, expected %d, actual %d", i,
                        actualActivity.getSymbol(), expectedActivity.getAttachedWorkflows().size(),
                        actualActivity.getAttachedWorkflows().size()));
                ok = false;
            }
        }
        return ok;
    }

    private boolean assertWorkflows(List<Workflow> actual, List<Workflow> expected, List<String> failures) {
        int actualSize = actual == null ? 0 : actual.size();
        int expectedSize = expected == null ? 0 : expected.size();
        if (actualSize != expectedSize) {
            failures.add(String.format("Workflows: size mismatch, expected %d, actual %d", expectedSize,
                    actualSize));
            return false;
        }
        if (actual == null || expected == null) {
            return true;
        }
        boolean ok = true;
        for (int i = 0; i < actual.size(); i++) {
            Workflow actualWorkflow = actual.get(i);
            Workflow expectedWorkflow = expected.get(i);
            String label = String.format("Workflow[%d] ('%s')", i, actualWorkflow.getSymbol());
            if (!actualWorkflow.getSymbol().equals(expectedWorkflow.getSymbol())) {
                failures.add(String.format("%s: symbol mismatch, expected '%s', actual '%s'", label,
                        expectedWorkflow.getSymbol(), actualWorkflow.getSymbol()));
                ok = false;
            }
            if (!actualWorkflow.getLocation().equals(expectedWorkflow.getLocation())) {
                failures.add(String.format("%s: location mismatch, expected %s, actual %s", label,
                        expectedWorkflow.getLocation(), actualWorkflow.getLocation()));
                ok = false;
            }
            if (actualWorkflow.getAttachedServices().size() != expectedWorkflow.getAttachedServices().size()) {
                failures.add(String.format("%s: attachedServices size mismatch, expected %d, actual %d", label,
                        expectedWorkflow.getAttachedServices().size(), actualWorkflow.getAttachedServices().size()));
                ok = false;
            }
            if (actualWorkflow.getAttachedFunctions().size() != expectedWorkflow.getAttachedFunctions().size()) {
                failures.add(String.format("%s: attachedFunctions size mismatch, expected %d, actual %d", label,
                        expectedWorkflow.getAttachedFunctions().size(),
                        actualWorkflow.getAttachedFunctions().size()));
                ok = false;
            }
            if (sizeOf(actualWorkflow.getHumanTasks()) != sizeOf(expectedWorkflow.getHumanTasks())) {
                failures.add(String.format("%s: humanTasks size mismatch, expected %d, actual %d", label,
                        sizeOf(expectedWorkflow.getHumanTasks()), sizeOf(actualWorkflow.getHumanTasks())));
                ok = false;
            }
            if (sizeOf(actualWorkflow.getActivities()) != sizeOf(expectedWorkflow.getActivities())) {
                failures.add(String.format("%s: activities size mismatch, expected %d, actual %d", label,
                        sizeOf(expectedWorkflow.getActivities()), sizeOf(actualWorkflow.getActivities())));
                ok = false;
            }
            if (!assertWorkflowEvents(actualWorkflow.getEvents(), expectedWorkflow.getEvents(), label, failures)) {
                ok = false;
            }
        }
        return ok;
    }

    private boolean assertWorkflowEvents(List<Workflow.Event> actual, List<Workflow.Event> expected, String label,
                                         List<String> failures) {
        if (sizeOf(actual) != sizeOf(expected)) {
            failures.add(String.format("%s: events size mismatch, expected %d, actual %d", label, sizeOf(expected),
                    sizeOf(actual)));
            return false;
        }
        if (actual == null || expected == null) {
            return true;
        }
        boolean ok = true;
        for (int i = 0; i < actual.size(); i++) {
            Workflow.Event actualEvent = actual.get(i);
            Workflow.Event expectedEvent = expected.get(i);
            String eventLabel = String.format("%s.events[%d] ('%s')", label, i, actualEvent.getName());
            if (!actualEvent.getName().equals(expectedEvent.getName())) {
                failures.add(String.format("%s: name mismatch, expected '%s', actual '%s'", eventLabel,
                        expectedEvent.getName(), actualEvent.getName()));
                ok = false;
            }
            if (!Objects.equals(actualEvent.getType(), expectedEvent.getType())) {
                failures.add(String.format("%s: type mismatch, expected '%s', actual '%s'", eventLabel,
                        expectedEvent.getType(), actualEvent.getType()));
                ok = false;
            }
            if (actualEvent.getAttachedServices().size() != expectedEvent.getAttachedServices().size()) {
                failures.add(String.format("%s: attachedServices size mismatch, expected %d, actual %d", eventLabel,
                        expectedEvent.getAttachedServices().size(), actualEvent.getAttachedServices().size()));
                ok = false;
            }
            if (actualEvent.getAttachedFunctions().size() != expectedEvent.getAttachedFunctions().size()) {
                failures.add(String.format("%s: attachedFunctions size mismatch, expected %d, actual %d", eventLabel,
                        expectedEvent.getAttachedFunctions().size(), actualEvent.getAttachedFunctions().size()));
                ok = false;
            }
        }
        return ok;
    }

    private int sizeOf(Collection<?> collection) {
        return collection == null ? 0 : collection.size();
    }

    private boolean assertServices(List<Service> actual, List<Service> expected, List<String> failures) {
        if (actual.size() != expected.size()) {
            failures.add(String.format(
                    "Services: size mismatch, expected %d %s, actual %d %s", expected.size(),
                    expected.stream().map(Service::getAbsolutePath).toList(), actual.size(),
                    actual.stream().map(Service::getAbsolutePath).toList()));
            return false;
        }
        // Services are generated from an unordered map, so match them by their absolute path
        // rather than by list position.
        Map<String, Service> expectedByPath = new HashMap<>();
        for (Service expectedService : expected) {
            expectedByPath.put(expectedService.getAbsolutePath(), expectedService);
        }
        boolean ok = true;
        for (Service actualService : actual) {
            Service expectedService = expectedByPath.remove(actualService.getAbsolutePath());
            if (expectedService == null) {
                failures.add(String.format(
                        "Service: no expected service found for actual absolutePath '%s'; remaining expected "
                                + "absolutePaths %s", actualService.getAbsolutePath(), expectedByPath.keySet()));
                ok = false;
                continue;
            }
            if (actualService.hashCode() != expectedService.hashCode() && !actualService.equals(expectedService)) {
                failures.add(String.format(
                        "Service '%s': content mismatch, expected {type=%s, attachedListeners=%d, connections=%d, "
                                + "workflows=%d, functions=%d, remoteFunctions=%d, resourceFunctions=%d}, "
                                + "actual {type=%s, attachedListeners=%d, connections=%d, workflows=%d, "
                                + "functions=%d, remoteFunctions=%d, resourceFunctions=%d}",
                        actualService.getAbsolutePath(),
                        expectedService.getType(), expectedService.getAttachedListeners().size(),
                        expectedService.getConnections().size(), sizeOf(expectedService.getWorkflows()),
                        expectedService.getFunctions().size(), expectedService.getRemoteFunctions().size(),
                        expectedService.getResourceFunctions().size(),
                        actualService.getType(), actualService.getAttachedListeners().size(),
                        actualService.getConnections().size(), sizeOf(actualService.getWorkflows()),
                        actualService.getFunctions().size(), actualService.getRemoteFunctions().size(),
                        actualService.getResourceFunctions().size()));
                ok = false;
            }
        }
        return ok;
    }

    private boolean assertConnections(List<Connection> actual, List<Connection> expected, List<String> failures) {
        if (actual.size() == expected.size()) {
            return true;
        }
        failures.add(String.format("Connections: size mismatch, expected %d %s, actual %d %s", expected.size(),
                expected.stream().map(Connection::getSymbol).toList(), actual.size(),
                actual.stream().map(Connection::getSymbol).toList()));
        return false;
    }

    private boolean assertListeners(List<Listener> actual, List<Listener> expected, List<String> failures) {
        if (actual.size() == expected.size()) {
            return true;
        }
        failures.add(String.format("Listeners: size mismatch, expected %d %s, actual %d %s", expected.size(),
                expected.stream().map(Listener::getSymbol).toList(), actual.size(),
                actual.stream().map(Listener::getSymbol).toList()));
        return false;
    }

    private boolean assertAutomation(Automation actual, Automation expected, List<String> failures) {
        if (actual == null && expected == null) {
            return true;
        }
        if (actual == null || expected == null) {
            failures.add(String.format("Automation: expected %s, actual %s", expected == null ? "null" : "present",
                    actual == null ? "null" : "present"));
            return false;
        }
        int actualWorkflows = actual.getWorkflows() == null ? 0 : actual.getWorkflows().size();
        int expectedWorkflows = expected.getWorkflows() == null ? 0 : expected.getWorkflows().size();
        boolean ok = true;
        if (!actual.getType().equals(expected.getType())) {
            failures.add(String.format("Automation: type mismatch, expected '%s', actual '%s'", expected.getType(),
                    actual.getType()));
            ok = false;
        }
        if (!actual.getName().equals(expected.getName())) {
            failures.add(String.format("Automation: name mismatch, expected '%s', actual '%s'", expected.getName(),
                    actual.getName()));
            ok = false;
        }
        if (!Objects.equals(actual.getDisplayName(), expected.getDisplayName())) {
            failures.add(String.format("Automation: displayName mismatch, expected '%s', actual '%s'",
                    expected.getDisplayName(), actual.getDisplayName()));
            ok = false;
        }
        if (!actual.getLocation().equals(expected.getLocation())) {
            failures.add(String.format("Automation: location mismatch, expected %s, actual %s",
                    expected.getLocation(), actual.getLocation()));
            ok = false;
        }
        if (actual.getConnections().size() != expected.getConnections().size()) {
            failures.add(String.format("Automation: connections size mismatch, expected %d, actual %d",
                    expected.getConnections().size(), actual.getConnections().size()));
            ok = false;
        }
        if (actualWorkflows != expectedWorkflows) {
            failures.add(String.format("Automation: workflows size mismatch, expected %d, actual %d",
                    expectedWorkflows, actualWorkflows));
            ok = false;
        }
        return ok;
    }

    @Override
    protected String[] skipList() {
        //TODO: Resolve once the compilation issue with Kafka is fixed
        return new String[] {
                "project_with_all_components.json"
        };
    }

    @Override
    protected String getResourceDir() {
        return "get_design_model";
    }

    @Override
    protected Class<? extends AbstractLSTest> clazz() {
        return DesignModelGeneratorTest.class;
    }

    @Override
    protected String getServiceName() {
        return "designModelService";
    }

    @Override
    protected String getApiName() {
        return "getDesignModel";
    }

    public record TestConfig(String description, String projectPath, JsonObject output) {
    }

    @AfterMethod
    public void shutDownLanguageServer() {
        super.shutDownLanguageServer();
    }

    @BeforeMethod
    public void startLanguageServer() {
        super.startLanguageServer();
    }
}
