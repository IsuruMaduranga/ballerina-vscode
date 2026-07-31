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

package io.ballerina.servicemodelgenerator.extension.connector;

import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel;
import org.testng.Assert;
import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * Tests {@link TriggerModelReader}'s {@code isLocalRepository} overloads: a connector picked from a
 * Ballerina local-repository ({@code ~/.ballerina/repositories/local}) search result must resolve via
 * that path instead of Central, entirely independent of whether the same org/module also happens to be
 * resolvable centrally (it never is, in these tests -- these orgs are test-only).
 *
 * <p>Resolves against the real, machine-wide local repository (there is no injectable/fake repository
 * root in the current API), so this writes small fixture packages directly there ({@code @BeforeClass})
 * and removes them afterward ({@code @AfterClass}), mirroring {@code LibraryMetadataReaderTest}'s and
 * {@code TriggerSearchUtilTest}'s established pattern.
 */
public class TriggerModelReaderLocalRepositoryTest {

    private static final String ORG = "connectormodelreadertest";
    private static final String WITH_SCHEMA_PACKAGE = "hasschema";
    private static final String METADATA_ONLY_PACKAGE = "metadataonly";
    private static final String NO_SCHEMA_PACKAGE = "noschema";
    private static final String VERSION = "0.1.0";

    private enum SchemaFixture {
        UI_SCHEMA, METADATA_ONLY, NONE
    }

    private static Path orgDir() {
        return Path.of(System.getProperty("user.home"), ".ballerina", "repositories", "local", "bala", ORG);
    }

    @BeforeClass
    public void setUpFixtures() throws IOException {
        writeFixturePackage(WITH_SCHEMA_PACKAGE, SchemaFixture.UI_SCHEMA);
        writeFixturePackage(METADATA_ONLY_PACKAGE, SchemaFixture.METADATA_ONLY);
        writeFixturePackage(NO_SCHEMA_PACKAGE, SchemaFixture.NONE);
    }

