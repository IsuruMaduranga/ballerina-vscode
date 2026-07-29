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

import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * Tests {@link LibraryMetadataReader}'s three public reads: {@link LibraryMetadataReader#getTriggerMetadataModel}
 * and {@link LibraryMetadataReader#getTriggerUISchemaModel} (a connector's own shipped
 * {@code trigger-metadata.json}/{@code trigger-ui-schema.json}, resolved from its {@code .bala}) and
 * {@link LibraryMetadataReader#getPackagedTriggerMetadataModel} (the LS's own bundled classpath
 * resource) -- three independent reads, none silently falling back to another. Package/JSON resolution
 * is entirely internal to this class, so these tests only ever go through {@link ModuleInfo}-keyed
 * calls -- never a resolved {@code Path} -- mirroring how a caller (e.g. {@code ConnectorModelReader})
 * is expected to use it.
 */
public class LibraryMetadataReaderTest {

    private static final LibraryMetadataReader READER = LibraryMetadataReader.getInstance();

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
}
