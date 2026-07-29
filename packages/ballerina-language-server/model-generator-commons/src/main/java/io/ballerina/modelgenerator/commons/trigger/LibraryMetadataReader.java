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

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.modelgenerator.commons.trigger.utils.TriggerMetadataGson;
import io.ballerina.projects.Package;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The abstract, connector-agnostic entry point for reading the trigger model family. Any LS extension
 * that needs one of these -- today service-model-generator-ls-extension, in the future
 * flow-model-generator-ls-extension's copilot surface, or any extension after that -- calls this class
 * rather than resolving a connector's package or reading its shipped JSON itself; that resolution and
 * parsing is this class's job alone, not a caller's.
 *
 * <p>Exposes exactly three reads, each keyed by {@link ModuleInfo} and returning an {@code Optional}:
 * <ul>
 *   <li>{@link #getTriggerMetadataModel} -- a connector's own shipped
 *       {@code resources/trigger-metadata.json} (the authoring-rules overlay), resolved from its
 *       {@code .bala}.</li>
 *   <li>{@link #getTriggerUISchemaModel} -- a connector's own {@code resources/trigger-ui-schema.json}
 *       (the full UI-ready form/handler tree), resolved from its {@code .bala}. Reading a connector's
 *       own UI schema bundled directly in the LS jar (as opposed to shipped by the connector itself) is
 *       deliberately not this class's job: that curated, per-connector registry
 *       ({@code bundled_trigger_models.json}) is specific to the schema-driven trigger feature and stays
 *       in service-model-generator-ls-extension's own {@code ConnectorModelReader}.</li>
 *   <li>{@link #getPackagedTriggerMetadataModel} -- the LS's own bundled
 *       {@code trigger-metadata-models/<moduleName>/trigger-metadata.json} classpath resource, for
 *       modules whose metadata is curated directly into this jar rather than shipped by the connector.
 *       Independent of {@link #getTriggerMetadataModel} -- a caller decides for itself whether/how to
 *       combine the two, this class does not silently prefer one over the other.</li>
 * </ul>
 *
 * <p>A connector's package root is resolved via
 * {@link PackageUtil#getModulePackage(io.ballerina.projects.directory.BuildProject, String, String)}'s
 * version-less overload (org + module name only) and cached by that pair, since both connector-owned
 * reads may need the same root; the packaged classpath lookup needs no package resolution at all and is
 * cached separately, keyed by bare module name.
 *
 * @since 1.10.0
 */
public final class LibraryMetadataReader {

    private static final String TRIGGER_METADATA_RESOURCE_PATH = "resources/trigger-metadata.json";
    private static final String TRIGGER_UI_SCHEMA_RESOURCE_PATH = "resources/trigger-ui-schema.json";
    private static final String PACKAGED_TRIGGER_METADATA_ROOT = "trigger-metadata-models";
    private static final String PACKAGED_TRIGGER_METADATA_FILE = "trigger-metadata.json";

    private static final LibraryMetadataReader INSTANCE = new LibraryMetadataReader();

    // Shared by getTriggerMetadataModel/getTriggerUISchemaModel -- both may resolve the same connector
    // package root, so a repeated lookup pays bala-cache resolution at most once per module. Kept
    // separate from TriggerArtifactResolver's own PACKAGE_ROOT_CACHE (icon resolution): the two are
    // read on unrelated schedules and neither needs the other's cache.
    private final Map<String, Optional<Path>> packageRootCache = new ConcurrentHashMap<>();
    private final Map<String, Optional<TriggerMetadataModel>> packagedMetadataCache = new ConcurrentHashMap<>();

    // A connector's trigger-ui-schema.json carries no TypeRef-or-union slots (unlike
    // trigger-metadata.json), so it needs no custom deserializer -- a plain Gson suffices, matching
    // ConnectorModelReader's existing plain-Gson parse of the same shape.
    private final Gson plainGson = new Gson();

    private LibraryMetadataReader() {
    }

    public static LibraryMetadataReader getInstance() {
        return INSTANCE;
    }

    /** The connector's own {@code resources/trigger-metadata.json}, resolved from its {@code .bala}. */
    public Optional<TriggerMetadataModel> getTriggerMetadataModel(ModuleInfo moduleInfo) {
        return packageRoot(moduleInfo).flatMap(this::readTriggerMetadataModel);
    }

    /** The connector's own {@code resources/trigger-ui-schema.json}, resolved from its {@code .bala}. */
    public Optional<TriggerUISchemaModel> getTriggerUISchemaModel(ModuleInfo moduleInfo) {
        return packageRoot(moduleInfo).flatMap(this::readTriggerUISchemaModel);
    }

    /**
     * The LS's bundled {@code trigger-metadata-models/<moduleName>/trigger-metadata.json} classpath
     * resource, if any. Keyed by bare module name only -- this is a small, curated set the LS ships
     * directly, so no org/version is needed to disambiguate (mirrors {@code TriggerArtifactReader}).
     */
    public Optional<TriggerMetadataModel> getPackagedTriggerMetadataModel(ModuleInfo moduleInfo) {
        if (moduleInfo == null || moduleInfo.moduleName() == null) {
            return Optional.empty();
        }
        return packagedMetadataCache.computeIfAbsent(moduleInfo.moduleName(), this::readPackagedMetadata);
    }

    private Optional<TriggerMetadataModel> readPackagedMetadata(String moduleName) {
        String resourcePath = PACKAGED_TRIGGER_METADATA_ROOT + "/" + moduleName + "/"
                + PACKAGED_TRIGGER_METADATA_FILE;
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(resourcePath)) {
            if (is == null) {
                return Optional.empty();
            }
            String json = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            return Optional.ofNullable(TriggerMetadataGson.instance().fromJson(json, TriggerMetadataModel.class));
        } catch (IOException | JsonParseException e) {
            return Optional.empty();
        }
    }

    /**
     * Resolves and parses {@code resources/trigger-metadata.json} relative to {@code packageRoot}.
     * Private -- reading the JSON off a resolved package is this class's own job, never a caller's.
     */
    private Optional<TriggerMetadataModel> readTriggerMetadataModel(Path packageRoot) {
        return readResourceFile(packageRoot, TRIGGER_METADATA_RESOURCE_PATH).flatMap(json -> {
            try {
                return Optional.ofNullable(TriggerMetadataGson.instance().fromJson(json, TriggerMetadataModel.class));
            } catch (JsonParseException e) {
                return Optional.empty();
            }
        });
    }

    /** {@code Path}-rooted counterpart of {@link #readTriggerMetadataModel}, for the UI-schema shape. */
    private Optional<TriggerUISchemaModel> readTriggerUISchemaModel(Path packageRoot) {
        return readResourceFile(packageRoot, TRIGGER_UI_SCHEMA_RESOURCE_PATH).flatMap(json -> {
            try {
                return Optional.ofNullable(plainGson.fromJson(json, TriggerUISchemaModel.class));
            } catch (JsonParseException e) {
                return Optional.empty();
            }
        });
    }

    /**
     * Resolves a connector's package root by {@code org}/{@code moduleName} alone, cached by that pair.
     * Wrapped in a blanket {@code catch (Throwable)}: {@link PackageUtil#getModulePackage}'s version-less
     * overload falls through to a live Central version lookup on an offline-metadata miss, which
     * <b>throws</b> (rather than returning empty) for an org/module that doesn't exist there or when
     * offline -- any such failure must degrade to "no metadata," not propagate to the caller.
     */
    private Optional<Path> packageRoot(ModuleInfo moduleInfo) {
        if (moduleInfo == null || moduleInfo.org() == null || moduleInfo.moduleName() == null) {
            return Optional.empty();
        }
        String key = moduleInfo.org() + "/" + moduleInfo.moduleName();
        return packageRootCache.computeIfAbsent(key, ignored -> {
            try {
                Optional<Package> pkg = PackageUtil.getModulePackage(PackageUtil.getSampleProject(),
                        moduleInfo.org(), moduleInfo.moduleName());
                return pkg.map(aPackage -> aPackage.project().sourceRoot());
            } catch (Throwable e) {
                return Optional.empty();
            }
        });
    }

    /** Reads a package-relative file as UTF-8 text, guarding against it escaping {@code packageRoot}. */
    private Optional<String> readResourceFile(Path packageRoot, String relativePath) {
        Path file = packageRoot.resolve(relativePath).normalize();
        if (!file.startsWith(packageRoot) || !Files.isRegularFile(file)) {
            return Optional.empty();
        }
        try {
            return Optional.of(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            return Optional.empty();
        }
    }
}
