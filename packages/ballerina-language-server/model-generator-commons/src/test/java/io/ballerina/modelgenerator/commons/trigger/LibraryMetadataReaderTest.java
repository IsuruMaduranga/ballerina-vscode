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

package io.ballerina.modelgenerator.commons.trigger;

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.projects.Package;
import org.testng.Assert;
import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Tests {@link LibraryMetadataReader}'s public reads: {@link LibraryMetadataReader#getTriggerMetadataModel}
 * and {@link LibraryMetadataReader#getTriggerUISchemaModel} (a connector's own shipped
 * {@code trigger-metadata.json}/{@code trigger-ui-schema.json}, resolved from its {@code .bala} via
 * Central) and {@link LibraryMetadataReader#getPackagedTriggerMetadataModel} (the LS's own bundled
 * classpath resource) -- three independent reads, none silently falling back to another. Package/JSON
 * resolution is entirely internal to this class, so these tests only ever go through
 * {@link ModuleInfo}-keyed calls -- never a resolved {@code Path} -- mirroring how a caller (e.g.
 * {@code ConnectorModelReader}) is expected to use it.
 *
 * <p>The local-repository reads ({@link LibraryMetadataReader#getTriggerMetadataModelFromLocalRepository}/
 * {@link LibraryMetadataReader#getTriggerUISchemaModelFromLocalRepository}/
 * {@link LibraryMetadataReader#listLocalRepositoryModules}) resolve against the real, machine-wide
 * {@code ~/.ballerina/repositories/local} directory -- there is no injectable/fake repository root in the
 * current API, so these tests write a small fixture package directly there ({@code @BeforeClass}) and
 * remove it afterward ({@code @AfterClass}), mirroring the directory layout {@code bal push
 * --repository=local} produces (verified against a real {@code bal push} output) without shelling out to
 * the {@code bal} CLI at test time.
 */
public class LibraryMetadataReaderTest {

    private static final LibraryMetadataReader READER = LibraryMetadataReader.getInstance();

    private static final String LOCAL_ORG = "readertestlocalrepo";
    private static final String LOCAL_PACKAGE = "probeconnector";
    private static final String LOCAL_VERSION = "0.1.0";

    private static Path localRepoPackageDir() {
        return Path.of(System.getProperty("user.home"), ".ballerina", "repositories", "local", "bala", LOCAL_ORG);
    }

    @BeforeClass
    public void setUpLocalRepositoryFixture() throws IOException {
        Path root = localRepoPackageDir().resolve(LOCAL_PACKAGE).resolve(LOCAL_VERSION).resolve("any");
        Files.createDirectories(root.resolve("modules").resolve(LOCAL_PACKAGE));
        Files.createDirectories(root.resolve("docs"));
        Files.createDirectories(root.resolve("resources"));

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
                }""".formatted(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_VERSION, LOCAL_PACKAGE));
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
                }""".formatted(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_VERSION, LOCAL_ORG, LOCAL_PACKAGE, LOCAL_VERSION,
                LOCAL_PACKAGE));
        Files.writeString(root.resolve("docs").resolve("README.md"), "# " + LOCAL_PACKAGE);
        Files.writeString(root.resolve("modules").resolve(LOCAL_PACKAGE).resolve("main.bal"),
                "public function main() {\n}\n");
        Files.writeString(root.resolve("resources").resolve("trigger-ui-schema.json"), """
                {"schemaVersion": "1.0", "listenerKind": "SINGLE_SELECT_LISTENER"}""");
        Files.writeString(root.resolve("resources").resolve("trigger-metadata.json"), """
                {"listeners": [], "serviceTypes": [], "annotations": [], "dataBindingRules": []}""");
    }

    @AfterClass
    public void tearDownLocalRepositoryFixture() throws IOException {
        Path orgDir = localRepoPackageDir();
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

    @Test
    public void testGetPackagedTriggerMetadataModelHit() {
        // kafka is bundled under trigger-metadata-models/kafka/trigger-metadata.json -- resolved purely
        // off the classpath, no package resolution needed.
        ModuleInfo moduleInfo = new ModuleInfo("ballerinax", "kafka", "kafka", "1.0.0");
        TriggerMetadataModel model = READER.getPackagedTriggerMetadataModel(moduleInfo).orElseThrow();
        Assert.assertFalse(model.listeners().isEmpty());
        Assert.assertFalse(model.serviceTypes().isEmpty());
    }

    @Test
    public void testGetPackagedTriggerMetadataModelMiss() {
        ModuleInfo moduleInfo = new ModuleInfo("ballerinax", "no-such-module", "no-such-module", "1.0.0");
        Assert.assertTrue(READER.getPackagedTriggerMetadataModel(moduleInfo).isEmpty());
    }

    @Test
    public void testGetPackagedTriggerMetadataModelNullModuleInfo() {
        Assert.assertTrue(READER.getPackagedTriggerMetadataModel(null).isEmpty());
    }

    @Test
    public void testGetTriggerMetadataModelNullModuleInfo() {
        Assert.assertTrue(READER.getTriggerMetadataModel(null).isEmpty());
    }

    @Test
    public void testGetTriggerMetadataModelIncompleteModuleInfo() {
        ModuleInfo moduleInfo = new ModuleInfo(null, "kafka", "kafka", "1.0.0");
        Assert.assertTrue(READER.getTriggerMetadataModel(moduleInfo).isEmpty());
    }

    @Test
    public void testGetTriggerUISchemaModelNullModuleInfo() {
        Assert.assertTrue(READER.getTriggerUISchemaModel(null).isEmpty());
    }

    @Test
    public void testGetTriggerUISchemaModelIncompleteModuleInfo() {
        ModuleInfo moduleInfo = new ModuleInfo(null, "kafka", "kafka", "1.0.0");
        Assert.assertTrue(READER.getTriggerUISchemaModel(moduleInfo).isEmpty());
    }

    @Test
    public void testGetTriggerMetadataModelUnresolvableModuleGracefullyEmpty() {
        // Not a real Central package -- must resolve to empty, not throw (the version-less
        // PackageUtil.getModulePackage overload throws on an unknown org/module). Also confirms
        // getTriggerMetadataModel does NOT fall back to the packaged tier: kafka's presence there
        // (see testGetPackagedTriggerMetadataModelHit) must not leak into this connector-owned read.
        ModuleInfo moduleInfo = new ModuleInfo("no-such-org", "no-such-module", "no-such-module", null);
        Assert.assertTrue(READER.getTriggerMetadataModel(moduleInfo).isEmpty());
    }

    @Test
    public void testGetTriggerUISchemaModelUnresolvableModuleGracefullyEmpty() {
        ModuleInfo moduleInfo = new ModuleInfo("no-such-org", "no-such-module", "no-such-module", null);
        Assert.assertTrue(READER.getTriggerUISchemaModel(moduleInfo).isEmpty());
    }

    @Test
    public void testIsLocallyResolvableNullOrIncompleteModuleInfo() {
        Assert.assertFalse(READER.isLocallyResolvable(null));
        Assert.assertFalse(READER.isLocallyResolvable(new ModuleInfo(null, "kafka", "kafka", "1.0.0")));
        Assert.assertFalse(READER.isLocallyResolvable(new ModuleInfo("ballerinax", "kafka", null, "1.0.0")));
    }

    @Test
    public void testIsLocallyResolvableUnresolvableModule() {
        ModuleInfo moduleInfo = new ModuleInfo("no-such-org", "no-such-module", "no-such-module", null);
        Assert.assertFalse(READER.isLocallyResolvable(moduleInfo));
        // Repeatable: a miss must not be memoized, so that a subsequent pull of the package is picked
        // up instead of being masked for the rest of the session.
        Assert.assertFalse(READER.isLocallyResolvable(moduleInfo));
    }

    @Test
    public void testUnresolvableModuleMissIsNotMemoized() {
        // Same guarantee via the public reads: asking twice must re-resolve rather than return a
        // cached "absent", which is what lets a mid-session `bal pull` take effect.
        ModuleInfo moduleInfo = new ModuleInfo("no-such-org", "still-no-module", "still-no-module", null);
        Assert.assertTrue(READER.getTriggerMetadataModel(moduleInfo).isEmpty());
        Assert.assertTrue(READER.getTriggerMetadataModel(moduleInfo).isEmpty());
        Assert.assertFalse(READER.isLocallyResolvable(moduleInfo));
    }

    @Test
    public void testListLocalRepositoryModulesFindsFixturePackage() {
        List<ModuleInfo> modules = READER.listLocalRepositoryModules();
        Assert.assertTrue(modules.stream().anyMatch(m -> LOCAL_ORG.equals(m.org())
                        && LOCAL_PACKAGE.equals(m.packageName()) && LOCAL_VERSION.equals(m.version())),
                "the local-repository fixture package must be enumerated");
    }

    @Test
    public void testGetTriggerUISchemaModelFromLocalRepositoryHit() {
        ModuleInfo moduleInfo = new ModuleInfo(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_PACKAGE, LOCAL_VERSION);
        TriggerUISchemaModel model = READER.getTriggerUISchemaModelFromLocalRepository(moduleInfo).orElseThrow();
        Assert.assertEquals(model.schemaVersion(), "1.0");
    }

    @Test
    public void testGetTriggerMetadataModelFromLocalRepositoryHit() {
        ModuleInfo moduleInfo = new ModuleInfo(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_PACKAGE, LOCAL_VERSION);
        TriggerMetadataModel model = READER.getTriggerMetadataModelFromLocalRepository(moduleInfo).orElseThrow();
        Assert.assertTrue(model.listeners().isEmpty());
        Assert.assertTrue(model.serviceTypes().isEmpty());
    }

    @Test
    public void testGetTriggerUISchemaModelFromLocalRepositoryMissesCentralOnlyModule() {
        // kafka only exists on Central, never in the local repository -- the two resolution paths must
        // never leak into each other.
        ModuleInfo moduleInfo = new ModuleInfo("ballerinax", "kafka", "kafka", "1.0.0");
        Assert.assertTrue(READER.getTriggerUISchemaModelFromLocalRepository(moduleInfo).isEmpty());
    }

    @Test
    public void testGetTriggerUISchemaModelFromLocalRepositoryIncompleteModuleInfo() {
        // Unlike the Central reads, local-repository resolution has no "latest version" fallback, so an
        // incomplete ModuleInfo (missing version) must resolve to empty rather than guessing.
        ModuleInfo moduleInfo = new ModuleInfo(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_PACKAGE, null);
        Assert.assertTrue(READER.getTriggerUISchemaModelFromLocalRepository(moduleInfo).isEmpty());
    }

    @Test
    public void testGetTriggerMetadataModelFromLocalRepositoryNullModuleInfo() {
        Assert.assertTrue(READER.getTriggerMetadataModelFromLocalRepository(null).isEmpty());
    }

    @Test
    public void testGetCompiledPackageFromLocalRepositoryIsActuallyCompilable() {
        // The property that matters for ConnectorModelReader's metadata+introspection synthesis tier:
        // a local-repository-resolved Package must be just as compilable/introspectable as a
        // Central-resolved one, not merely readable for its resource files.
        ModuleInfo moduleInfo = new ModuleInfo(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_PACKAGE, LOCAL_VERSION);
        Package pkg = READER.getCompiledPackageFromLocalRepository(moduleInfo).orElseThrow();
        SemanticModel semanticModel = PackageUtil.getCompilation(pkg)
                .getSemanticModel(pkg.getDefaultModule().moduleId());
        Assert.assertNotNull(semanticModel, "the local-repository-resolved package must be compilable");
    }

    @Test
    public void testGetCompiledPackageFromLocalRepositoryIncompleteModuleInfo() {
        ModuleInfo moduleInfo = new ModuleInfo(LOCAL_ORG, LOCAL_PACKAGE, LOCAL_PACKAGE, null);
        Assert.assertTrue(READER.getCompiledPackageFromLocalRepository(moduleInfo).isEmpty());
    }

    @Test
    public void testLocalRepositoryMissIsNotPermanentlyCached() throws IOException {
        // Simulates the target workflow: a developer searches before pushing their connector (a miss),
        // then pushes it (bal pack / bal push --repository=local), then tries again in the same LS
        // process -- the second attempt must succeed, proving the first miss was never cached.
        String org = "readertestnocache";
        String pkg = "notyetpushed";
        String version = "0.1.0";
        ModuleInfo moduleInfo = new ModuleInfo(org, pkg, pkg, version);
        Path orgDir = Path.of(System.getProperty("user.home"), ".ballerina", "repositories", "local", "bala", org);
        try {
            Assert.assertTrue(READER.getTriggerUISchemaModelFromLocalRepository(moduleInfo).isEmpty(),
                    "not pushed yet -- must be a miss");

            Path root = orgDir.resolve(pkg).resolve(version).resolve("any");
            Files.createDirectories(root.resolve("modules").resolve(pkg));
            Files.createDirectories(root.resolve("docs"));
            Files.createDirectories(root.resolve("resources"));
            Files.writeString(root.resolve("package.json"), """
                    {
                      "organization": "%s", "name": "%s", "version": "%s", "export": ["%s"],
                      "ballerina_version": "2201.13.4", "implementation_vendor": "WSO2",
                      "language_spec_version": "2024R1", "platform": "any", "graalvmCompatible": true,
                      "template": false, "readme": "docs/README.md"
                    }""".formatted(org, pkg, version, pkg));
            Files.writeString(root.resolve("bala.json"), """
                    {"bala_version": "3.0.0", "built_by": "WSO2"}""");
            Files.writeString(root.resolve("dependency-graph.json"), """
                    {
                      "packages": [{"org": "%s", "name": "%s", "version": "%s", "transitive": false,
                                     "dependencies": [], "modules": []}],
                      "modules": [{"org": "%s", "package_name": "%s", "version": "%s", "module_name": "%s",
                                    "dependencies": []}]
                    }""".formatted(org, pkg, version, org, pkg, version, pkg));
            Files.writeString(root.resolve("docs").resolve("README.md"), "# " + pkg);
            Files.writeString(root.resolve("modules").resolve(pkg).resolve("main.bal"),
                    "public function main() {\n}\n");
            Files.writeString(root.resolve("resources").resolve("trigger-ui-schema.json"), """
                    {"schemaVersion": "1.0"}""");

            TriggerUISchemaModel model = READER.getTriggerUISchemaModelFromLocalRepository(moduleInfo)
                    .orElseThrow(() -> new AssertionError(
                            "pushed after the first miss -- must resolve now, not stay cached as absent"));
            Assert.assertEquals(model.schemaVersion(), "1.0");
        } finally {
            if (Files.exists(orgDir)) {
                try (Stream<Path> paths = Files.walk(orgDir)) {
                    paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (IOException ignored) {
                            // best-effort cleanup
                        }
                    });
                }
            }
        }
    }
}