    @AfterClass
    public void tearDownFixtures() throws IOException {
        Path dir = orgDir();
        if (!Files.exists(dir)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // best-effort cleanup of a test-owned fixture directory
                }
            });
        }
    }

    private static void writeFixturePackage(String packageName, SchemaFixture fixture) throws IOException {
        Path root = orgDir().resolve(packageName).resolve(VERSION).resolve("any");
        Files.createDirectories(root.resolve("modules").resolve(packageName));
        Files.createDirectories(root.resolve("docs"));
        Files.writeString(root.resolve("package.json"), """
                {
                  "organization": "%s", "name": "%s", "version": "%s", "export": ["%s"],
                  "ballerina_version": "2201.13.4", "implementation_vendor": "WSO2",
                  "language_spec_version": "2024R1", "platform": "any", "graalvmCompatible": true,
                  "template": false, "readme": "docs/README.md"
                }""".formatted(ORG, packageName, VERSION, packageName));
        Files.writeString(root.resolve("bala.json"), """
                {"bala_version": "3.0.0", "built_by": "WSO2"}""");
        Files.writeString(root.resolve("dependency-graph.json"), """
                {
                  "packages": [{"org": "%s", "name": "%s", "version": "%s", "transitive": false,
                                 "dependencies": [], "modules": []}],
                  "modules": [{"org": "%s", "package_name": "%s", "version": "%s", "module_name": "%s",
                                "dependencies": []}]
                }""".formatted(ORG, packageName, VERSION, ORG, packageName, VERSION, packageName));
        Files.writeString(root.resolve("docs").resolve("README.md"), "# " + packageName);
        if (fixture == SchemaFixture.METADATA_ONLY) {
            // A genuinely introspectable module (TriggerLibraryIntrospector#isListenerClass matches a
            // class named exactly "Listener" with an init method; a TYPE_DEFINITION whose descriptor is
            // an object type qualified `service` becomes a service type) -- real enough for
            // TriggerModelSynthesizer#synthesize's non-empty listeners/serviceTypes precondition to pass
            // and actually produce a model, not just avoid a crash.
            Files.writeString(root.resolve("modules").resolve(packageName).resolve("main.bal"), """
                    public class Listener {
                        public function init() returns error? {
                        }
                        public function attach(service object {} s, string[]|string? name = ()) returns error? {
                        }
                        public function detach(service object {} s) returns error? {
                        }
                        public function 'start() returns error? {
                        }
                        public function gracefulStop() returns error? {
                        }
                        public function immediateStop() returns error? {
                        }
                    }

                    public type Service distinct service object {
                    };
                    """);
        } else {
            Files.writeString(root.resolve("modules").resolve(packageName).resolve("main.bal"),
                    "public function main() {\n}\n");
        }
        if (fixture == SchemaFixture.UI_SCHEMA) {
            Files.createDirectories(root.resolve("resources"));
            // initProperties is required for buildServiceInitModelFromJson to recognize this as a valid
            // add-trigger init form (see TriggerModelReader#buildServiceInitModelFromJson) -- an empty
            // map is enough to exercise the local-repository routing this test targets.
            Files.writeString(root.resolve("resources").resolve("trigger-ui-schema.json"), """
                    {"schemaVersion": "1.0", "listenerKind": "SINGLE_SELECT_LISTENER", "initProperties": {}}""");
        } else if (fixture == SchemaFixture.METADATA_ONLY) {
            Files.createDirectories(root.resolve("resources"));
            // No trigger-ui-schema.json -- only trigger-metadata.json, exercising the metadata+
            // introspection synthesis tier (TriggerModelReader#synthesizeTriggerModel) instead of the
            // shipped-schema tier, against the real Listener/Service declared above.
            Files.writeString(root.resolve("resources").resolve("trigger-metadata.json"), """
                    {
                      "listeners": [{"type": {"name": "Listener"}, "services": ["service"]}],
                      "serviceTypes": [{
                        "id": "service", "type": {"name": "Service"}, "concrete": false,
                        "multipleListenersAllowed": true, "multipleServicesPerListenerAllowed": true,
                        "handlers": {"backedByConcreteType": false, "addMode": "subset", "options": []}
                      }],
                      "annotations": [], "dataBindingRules": []
                    }""");
        }
    }

    @Test
    public void testGetSchemaDrivenTriggerModelResolvesLocalFixture() {
        Optional<TriggerUISchemaModel> model = TriggerModelReader.getInstance()
                .getSchemaDrivenTriggerModel(ORG, WITH_SCHEMA_PACKAGE, VERSION, true);
        Assert.assertTrue(model.isPresent(), "the local-repository fixture must resolve");
        Assert.assertEquals(model.get().schemaVersion(), "1.0");
    }

    @Test
    public void testHasSchemaDrivenModelTrueForLocalFixtureOnlyWhenFlagged() {
        Assert.assertTrue(TriggerModelReader.getInstance()
                        .hasSchemaDrivenModel(ORG, WITH_SCHEMA_PACKAGE, VERSION, true),
                "must resolve via the local path");
        // Same org/module, but without the flag: must NOT leak into (or be satisfied by) the Central path
        // -- this org is test-only and was never published, so the non-local check must report false.
        Assert.assertFalse(TriggerModelReader.getInstance()
                        .hasSchemaDrivenModel(ORG, WITH_SCHEMA_PACKAGE, VERSION, false),
                "a local-only connector must not be found by the Central-only path");
    }

    @Test
    public void testGetSchemaDrivenServiceInitModelMarksLocalRepository() {
        ServiceInitModel initModel = TriggerModelReader.getInstance()
                .getSchemaDrivenServiceInitModel(ORG, WITH_SCHEMA_PACKAGE, VERSION, true)
                .orElseThrow(() -> new AssertionError("the local-repository fixture must resolve"));
        Assert.assertTrue(initModel.isLocalRepository(),
                "a model resolved via the local repository must be marked as such, so addServiceAndListener's "
                        + "round-trip (client echoes the model back) preserves the source");
    }

    @Test
    public void testMetadataOnlyPackageResolvesViaSynthesis() {
        // A local connector shipping only trigger-metadata.json (no trigger-ui-schema.json) must still
        // resolve, via the same metadata+introspection synthesis tier the Central path already has --
        // this is the fix for the bug where local resolution only ever tried the shipped-schema tier.
        // The fixture module has a real, introspectable "Listener" class and "Service" type, so this
        // proves actual end-to-end synthesis, not just a non-crashing empty result.
        String failureMessage = "a metadata-only local connector must resolve via synthesis, "
                + "not just the shipped-schema tier";
        TriggerUISchemaModel model = TriggerModelReader.getInstance()
                .getSchemaDrivenTriggerModel(ORG, METADATA_ONLY_PACKAGE, VERSION, true)
                .orElseThrow(() -> new AssertionError(failureMessage));
        Assert.assertFalse(model.serviceTypes().isEmpty(), "the introspected Service type must be present");
    }

    @Test
    public void testPackageWithNeitherFileResolvesEmptyNotACrash() {
        // A local connector shipping neither trigger-ui-schema.json nor trigger-metadata.json (just
        // main.bal) resolves to empty, not an exception, and not a silently-wrong result -- there is
        // nothing at all to build a model from.
        Optional<TriggerUISchemaModel> model = TriggerModelReader.getInstance()
                .getSchemaDrivenTriggerModel(ORG, NO_SCHEMA_PACKAGE, VERSION, true);
        Assert.assertTrue(model.isEmpty());
    }

    @Test
    public void testIncompleteVersionResolvesEmptyNotLatest() {
        // Unlike Central, local-repository resolution has no "latest version" fallback -- a null version
        // must resolve to empty rather than guessing.
        Optional<TriggerUISchemaModel> model = TriggerModelReader.getInstance()
                .getSchemaDrivenTriggerModel(ORG, WITH_SCHEMA_PACKAGE, null, true);
        Assert.assertTrue(model.isEmpty());
    }

    @Test
    public void testUnknownLocalConnectorResolvesEmptyNotThrows() {
        Optional<TriggerUISchemaModel> model = TriggerModelReader.getInstance()
                .getSchemaDrivenTriggerModel("no-such-org", "no-such-module", "1.0.0", true);
        Assert.assertTrue(model.isEmpty());
    }
}
