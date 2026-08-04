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

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.modelgenerator.commons.trigger.utils.TriggerMetadataGson;
import io.ballerina.projects.Package;
import io.ballerina.projects.PackageDescriptor;
import io.ballerina.projects.PackageName;
import io.ballerina.projects.PackageOrg;
import io.ballerina.projects.PackageVersion;
import io.ballerina.projects.environment.PackageRepository;
import io.ballerina.projects.environment.ResolutionOptions;
import io.ballerina.projects.environment.ResolutionRequest;
import io.ballerina.projects.internal.environment.BallerinaUserHome;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Connector-agnostic entry point for reading the trigger model family (metadata JSON, UI schema JSON,
 * and the LS's own bundled trigger metadata), shared by every LS extension that needs one.
 *
 * @since 1.10.0
 */
public final class LibraryMetadataReader {

    private static final Logger LOGGER = Logger.getLogger(LibraryMetadataReader.class.getName());

    private static final String TRIGGER_METADATA_RESOURCE_PATH = "resources/trigger-metadata.json";
    private static final String TRIGGER_UI_SCHEMA_RESOURCE_PATH = "resources/trigger-ui-schema.json";
    private static final String PACKAGED_TRIGGER_METADATA_ROOT = "trigger-metadata-models";
    private static final String PACKAGED_TRIGGER_METADATA_FILE = "trigger-metadata.json";
    private static final int MAX_CACHE_SIZE = 2;

    private static final LibraryMetadataReader INSTANCE = new LibraryMetadataReader();

    private final Cache<String, Optional<Path>> packageRootCache =
            Caffeine.newBuilder().maximumSize(MAX_CACHE_SIZE).build();
    private final Cache<String, Optional<TriggerMetadataModel>> packagedMetadataCache =
            Caffeine.newBuilder().maximumSize(MAX_CACHE_SIZE).build();

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
     * Whether the connector's {@code .bala} is present in the local repository. Lets a caller tell "not
     * pulled yet" apart from "present but ships no trigger metadata", which is the difference between
     * retrying later and a durable answer.
     */
    public boolean isLocallyResolvable(ModuleInfo moduleInfo) {
        return packageRoot(moduleInfo).isPresent();
    }

    /**
     * The LS's bundled {@code trigger-metadata-models/<moduleName>/trigger-metadata.json} classpath
     * resource, if any.
     */
    public Optional<TriggerMetadataModel> getPackagedTriggerMetadataModel(ModuleInfo moduleInfo) {
        if (moduleInfo == null || moduleInfo.moduleName() == null) {
            return Optional.empty();
        }
        return packagedMetadataCache.get(moduleInfo.moduleName(), this::readPackagedMetadata);
    }

    /**
     * The connector's own {@code resources/trigger-metadata.json}, resolved from the Ballerina
     * <b>local</b> repository ({@code ~/.ballerina/repositories/local}) rather than Central -- for a
     * connector under active local development (packed/pushed via {@code bal pack}/
     * {@code bal push --repository=local}) that may not exist on Central at all. {@code moduleInfo} must
     * be {@link ModuleInfo#isComplete()} -- unlike the Central reads above, local-repository resolution
     * has no "latest version" fallback to resolve an incomplete request against.
     */
    public Optional<TriggerMetadataModel> getTriggerMetadataModelFromLocalRepository(ModuleInfo moduleInfo) {
        return localPackageRoot(moduleInfo).flatMap(this::readTriggerMetadataModel);
    }

    /**
     * The connector's own {@code resources/trigger-ui-schema.json}, resolved from the Ballerina
     * <b>local</b> repository. See {@link #getTriggerMetadataModelFromLocalRepository} for why this is a
     * separate read from the Central-resolving {@link #getTriggerUISchemaModel}.
     */
    public Optional<TriggerUISchemaModel> getTriggerUISchemaModelFromLocalRepository(ModuleInfo moduleInfo) {
        return localPackageRoot(moduleInfo).flatMap(this::readTriggerUISchemaModel);
    }

    /**
     * Every {@code org/name/version} present in the Ballerina local repository
     * ({@code ~/.ballerina/repositories/local}), as {@link ModuleInfo} (module name defaults to the
     * package name, matching the common single-module-package convention -- this is enough to drive
     * {@link #getTriggerMetadataModelFromLocalRepository}/{@link #getTriggerUISchemaModelFromLocalRepository},
     * which only need the package root, not a specific submodule). Returns an empty list if the local
     * repository is empty or unreadable -- never throws.
     */
    public List<ModuleInfo> listLocalRepositoryModules() {
        List<ModuleInfo> modules = new ArrayList<>();
        try {
            Map<String, List<String>> packagesByOrg = localRepository().getPackages();
            for (Map.Entry<String, List<String>> entry : packagesByOrg.entrySet()) {
                String org = entry.getKey();
                for (String nameAndVersion : entry.getValue()) {
                    String[] parts = nameAndVersion.split(":");
                    if (parts.length != 2) {
                        continue;
                    }
                    modules.add(new ModuleInfo(org, parts[0], parts[0], parts[1]));
                }
            }
        } catch (Throwable e) {
            LOGGER.log(Level.FINE, "Listing local-repository modules failed", e);
            return List.of();
        }
        return modules;
    }

    /**
     * The connector's compiled {@link Package}, resolved via the local repository -- for callers that
     * need to compile/introspect it (e.g. synthesizing a {@code TriggerUISchemaModel} from
     * {@code trigger-metadata.json} plus semantic-API introspection, the same way the Central path
     * falls back to synthesis when a connector doesn't ship a full {@code trigger-ui-schema.json}).
     * Deliberately <b>not cached</b> (unlike {@link #packageRoot}, which amortizes an expensive Central
     * network round-trip): this is a cheap filesystem read, and the target user for local-repository
     * resolution is actively iterating (edit connector -> {@code bal pack} ->
     * {@code bal push --repository=local} -> try again in the IDE) -- caching a miss here would silently
     * persist a stale "not found" across that whole loop until an LS/extension restart, which is worse
     * than the cost of re-resolving each call.
     */
    public Optional<Package> getCompiledPackageFromLocalRepository(ModuleInfo moduleInfo) {
        if (moduleInfo == null || !moduleInfo.isComplete()) {
            return Optional.empty();
        }
        try {
            PackageDescriptor descriptor = PackageDescriptor.from(
                    PackageOrg.from(moduleInfo.org()), PackageName.from(moduleInfo.packageName()),
                    PackageVersion.from(moduleInfo.version()));
            ResolutionRequest request = ResolutionRequest.from(descriptor);
            return localRepository().getPackage(request, ResolutionOptions.builder().setOffline(true).build());
        } catch (Throwable e) {
            LOGGER.log(Level.FINE, "Compiling local-repository package failed for "
                    + moduleInfo.org() + "/" + moduleInfo.packageName(), e);
            return Optional.empty();
        }
    }

    /** {@code Path}-rooted counterpart of {@link #getCompiledPackageFromLocalRepository}. */
    private Optional<Path> localPackageRoot(ModuleInfo moduleInfo) {
        return getCompiledPackageFromLocalRepository(moduleInfo).map(pkg -> pkg.project().sourceRoot());
    }

    /**
     * The Ballerina local repository ({@code ~/.ballerina/repositories/local}) handle, obtained once via
     * a throwaway sample project's {@link io.ballerina.projects.environment.Environment} (mirroring
     * {@link PackageUtil#getSampleProject()}'s existing use of the same trick for Central resolution) and
     * cached from then on: {@link PackageUtil#getSampleProject()} builds a fresh temp-dir project on
     * every call, and callers such as {@code TriggerSearchUtil#searchLocalRepository} invoke this
     * repeatedly per search. The handle itself is a live lookup surface over the filesystem, not a cache
     * of resolution results, so reusing it does not risk persisting a stale "not found".
     */
    private PackageRepository localRepository() {
        return LocalRepositoryHolder.INSTANCE;
    }

    private static final class LocalRepositoryHolder {
        private static final PackageRepository INSTANCE = BallerinaUserHome.from(
                PackageUtil.getSampleProject().projectEnvironmentContext().environment()).localPackageRepository();
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

    private Optional<TriggerMetadataModel> readTriggerMetadataModel(Path packageRoot) {
        return readResourceFile(packageRoot, TRIGGER_METADATA_RESOURCE_PATH).flatMap(json -> {
            try {
                return Optional.ofNullable(TriggerMetadataGson.instance().fromJson(json, TriggerMetadataModel.class));
            } catch (JsonParseException e) {
                return Optional.empty();
            }
        });
    }

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
     * The local {@code .bala} root of {@code moduleInfo}. Only a hit is memoized: a miss means the
     * package is not in the local repository <i>yet</i>, and caching that would hide it for the rest of
     * the session once the user pulls it (the pull itself is left to the LS's explicit, user-notified
     * flow -- see {@link PackageUtil#getModulePackageOffline}).
     */
    private Optional<Path> packageRoot(ModuleInfo moduleInfo) {
        if (moduleInfo == null || moduleInfo.org() == null || moduleInfo.moduleName() == null) {
            return Optional.empty();
        }
        String key = moduleInfo.org() + "/" + moduleInfo.moduleName();
        Optional<Path> cached = packageRootCache.getIfPresent(key);
        if (cached != null) {
            return cached;
        }
        Optional<Path> resolved = resolvePackageRoot(moduleInfo);
        if (resolved.isPresent()) {
            packageRootCache.put(key, resolved);
        }
        return resolved;
    }

    // catch(Throwable) defensively covers any unexpected compiler-API failure (e.g. a corrupted local
    // bala), which must not propagate.
    private Optional<Path> resolvePackageRoot(ModuleInfo moduleInfo) {
        try {
            Optional<Package> pkg = PackageUtil.getModulePackageOffline(PackageUtil.getSampleProject(),
                    moduleInfo.org(), moduleInfo.moduleName());
            return pkg.map(aPackage -> aPackage.project().sourceRoot());
        } catch (Throwable e) {
            return Optional.empty();
        }
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
