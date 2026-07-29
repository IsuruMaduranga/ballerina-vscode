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

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;
import com.google.gson.stream.JsonReader;
import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.modelgenerator.commons.CommonUtils;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.modelgenerator.commons.trigger.LibraryMetadataReader;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerLibraryFacts;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.modelgenerator.commons.trigger.utils.TriggerLibraryIntrospector;
import io.ballerina.projects.Package;
import io.ballerina.projects.PackageDescriptor;
import io.ballerina.projects.SemanticVersion;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Listener;
import io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel;
import io.ballerina.servicemodelgenerator.extension.util.ListenerUtil;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reads the unified {@code trigger-ui-schema.json} for a connector, either from a bundled classpath
 * resource shipped in this jar, or -- on a miss -- resolved from a connector's own shipped
 * {@code resources/trigger-ui-schema.json}, or -- on a further miss -- synthesized at request time from
 * a connector's own shipped {@code resources/trigger-metadata.json} plus semantic-API introspection of
 * its compiled {@code .bala}.
 *
 * <p>The bundled path (registered in {@code bundled_trigger_models.json}) is the entry point of the
 * schema-driven trigger path for connectors curated (or {@code generate-trigger-model}-authored) into
 * this jar; {@link #getBundledTriggerModel} / {@link #hasBundledTriggerModel} consult only that
 * classpath registry, keyed by bare {@code moduleName} (a small curated set, so no org/version is
 * needed to disambiguate). {@link #getSchemaDrivenTriggerModel(String, String)} /
 * {@link #hasSchemaDrivenModel(String, String)} are the org-aware superset: they check the bundled
 * registry first (unchanged, zero regression); on a miss they resolve the module's own
 * {@code trigger-ui-schema.json} (via {@link LibraryMetadataReader#getTriggerUISchemaModel}), needing no
 * synthesis at all; and on a further miss they resolve its {@code trigger-metadata.json} (via
 * {@link LibraryMetadataReader#getTriggerMetadataModel}), introspect its compiled
 * {@link SemanticModel} (via {@link TriggerLibraryIntrospector}), and synthesize a
 * {@link TriggerUISchemaModel} (via
 * {@link io.ballerina.servicemodelgenerator.extension.connector.TriggerModelSynthesizer}) -- caching
 * the result per {@code orgName/moduleName} so the resolve+introspect+synthesize cost is paid at most
 * once per module. A module with none of a bundled schema, a shipped UI schema, or a resolvable
 * {@code trigger-metadata.json} resolves to {@link Optional#empty()}, so the routers fall back to the
 * existing hardcoded builder path exactly as before.
 *
 * @since 1.8.0
 */
public class ConnectorModelReader {

    private static final ConnectorModelReader INSTANCE = new ConnectorModelReader();

    private static final List<String> INIT_IDENTITY_KEYS = List.of(
            "id", "displayName", "description", "orgName", "packageName", "moduleName", "version", "type", "icon");

    private static final String BUNDLED_TRIGGER_MODEL_REGISTRY_RESOURCE = "bundled_trigger_models.json";
    private static final Type BUNDLED_REGISTRY_TYPE = new TypeToken<Map<String, JsonElement>>() { }.getType();
    private static final String KEY_MIN_VERSION = "minVersion";
    private static final String KEY_RESOURCE = "resource";

    /**
     * One version-gated variant of a connector's bundled schema.
     *
     * @param minVersion the lowest connector version this document describes; a variant without one
     *                   matches any version and so acts as the floor
     * @param resource   the classpath resource path of the schema document
     */
    private record ModelVariant(String minVersion, String resource) {

        boolean matches(String version) {
            if (minVersion == null || minVersion.isBlank()) {
                return true;
            }
            try {
                return SemanticVersion.from(version).greaterThanOrEqualTo(SemanticVersion.from(minVersion));
            } catch (RuntimeException e) {
                // An unparsable version can't be gated on -> treat the variant as a match, which
                // (given declaration order) resolves to the newest document.
                return true;
            }
        }
    }

    /**
     * Modules for which a {@code trigger-ui-schema.json} is bundled as a classpath resource in this
     * jar. This lets a connector with a hardcoded Java builder (e.g. RabbitMQ, Kafka, Solace) migrate
     * onto the schema-driven path without needing a Central release. Keyed by moduleName to line up
     * with the routers' {@code CONSTRUCTOR_MAP}s.
     *
     * <p>Loaded from {@code bundled_trigger_models.json} (a resource sibling of
     * {@code trigger_properties.json}) rather than hardcoded, so onboarding a new bundled trigger model
     * is a data edit, not a Java edit. Falls back to an empty registry (no bundled models resolve) if
     * the resource is missing or malformed, so a broken/absent file degrades to the legacy-index
     * fallback rather than failing the class to load.
     *
     * <p>An entry is either a single resource path
     * <pre>{@code "kafka": "trigger-models/kafka.json"}</pre>
     * or, for a connector whose UI surface changed across releases, an array of variants <b>ordered
     * newest first</b>, each gated by the lowest connector version it describes:
     * <pre>{@code
     * "mcp": [
     *   { "minVersion": "1.2.0", "resource": "trigger-models/mcp.json" },
     *   { "resource": "trigger-models/mcp_1.0.3.json" }
     * ]}</pre>
     * The first variant whose {@code minVersion} the resolved connector version satisfies wins; the
     * unconstrained trailing entry is the floor. Callers with no version in hand get the first
     * (newest) variant — see {@link #getBundledTriggerModel(String)}.
     *
     * <p>The registry's resource paths are rooted at {@code trigger-models/}.
     */
    private static final Map<String, List<ModelVariant>> BUNDLED_TRIGGER_MODEL_RESOURCES =
            loadBundledTriggerModelRegistry();

    private static Map<String, List<ModelVariant>> loadBundledTriggerModelRegistry() {
        try (InputStream is = ConnectorModelReader.class.getClassLoader()
                .getResourceAsStream(BUNDLED_TRIGGER_MODEL_REGISTRY_RESOURCE)) {
            if (is == null) {
                return Map.of();
            }
            try (JsonReader reader = new JsonReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                Map<String, JsonElement> loaded = new Gson().fromJson(reader, BUNDLED_REGISTRY_TYPE);
                if (loaded == null) {
                    return Map.of();
                }
                Map<String, List<ModelVariant>> registry = new LinkedHashMap<>();
                loaded.forEach((moduleName, entry) -> {
                    List<ModelVariant> variants = parseVariants(entry);
                    if (!variants.isEmpty()) {
                        registry.put(moduleName, variants);
                    }
                });
                return Map.copyOf(registry);
            }
        } catch (IOException | JsonParseException e) {
            return Map.of();
        }
    }

    /** Normalizes both registry entry forms (a bare resource path, or an ordered variant array). */
    private static List<ModelVariant> parseVariants(JsonElement entry) {
        if (entry == null || entry.isJsonNull()) {
            return List.of();
        }
        if (entry.isJsonPrimitive()) {
            return List.of(new ModelVariant(null, entry.getAsString()));
        }
        if (!entry.isJsonArray()) {
            return List.of();
        }
        List<ModelVariant> variants = new ArrayList<>();
        for (JsonElement element : entry.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject variant = element.getAsJsonObject();
            JsonElement resource = variant.get(KEY_RESOURCE);
            if (resource == null || !resource.isJsonPrimitive()) {
                continue;
            }
            JsonElement minVersion = variant.get(KEY_MIN_VERSION);
            variants.add(new ModelVariant(
                    minVersion != null && minVersion.isJsonPrimitive() ? minVersion.getAsString() : null,
                    resource.getAsString()));
        }
        return List.copyOf(variants);
    }

    private final Gson gson = new Gson();
    private final Map<String, Optional<TriggerUISchemaModel>> bundledTriggerCache = new ConcurrentHashMap<>();
    private final Map<String, Optional<ServiceInitModel>> bundledInitCache = new ConcurrentHashMap<>();
    // Keyed by "orgName/moduleName" -- the resolve(-shipped-schema)+introspect+synthesize path, cached
    // separately from the bundled caches above since a resolved model's source (a resolved .bala)
    // differs entirely from a bundled classpath resource.
    private final Map<String, Optional<TriggerUISchemaModel>> schemaDrivenTriggerCache = new ConcurrentHashMap<>();

    private ConnectorModelReader() {
    }

    public static ConnectorModelReader getInstance() {
        return INSTANCE;
    }

    /**
     * Derives the add-trigger init form from a parsed {@code trigger-ui-schema.json} document by
     * remapping {@code initProperties -> properties} at the JSON level. The wire model expects identity
     * fields + a top-level {@code properties} map, so this remaps at the JSON level and lets Gson
     * deserialize the (already {@code Value}-shaped) init-form nodes.
     */
    private Optional<ServiceInitModel> buildServiceInitModelFromJson(JsonElement parsed) {
        if (!parsed.isJsonObject()) {
            return Optional.empty();
        }
        JsonObject root = parsed.getAsJsonObject();
        JsonElement initProperties = root.get("initProperties");
        if (initProperties == null || !initProperties.isJsonObject()) {
            return Optional.empty();
        }
        JsonObject remapped = new JsonObject();
        for (String key : INIT_IDENTITY_KEYS) {
            if (root.has(key)) {
                remapped.add(key, root.get(key));
            }
        }
        remapped.add("properties", initProperties);
        return Optional.ofNullable(gson.fromJson(remapped, ServiceInitModel.class));
    }

    // --- bundled trigger models (classpath resources shipped in this jar) ---
    // Lets a connector with a hardcoded Java builder migrate onto the schema-driven path without a
    // Central release: the schema is bundled here instead of being resolved from a .bala.

    /**
     * Cheap presence check for a bundled schema, used by the routers at dispatch time. Deliberately
     * version-free: it only decides <i>which builder</i> handles the module, and every variant of a
     * connector's schema is served by the same schema-driven builder.
     */
    public boolean hasBundledTriggerModel(String moduleName) {
        return getBundledTriggerModel(moduleName).isPresent();
    }

    /**
     * Reads and caches the bundled {@code trigger-ui-schema.json} for {@code moduleName}, if any,
     * choosing the newest variant. For a connector whose schema is version-gated, prefer
     * {@link #getBundledTriggerModel(String, String)} wherever the version the project actually
     * resolves is known — the newest variant may describe types the project's version does not have.
     */
    public Optional<TriggerUISchemaModel> getBundledTriggerModel(String moduleName) {
        return getBundledTriggerModel(moduleName, null);
    }

    /**
     * Reads and caches the bundled {@code trigger-ui-schema.json} variant that describes
     * {@code moduleName} at {@code version}. A {@code null}/blank version selects the newest variant.
     */
    public Optional<TriggerUISchemaModel> getBundledTriggerModel(String moduleName, String version) {
        return resolveResource(moduleName, version).flatMap(resource ->
                bundledTriggerCache.computeIfAbsent(resource, r ->
                        parseBundledResource(r).map(json -> gson.fromJson(json, TriggerUISchemaModel.class))));
    }

    /** Reads and caches the newest bundled model's init form for {@code moduleName}, if any. */
    public Optional<ServiceInitModel> getBundledServiceInitModel(String moduleName) {
        return getBundledServiceInitModel(moduleName, null);
    }

    /**
     * Reads and caches the init form of the bundled model variant that describes {@code moduleName} at
     * {@code version}. A {@code null}/blank version selects the newest variant.
     */
    public Optional<ServiceInitModel> getBundledServiceInitModel(String moduleName, String version) {
        return resolveResource(moduleName, version).flatMap(resource ->
                bundledInitCache.computeIfAbsent(resource, r ->
                        parseBundledResource(r).flatMap(this::buildServiceInitModelFromJson)));
    }

    /**
     * The resource path of the variant describing {@code moduleName} at {@code version}: the first
     * declared variant the version satisfies. When no version is supplied the newest (first) variant
     * wins; when the version is below every declared floor the oldest (last) variant is the closest
     * fit — a model authored without an unconstrained trailing entry still resolves to something.
     */
    private static Optional<String> resolveResource(String moduleName, String version) {
        if (moduleName == null) {
            return Optional.empty();
        }
        List<ModelVariant> variants = BUNDLED_TRIGGER_MODEL_RESOURCES.get(moduleName);
        if (variants == null || variants.isEmpty()) {
            return Optional.empty();
        }
        if (version == null || version.isBlank()) {
            return Optional.of(variants.getFirst().resource());
        }
        return Optional.of(variants.stream()
                .filter(variant -> variant.matches(version))
                .findFirst()
                .orElseGet(variants::getLast)
                .resource());
    }

    private Optional<JsonElement> parseBundledResource(String resourcePath) {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(resourcePath)) {
            if (is == null) {
                return Optional.empty();
            }
            String json = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            return Optional.of(JsonParser.parseString(json));
        } catch (IOException | JsonParseException e) {
            return Optional.empty();
        }
    }

    // --- schema-driven trigger models (bundled-by-name, falling back to shipped-schema, falling back
    // to metadata+introspection synthesis) ---

    /**
     * Cheap presence check across all tiers: the bundled classpath registry, then (on a miss, and only
     * when {@code orgName} is known) a connector-shipped {@code trigger-ui-schema.json} or a resolved,
     * synthesized model.
     */
    public boolean hasSchemaDrivenModel(String orgName, String moduleName) {
        return getSchemaDrivenTriggerModel(orgName, moduleName).isPresent();
    }

    /**
     * The connector's {@link TriggerUISchemaModel} -- bundled-by-name first (unchanged, zero
     * regression); then, on a miss, the connector's own shipped {@code resources/trigger-ui-schema.json}
     * read straight off its resolved {@code .bala} (no synthesis needed); then, on a further miss, one
     * synthesized from its shipped {@code resources/trigger-metadata.json} plus semantic introspection of
     * its compiled {@code .bala}, via {@link TriggerModelSynthesizer} -- caching the resolved result per
     * {@code orgName/moduleName}. {@code orgName == null} short-circuits to the bundled-only result --
     * some call sites (e.g. a request DTO with no org field) genuinely have no org to resolve a
     * {@code .bala} with. Equivalent to {@link #getSchemaDrivenTriggerModel(String, String, String)}
     * with a {@code null} version -- the newest bundled variant.
     */
    public Optional<TriggerUISchemaModel> getSchemaDrivenTriggerModel(String orgName, String moduleName) {
        return getSchemaDrivenTriggerModel(orgName, moduleName, null);
    }

    /**
     * Version-aware counterpart of {@link #getSchemaDrivenTriggerModel(String, String)}: the bundled
     * variant that describes {@code moduleName} at {@code version} (see
     * {@link #getBundledTriggerModel(String, String)}), falling back to the same shipped-schema/
     * synthesis tiers on a miss. The synthesis tier is version-agnostic -- it resolves the connector's
     * actual compiled {@code .bala}, which already IS the requested version -- so only the bundled tier
     * needs the version threaded through.
     */
    public Optional<TriggerUISchemaModel> getSchemaDrivenTriggerModel(String orgName, String moduleName,
                                                                       String version) {
        Optional<TriggerUISchemaModel> bundled = getBundledTriggerModel(moduleName, version);
        if (bundled.isPresent() || orgName == null || moduleName == null) {
            return bundled;
        }
        return schemaDrivenTriggerCache.computeIfAbsent(orgName + "/" + moduleName,
                ignored -> resolveSchemaDrivenTriggerModel(orgName, moduleName));
    }

    /**
     * The connector's add-trigger init form -- the {@link #getSchemaDrivenTriggerModel} counterpart of
     * {@link #getBundledServiceInitModel}, remapping a resolved model's {@code initProperties} the same
     * way {@link #buildServiceInitModelFromJson} does for a bundled one. Equivalent to
     * {@link #getSchemaDrivenServiceInitModel(String, String, String)} with a {@code null} version.
     */
    public Optional<ServiceInitModel> getSchemaDrivenServiceInitModel(String orgName, String moduleName) {
        return getSchemaDrivenServiceInitModel(orgName, moduleName, null);
    }

    /** Version-aware counterpart of {@link #getSchemaDrivenServiceInitModel(String, String)}. */
    public Optional<ServiceInitModel> getSchemaDrivenServiceInitModel(String orgName, String moduleName,
                                                                       String version) {
        Optional<ServiceInitModel> bundled = getBundledServiceInitModel(moduleName, version);
        if (bundled.isPresent() || orgName == null || moduleName == null) {
            return bundled;
        }
        return getSchemaDrivenTriggerModel(orgName, moduleName, version)
                .flatMap(model -> buildServiceInitModelFromJson(gson.toJsonTree(model)));
    }

    /**
     * Resolves a {@link TriggerUISchemaModel} for a non-bundled module: tries the connector's own
     * shipped {@code trigger-ui-schema.json} (via {@link LibraryMetadataReader}, which owns resolving
     * the connector's package and reading its JSON -- this class never does either itself) before
     * falling back to synthesis from its {@code trigger-metadata.json}.
     *
     * <p>Wrapped in a blanket {@code catch (Throwable)}: resolving the package for compilation/
     * introspection below can throw for an org/module Central has never heard of, or when offline --
     * this method runs on the hot {@code useSchemaDrivenPath} path for every unrecognized module, so any
     * such failure must degrade to "not schema-driven," not propagate and break routing for every
     * service/function request.
     */
    private Optional<TriggerUISchemaModel> resolveSchemaDrivenTriggerModel(String orgName, String moduleName) {
        try {
            return doResolveSchemaDrivenTriggerModel(orgName, moduleName);
        } catch (Throwable e) {
            return Optional.empty();
        }
    }

    private Optional<TriggerUISchemaModel> doResolveSchemaDrivenTriggerModel(String orgName, String moduleName) {
        ModuleInfo moduleInfo = new ModuleInfo(orgName, moduleName, moduleName, null);
        LibraryMetadataReader metadataReader = LibraryMetadataReader.getInstance();

        // Tier: the connector ships a full trigger-ui-schema.json directly -- no synthesis needed.
        Optional<TriggerUISchemaModel> shipped = metadataReader.getTriggerUISchemaModel(moduleInfo);
        if (shipped.isPresent()) {
            return shipped;
        }

        // Tier: synthesize from the connector's trigger-metadata.json plus semantic introspection.
        Optional<TriggerMetadataModel> metadata = metadataReader.getTriggerMetadataModel(moduleInfo);
        if (metadata.isEmpty()) {
            return Optional.empty();
        }
        Optional<Package> pkg = PackageUtil.getModulePackage(PackageUtil.getSampleProject(), orgName, moduleName);
        if (pkg.isEmpty()) {
            return Optional.empty();
        }
        SemanticModel semanticModel = PackageUtil.getCompilation(pkg.get())
                .getSemanticModel(pkg.get().getDefaultModule().moduleId());

        PackageDescriptor descriptor = pkg.get().descriptor();
        String resolvedOrg = descriptor.org().value();
        String resolvedPackageName = descriptor.name().value();
        String resolvedVersion = descriptor.version().value().toString();
        // No "home" module: every type signature the introspector produces is emitted into a
        // *different* file (the user's own service file, which has the connector only as an imported
        // dependency), so even a reference to the connector's own type (e.g. a handler's Event payload,
        // or the listener's own ListenerConfig) needs its module prefix (e.g. "calendar:Event") --
        // never bare. Passing null means CommonUtils.getTypeSignature never strips a prefix, only
        // shortens a dotted module part to its last segment (the connector's natural import alias).
        TriggerLibraryFacts facts = TriggerLibraryIntrospector.introspect(semanticModel, null);

        Listener listenerModel = resolveListenerModel(metadata.get(), semanticModel, resolvedOrg,
                resolvedPackageName, moduleName, resolvedVersion);

        String displayName = TriggerModelSynthesizer.humanize(moduleName);
        String icon = CommonUtils.generateIcon(resolvedOrg, resolvedPackageName, resolvedVersion);

        return TriggerModelSynthesizer.synthesize(metadata.get(), facts, listenerModel, moduleName, displayName,
                icon, "event", resolvedOrg, resolvedPackageName, moduleName, resolvedVersion);
    }

    /**
     * Resolves the listener init-form template for the metadata schema's declared listener class via
     * {@link ListenerUtil#getListenerModelByName} -- the same utility the non-schema-driven "add
     * listener" flow already uses, so init params (including record-typed/union-typed ones) get their
     * widget correctly resolved without this reader/synthesizer duplicating that logic. {@code null}
     * "userModuleInfo" is deliberate: there is no specific target file here (this model is cached and
     * reused across every file that might add a service for this connector), so every type keeps its
     * full module-qualified form rather than being stripped bare for a particular file's own module.
     * Returns {@code null} (not a thrown exception) on any resolution failure -- the caller still
     * renders a listener choice, just with no init params beyond its name.
     */
    private static Listener resolveListenerModel(TriggerMetadataModel metadata, SemanticModel semanticModel,
                                                 String orgName, String packageName, String moduleName,
                                                 String version) {
        try {
            String listenerType = metadata.listeners().get(0).type().name();
            Codedata codedata = new Codedata.Builder()
                    .setType(listenerType)
                    .setOrgName(orgName)
                    .setPackageName(packageName)
                    .setModuleName(moduleName)
                    .setVersion(version)
                    .build();
            return ListenerUtil.getListenerModelByName(codedata, semanticModel, null).orElse(null);
        } catch (Throwable e) {
            return null;
        }
    }
}
