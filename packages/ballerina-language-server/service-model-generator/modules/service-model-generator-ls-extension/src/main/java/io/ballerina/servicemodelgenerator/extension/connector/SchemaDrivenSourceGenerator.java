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

import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.util.Constants;
import io.ballerina.servicemodelgenerator.extension.util.ModuleAliasResolver;
import io.ballerina.servicemodelgenerator.extension.util.Utils;
import org.eclipse.lsp4j.TextEdit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.argName;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.fieldName;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.isChoice;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.isGroup;
import static io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel.KEY_EXISTING_LISTENER;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_CDC_OPERATION_ENABLE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_INCLUDED_DEFAULTABLE_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_INCLUDED_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_REQUIRED;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_VAR_NAME;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_SERVICE_BASE_PATH;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_SERVICE_TYPE_DESCRIPTOR;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.CLOSE_BRACE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.COLON;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.NEW_LINE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.NEW_LINE_WITH_TAB;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ON;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.OPEN_BRACE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.REMOTE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.RESOURCE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.SERVICE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.SPACE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.TAB;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.TWO_NEW_LINES;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.TYPE_SERVICE;
import static io.ballerina.servicemodelgenerator.extension.util.ServiceModelUtils.getProtocol;

/**
 * Generates Ballerina source (text edits) for adding a connector-shipped trigger/service, driven
 * entirely by the {@code codedata} on the connector models — no per-connector branches.
 *
 * <p>The creation form is walked recursively so that the same CHOICE / GROUP_SECTION nesting the
 * hardcoded builders handle (create-new vs use-existing, grouped listener configuration) is handled
 * generically:
 * <ul>
 *   <li>a <b>CHOICE</b> ({@code configureListener}) descends into its enabled (or first) branch;</li>
 *   <li>a <b>GROUP_SECTION</b> that carries a listener {@code argType} becomes one record argument
 *       assembled from its {@code CONFIG_FIELD} children, while non-config children (e.g. a nested
 *       positional param, the listener variable name) are still collected as their own args — this
 *       is a legacy shape kept for backward compatibility with already-shipped manifests;</li>
 *   <li>leaves are placed by {@code argType} — {@code REQUIRED} positional (ordered by
 *       {@code position}), {@code INCLUDED_FIELD} as {@code name = value} (a multi-segment
 *       {@code path}, e.g. {@code auth.credentials.username} — a record- or union-typed included
 *       field modeled as a nested CHOICE/GROUP_SECTION — nests into a record literal assigned to
 *       the top-level segment: {@code auth = {credentials: {username: ...}}}), {@code CONFIG_FIELD}
 *       into a record at its {@code position} slot (flat {@code CONFIG_FIELD} siblings sharing a
 *       {@code position} — the current, GROUP_SECTION-free shape for a record-typed listener
 *       param — are merged into one record literal there), {@code valueQualifier} module-prefixes
 *       enum-like values.</li>
 * </ul>
 * The service type descriptor is resolved from the {@code SERVICE_TYPE_DESCRIPTOR} field wherever it
 * sits (not by property key). Output stays format-compatible with
 * {@code AbstractServiceBuilder.getServiceDeclarationEdits}.
 *
 * @since 1.8.0
 */
public final class SchemaDrivenSourceGenerator {

    private static final String LISTENER = "listener";
    private static final String LISTENER_TYPE = "Listener";
    private static final String NEW = "new";
    private static final String ERROR = "error";
    private static final String LISTENER_VAR_NAME_KIND = "LISTENER_VAR_NAME";
    // A CHOICE branch tagged ENUM_VALUE is a plain enum-literal selector (e.g. ftp's protocol:
    // FTP/SFTP/FTPS) whose parent field's own value must be emitted as a leaf arg, unlike a branch
    // that shapes a nested record purely through its children's own dotted paths (e.g. ASB's
    // entityConfig, where the branch and its children already carry the real path).
    private static final String CD_TYPE_ENUM_VALUE = "ENUM_VALUE";
    // Default target for a CDC operation flag authored without an explicit dotted `path`: the op-code
    // of each deselected flag joins the listener's `options.skippedOperations` list (the cdc convention).
    private static final String CDC_OPTIONS_FIELD = "options";
    private static final String CDC_SKIPPED_OPERATIONS_FIELD = "skippedOperations";
    // A base path may be modeled either as a SERVICE_BASE_PATH field or as a STRING_LITERAL attach
    // point (a quoted service path) — both occupy the same slot between the descriptor and `on`.
    private static final String CD_TYPE_STRING_LITERAL = "STRING_LITERAL";

    private SchemaDrivenSourceGenerator() {
    }

    /**
     * Builds the {@code listener <proto>:Listener &lt;var&gt; = new (...);} declaration from the filled
     * creation model (CHOICE/GROUP_SECTION aware).
     */
    public static String buildListenerDeclaration(ServiceInitModel creationModel) {
        String emitAlias = defaultEmitAlias(creationModel.getModuleName());
        requalifyValueQualifiers(creationModel.getProperties(),
                getProtocol(creationModel.getModuleName()), emitAlias);
        return renderListenerDeclaration(emitAlias, collectListenerArgs(creationModel));
    }

    /**
     * The {@code \nimport <org>/<module>;\n} statement for the connector, under its natural prefix (see
     * {@link #defaultEmitAlias}) — this overload has no target file to check for a collision against, so
     * it never generates a fallback alias.
     */
    public static String buildImport(ServiceInitModel creationModel) {
        return Utils.getImportStmt(creationModel.getOrgName(), creationModel.getModuleName(),
                defaultEmitAlias(creationModel.getModuleName()));
    }

    // ==================================================================
    // Unified TriggerUISchemaModel path. The listener-arg walk below is shared across service descriptor
    // resolution; the service descriptor and function block are sourced from the TriggerUISchemaModel.
    // ==================================================================

    /** {@code addServiceAndListener} for the unified model: import (if missing) + listener/service block. */
    public static Map<String, List<TextEdit>> buildAddServiceEditsForTrigger(ServiceInitModel filledInitForm,
                                                                   TriggerUISchemaModel triggerModel,
                                                                   ModulePartNode rootNode, String filePath) {
        List<TextEdit> edits = new ArrayList<>();
        // The connector module's emitted import prefix, resolved against the file so the service block
        // and the import agree on the same (possibly aliased, collision-free) prefix.
        String emitAlias = resolveEmitAlias(rootNode, filledInitForm, triggerModel);
        String imports = buildImports(filledInitForm, triggerModel, rootNode, emitAlias);
        if (!imports.isEmpty()) {
            edits.add(new TextEdit(Utils.toRange(rootNode.lineRange().startLine()), imports));
        }
        edits.add(new TextEdit(Utils.toRange(rootNode.lineRange().endLine()),
                buildServiceBlockForTrigger(filledInitForm, triggerModel, emitAlias)));
        return Map.of(filePath, edits);
    }

    /**
     * The connector import plus any additional imports the model declares in {@code importStatements}
     * (each an {@code org/module} reference — e.g. a handler payload's or listener param's module such
     * as {@code ballerina/http}). Each is emitted only when not already present in the file.
     */
    private static String buildImports(ServiceInitModel filledInitForm, TriggerUISchemaModel triggerModel,
                                       ModulePartNode rootNode, String emitAlias) {
        StringBuilder imports = new StringBuilder();
        if (!Utils.importExists(rootNode, filledInitForm.getOrgName(), filledInitForm.getModuleName())) {
            // Aliased (`... as triggerTwilio;`) only when the natural prefix would clash — see
            // Utils.getImportStmt(org, module, alias).
            imports.append(Utils.getImportStmt(filledInitForm.getOrgName(), filledInitForm.getModuleName(),
                    emitAlias));
        }
        if (triggerModel != null && triggerModel.importStatements() != null) {
            for (String moduleRef : triggerModel.importStatements()) {
                if (moduleRef == null) {
                    continue;
                }
                int slash = moduleRef.indexOf('/');
                if (slash <= 0 || slash == moduleRef.length() - 1) {
                    continue;
                }
                String org = moduleRef.substring(0, slash);
                String module = moduleRef.substring(slash + 1);
                if (!Utils.importExists(rootNode, org, module)) {
                    imports.append(Utils.getImportStmt(org, module));
                }
            }
        }
        return imports.toString();
    }

    /**
     * Full add-trigger block from the unified model: listener declaration (create-new branch only) +
     * {@code service <descriptor> on &lt;var&gt; { <present functions> }}. Named distinctly from the
     * two-model {@code buildServiceBlock} so a {@code null} second argument stays unambiguous.
     */
    public static String buildServiceBlockForTrigger(ServiceInitModel filledInitForm,
                                                      TriggerUISchemaModel triggerModel) {
        return buildServiceBlockForTrigger(filledInitForm, triggerModel,
                modelAliasOrDefault(triggerModel, filledInitForm.getModuleName()));
    }

    /**
     * As {@link #buildServiceBlockForTrigger(ServiceInitModel, TriggerUISchemaModel)}, but referencing the
     * connector's own module under {@code emitAlias} — the prefix its import is (or will be) bound to.
     * For a dotted module whose natural prefix clashes with a base client (e.g. {@code trigger.twilio}
     * vs {@code ballerinax/twilio}) this is the safe alias {@code triggerTwilio}, and every self-module
     * reference — listener type, service descriptor, handler parameter/return types, annotations — is
     * emitted under it. For a single-segment module the alias equals the natural prefix and every
     * rewrite below is a no-op, so output is byte-identical to before.
     */
    public static String buildServiceBlockForTrigger(ServiceInitModel filledInitForm, TriggerUISchemaModel triggerModel,
                                                     String emitAlias) {
        // The prefix the model's own strings are authored with (module's last dot-segment): the source
        // token that self-module references are rewritten FROM.
        String selfPrefix = getProtocol(filledInitForm.getModuleName());
        // Enum literals carry their module as a bare `valueQualifier` (e.g. ftp's `protocol = ftp:FTP`).
        // Resolved up front, in place, so the arg/annotation walks below emit it already correct rather
        // than each having to thread the alias down to every leaf.
        requalifyValueQualifiers(filledInitForm.getProperties(), selfPrefix, emitAlias);
        ListenerArgs collected = collectListenerArgs(filledInitForm);
        String descriptor = resolveServiceDescriptor(filledInitForm, triggerModel, selfPrefix, emitAlias);
        String basePath = resolveBasePath(filledInitForm);
        List<String> functions = buildRequiredFunctionSources(filledInitForm, triggerModel, selfPrefix, emitAlias);

        StringBuilder builder = new StringBuilder(NEW_LINE);
        if (collected.declareListener) {
            builder.append(renderListenerDeclaration(emitAlias, collected)).append(NEW_LINE);
        }
        for (String annotation : buildServiceAnnotations(filledInitForm, selfPrefix, emitAlias)) {
            builder.append(annotation).append(NEW_LINE);
        }
        builder.append(SERVICE).append(SPACE).append(descriptor).append(SPACE);
        if (!basePath.isEmpty()) {
            // e.g. Salesforce's event channel: `service salesforce:CdcService /data/ChangeEvents on ...`.
            builder.append(basePath).append(SPACE);
        }
        builder.append(ON).append(SPACE)
                .append(collected.varName).append(SPACE).append(OPEN_BRACE)
                .append(NEW_LINE)
                .append(String.join(TWO_NEW_LINES, functions)).append(NEW_LINE)
                .append(CLOSE_BRACE).append(NEW_LINE);
        return builder.toString();
    }

    /**
     * The service-level annotation attachments (e.g. {@code @rabbitmq:ServiceConfig {...}}), built
     * entirely from {@code SERVICE_ANNOTATION} fields present in the filled {@code ServiceInitModel}
     * (the add-service init form) — the {@code TriggerUISchemaModel}'s service-type properties are not
     * consulted here, since at add-time the only values available are the ones the user filled in the
     * init form (e.g. RabbitMQ's {@code queueName}). Fields are grouped by their annotation identity
     * ({@code moduleName}/{@code originalName}), so several init-form fields belonging to the same
     * annotation are merged into one {@code @module:Name {...}} attachment.
     */
    private static List<String> buildServiceAnnotations(ServiceInitModel filledInitForm, String selfPrefix,
                                                        String emitAlias) {
        Map<String, AnnotationFields> byAnnotation = new LinkedHashMap<>();
        collectAnnotationFields(filledInitForm.getProperties(), byAnnotation);
        List<String> annotations = new ArrayList<>();
        for (AnnotationFields annotation : byAnnotation.values()) {
            if (annotation.wholeValue != null || !annotation.fields.isEmpty()) {
                annotations.add(annotation.render(selfPrefix, emitAlias));
            }
        }
        return annotations;
    }

    /**
     * Recursively collects {@code SERVICE_ANNOTATION} fields from a filled form, grouping same-annotation
     * fields ({@code moduleName}/{@code originalName}) together. Two shapes exist: a {@code path}-carrying
     * leaf (e.g. the init form's flat {@code queueName}) contributes one field to a per-field mapping
     * tree; a synthesized whole-record field (a single {@code RECORD_MAP_EXPRESSION} the user edits as
     * one expression — see {@code TriggerModelSynthesizer}, no {@code path}) supplies its own raw value
     * as the entire attachment body directly, matching how the read-back path already treats such a
     * container (see {@code Utils#findServiceAnnotationContainer}).
     */
    private static void collectAnnotationFields(Map<String, Value> properties,
                                                Map<String, AnnotationFields> byAnnotation) {
        if (properties == null) {
            return;
        }
        for (Value field : properties.values()) {
            if (isChoice(field)) {
                Value branch = enabledOrFirstChoice(field.getChoices());
                if (branch != null) {
                    collectAnnotationFields(branch.getProperties(), byAnnotation);
                }
                continue;
            }
            Codedata codedata = field.getCodedata();
            if (codedata != null && Constants.CD_TYPE_SERVICE_ANNOTATION.equals(codedata.getType())
                    && field.isEnabledWithValue()) {
                String rendered = qualifiedValue(field);
                if (!rendered.isEmpty()) {
                    String key = codedata.getModuleName() + COLON + codedata.getOriginalName();
                    AnnotationFields annotation = byAnnotation.computeIfAbsent(key,
                            k -> new AnnotationFields(codedata.getModuleName(), codedata.getOriginalName()));
                    if (codedata.getPath() == null || codedata.getPath().isBlank()) {
                        annotation.wholeValue = rendered;
                    } else {
                        annotation.fields.add(Map.entry(codedata.getPath(), rendered));
                    }
                }
            }
            if (isGroup(field)) {
                collectAnnotationFields(field.getProperties(), byAnnotation);
            }
        }
    }

    /** Accumulates the fields of one {@code @moduleName:originalName {...}} service annotation. */
    private static final class AnnotationFields {
        private final String moduleName;
        private final String originalName;
        private final List<Map.Entry<String, String>> fields = new ArrayList<>();
        // Set instead of `fields` for a synthesized whole-record annotation field (a single
        // RECORD_MAP_EXPRESSION with no per-field `path`) -- its own raw value IS the attachment body.
        private String wholeValue;

        private AnnotationFields(String moduleName, String originalName) {
            this.moduleName = moduleName;
            this.originalName = originalName;
        }

        /** Renders the attachment, mapping a self-module qualifier onto the emitted import alias. */
        private String render(String selfPrefix, String emitAlias) {
            String qualifier = selfPrefix.equals(moduleName) ? emitAlias : moduleName;
            String body = wholeValue != null ? wholeValue : renderFieldTree(buildFieldTree(fields));
            String prefix = qualifier == null || qualifier.isBlank()
                    ? "@" + originalName : "@" + qualifier + COLON + originalName;
            return prefix + " " + body;
        }
    }

    /**
     * Groups dot-separated {@code path}s (e.g. {@code info.name}, {@code info.version}) into a nested
     * {field -> value | nested-map} tree, so a {@code SERVICE_ANNOTATION} field whose path addresses a
     * record-typed sub-field (e.g. MCP's {@code info} record) emits as a nested mapping constructor
     * rather than a literal dotted key, which is not valid Ballerina mapping-field syntax.
     */
    private static LinkedHashMap<String, Object> buildFieldTree(List<Map.Entry<String, String>> fields) {
        LinkedHashMap<String, Object> root = new LinkedHashMap<>();
        for (Map.Entry<String, String> field : fields) {
            String[] segments = field.getKey().split("\\.");
            Map<String, Object> node = root;
            for (int i = 0; i < segments.length - 1; i++) {
                node = childMap(node, segments[i]);
            }
            node.put(segments[segments.length - 1], field.getValue());
        }
        return root;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> childMap(Map<String, Object> node, String key) {
        return (Map<String, Object>) node.computeIfAbsent(key, k -> new LinkedHashMap<String, Object>());
    }

    /** Renders a field tree built by {@link #buildFieldTree} as a mapping-constructor body. */
    @SuppressWarnings("unchecked")
    private static String renderFieldTree(Map<String, Object> node) {
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, Object> entry : node.entrySet()) {
            Object value = entry.getValue();
            String rendered = value instanceof Map ? renderFieldTree((Map<String, Object>) value) : (String) value;
            parts.add(entry.getKey() + ": " + rendered);
        }
        return "{" + String.join(", ", parts) + "}";
    }

    /**
     * Resolves {@code <module>:<ServiceType>}. Prefers a SERVICE_TYPE_DESCRIPTOR field in the init
     * form (ftp/github carry an already-qualified value); otherwise reads the selected/first
     * {@code serviceTypes[]} entry (kafka carries the descriptor on the type, not the init form).
     */
    private static String resolveServiceDescriptor(ServiceInitModel filledInitForm, TriggerUISchemaModel triggerModel,
                                                   String selfPrefix, String emitAlias) {
        String fromForm = findServiceType(filledInitForm.getProperties());
        if (fromForm != null && !fromForm.isEmpty()) {
            return qualify(fromForm, selfPrefix, emitAlias);
        }
        TriggerUISchemaModel.ServiceTypeModel serviceType = selectServiceType(filledInitForm, triggerModel);
        if (serviceType != null) {
            TriggerUISchemaModel.Codedata cd = serviceType.codedata();
            if (cd != null && cd.originalName() != null && !cd.originalName().isBlank()) {
                String module = cd.moduleName() != null && !cd.moduleName().isBlank()
                        ? aliasOf(cd.moduleName()) : selfPrefix;
                return mapSelfModule(module, selfPrefix, emitAlias) + COLON + cd.originalName();
            }
            if (serviceType.name() != null && !serviceType.name().isBlank()) {
                return qualify(serviceType.name(), selfPrefix, emitAlias);
            }
        }
        return emitAlias + COLON + TYPE_SERVICE;
    }

    /**
     * Qualifies a service type. An unqualified name is the connector's own type and takes the emitted
     * import alias; an already-qualified one keeps its declared module — normalized to that module's
     * import alias (its last dot-segment, so {@code trigger.google.mail:GmailService} becomes
     * {@code mail:GmailService}) — because the type need NOT live in the connector's own module: the
     * CDC connectors (mssql/mysql/postgresql) declare theirs in the separate {@code ballerinax/cdc}
     * module and must stay {@code cdc:Service}. Only a self-module qualifier is remapped onto the alias.
     */
    private static String qualify(String typeName, String selfPrefix, String emitAlias) {
        if (!typeName.contains(COLON)) {
            return emitAlias + COLON + typeName;
        }
        String module = aliasOf(typeName.substring(0, typeName.indexOf(COLON)));
        return mapSelfModule(module, selfPrefix, emitAlias) + COLON + simpleName(typeName);
    }

    /** The prefix to emit for a module alias: the connector's own becomes its (possibly aliased) import prefix. */
    private static String mapSelfModule(String module, String selfPrefix, String emitAlias) {
        return selfPrefix.equals(module) ? emitAlias : module;
    }

    /**
     * The import alias of a (possibly dotted) module name — its last {@code .}-separated segment. A
     * module imported as {@code ballerinax/trigger.google.mail} is referenced by the alias {@code mail}.
     */
    private static String aliasOf(String moduleName) {
        int lastDot = moduleName.lastIndexOf('.');
        return lastDot < 0 ? moduleName : moduleName.substring(lastDot + 1);
    }

    /** The simple (unqualified) type name — strips any {@code module:} prefix. */
    private static String simpleName(String typeName) {
        int colon = typeName.indexOf(COLON);
        return colon < 0 ? typeName : typeName.substring(colon + 1);
    }

    // ------------------------------------------------------------------
    // Self-module import alias
    //
    // A dotted module defaults to its natural prefix — its LAST segment (`ballerinax/trigger.twilio` ->
    // `twilio`) — same as a plain one, so the common case is a bare, unaliased import. That only breaks
    // when the target file already binds that prefix to something else: a same-named sibling package
    // (`ballerinax/twilio` also wants `twilio`) or an unrelated import (`ballerina/file as ftp`
    // shadowing `ballerina/ftp`). Only then is the module imported under a generated alias
    // (`import ballerinax/trigger.twilio as triggerTwilio;`), with every reference to its own types
    // rewritten onto it. Without a target file to check for such a collision (no rootNode in scope),
    // the natural prefix is used as-is; a single-segment module never needs an alias.
    // ------------------------------------------------------------------

    /**
     * The alias the connector's module is referenced under: {@code TriggerUISchemaModel.importPrefix} when the
     * model pins one, else the generated default.
     */
    private static String modelAliasOrDefault(TriggerUISchemaModel triggerModel, String moduleName) {
        if (triggerModel != null && triggerModel.importPrefix() != null
                && !triggerModel.importPrefix().isBlank()) {
            return triggerModel.importPrefix();
        }
        return defaultEmitAlias(moduleName);
    }

    /** @see ModuleAliasResolver#selfPrefix(String) */
    private static String defaultEmitAlias(String moduleName) {
        return ModuleAliasResolver.selfPrefix(moduleName);
    }

    /**
     * The alias to emit for the connector's module in the context of an actual file — an existing
     * import's prefix, else the model/default alias disambiguated against the prefixes the file has
     * already claimed. See {@link ModuleAliasResolver#resolve}.
     */
    private static String resolveEmitAlias(ModulePartNode rootNode, ServiceInitModel filledInitForm,
                                           TriggerUISchemaModel triggerModel) {
        String moduleName = filledInitForm.getModuleName();
        String override = triggerModel != null && triggerModel.importPrefix() != null
                && !triggerModel.importPrefix().isBlank() ? triggerModel.importPrefix() : null;
        return ModuleAliasResolver.resolve(rootNode, filledInitForm.getOrgName(), moduleName, override);
    }

    /** @see ModuleAliasResolver#rewriteSelfPrefix(String, String, String) */
    private static String rewriteSelfPrefix(String typeText, String selfPrefix, String emitAlias) {
        return ModuleAliasResolver.rewriteSelfPrefix(typeText, selfPrefix, emitAlias);
    }

    /**
     * Rewrites, in place, every {@code valueQualifier} naming the connector's own module onto the prefix
     * it is emitted under. A {@code valueQualifier} qualifies an enum literal — ftp's
     * {@code protocol = ftp:FTP} listener argument and its {@code afterProcess: ftp:DELETE} annotation
     * field — and names its module by bare prefix, so it is matched against the natural prefix rather
     * than resolved as an {@code org/module} pair. Qualifiers naming any other module are left alone.
     *
     * <p>Recurses through nested properties and choice branches: the qualifier lives on the selected
     * branch of a choice (ftp's protocol selector), not on the field itself. A no-op when the connector
     * is not aliased.
     */
    private static void requalifyValueQualifiers(Map<String, Value> properties, String selfPrefix,
                                                 String emitAlias) {
        if (properties == null || selfPrefix == null || selfPrefix.equals(emitAlias)) {
            return;
        }
        for (Value field : properties.values()) {
            requalifyValueQualifier(field, selfPrefix, emitAlias);
        }
    }

    private static void requalifyValueQualifier(Value field, String selfPrefix, String emitAlias) {
        if (field == null) {
            return;
        }
        Codedata codedata = field.getCodedata();
        if (codedata != null && selfPrefix.equals(codedata.getValueQualifier())) {
            codedata.setValueQualifier(emitAlias);
        }
        requalifyValueQualifiers(field.getProperties(), selfPrefix, emitAlias);
        if (field.getChoices() != null) {
            for (Value choice : field.getChoices()) {
                requalifyValueQualifier(choice, selfPrefix, emitAlias);
            }
        }
    }

    /**
     * Picks the service type matching the init-form selection; else the enabled one; else the first.
     *
     * <p>A model carrying a type that must not be offered for new services (e.g. mcp's deprecated
     * {@code Service} alongside {@code StreamableHttpService}) pins the choice with a hidden
     * {@code SERVICE_TYPE_DESCRIPTOR} field in its {@code initProperties}, so the selection is
     * explicit here rather than resting on {@code serviceTypes[]} order.
     */
    private static TriggerUISchemaModel.ServiceTypeModel selectServiceType(ServiceInitModel filledInitForm,
                                                                   TriggerUISchemaModel triggerModel) {
        if (triggerModel == null || triggerModel.serviceTypes() == null
                || triggerModel.serviceTypes().isEmpty()) {
            return null;
        }
        String selected = findServiceType(filledInitForm.getProperties());
        if (selected != null && !selected.isEmpty()) {
            for (TriggerUISchemaModel.ServiceTypeModel st : triggerModel.serviceTypes()) {
                if (selected.equals(st.name())) {
                    return st;
                }
            }
        }
        for (TriggerUISchemaModel.ServiceTypeModel st : triggerModel.serviceTypes()) {
            if (Boolean.TRUE.equals(st.enabled())) {
                return st;
            }
        }
        return triggerModel.serviceTypes().getFirst();
    }

    /** Emits the present (enabled, non-optional) handlers of the selected service type. */
    private static List<String> buildRequiredFunctionSources(ServiceInitModel filledInitForm,
                                                             TriggerUISchemaModel triggerModel, String selfPrefix,
                                                             String emitAlias) {
        List<String> functions = new ArrayList<>();
        TriggerUISchemaModel.ServiceTypeModel serviceType = selectServiceType(filledInitForm, triggerModel);
        if (serviceType == null || serviceType.functions() == null) {
            return functions;
        }
        for (TriggerUISchemaModel.FunctionModel function : serviceType.functions()) {
            if (function.enabled() && !Boolean.TRUE.equals(function.optional())) {
                functions.add(TAB + buildFunctionSource(function, selfPrefix, emitAlias)
                        .replace(NEW_LINE, NEW_LINE_WITH_TAB));
            }
        }
        return functions;
    }

    /** Renders one handler, leaving module-qualified types exactly as the model authored them. */
    static String buildFunctionSource(TriggerUISchemaModel.FunctionModel function) {
        return buildFunctionSource(function, "", "");
    }

    /**
     * Renders one handler from the unified {@code FunctionModel} (params carry type/name as Property),
     * re-qualifying self-module references in parameter and return types onto {@code emitAlias}.
     */
    private static String buildFunctionSource(TriggerUISchemaModel.FunctionModel function, String selfPrefix,
                                              String emitAlias) {
        StringBuilder builder = new StringBuilder();
        // Function-level annotations (COMPLEX_FUNCTION_ANNOTATION) sit above the function.
        for (String annotation : AnnotationEmitter.annotationsOf(function.properties())) {
            builder.append(annotation).append(NEW_LINE);
        }
        builder.append(qualifiers(function)).append("function").append(SPACE);
        if (RESOURCE.equals(qualifierKeyword(function.kind())) && function.accessor() != null
                && !function.accessor().isBlank()) {
            builder.append(function.accessor()).append(SPACE);
        }
        builder.append(effectiveFunctionName(function)).append("(")
                .append(buildParameterList(function, selfPrefix, emitAlias)).append(")");
        String returnClause = buildReturnType(function.returnType(), selfPrefix, emitAlias);
        if (!returnClause.isEmpty()) {
            builder.append(SPACE).append(returnClause);
        }
        builder.append(SPACE).append(OPEN_BRACE).append(NEW_LINE).append(CLOSE_BRACE);
        return builder.toString();
    }

    /**
     * The emitted function name. A format-variant handler ({@code VARIATION_SELECTOR} param) fans out
     * to the selected variant's {@code originalName} (e.g. onFileCsv / onFileJson); otherwise the
     * declared name.
     */
    private static String effectiveFunctionName(TriggerUISchemaModel.FunctionModel function) {
        if (function.parameters() != null) {
            for (TriggerUISchemaModel.Parameter parameter : function.parameters()) {
                String variantName = selectedVariantOriginalName(parameter.type());
                if (variantName != null && !variantName.isBlank()) {
                    return variantName;
                }
            }
        }
        return function.name();
    }

    private static String selectedVariantOriginalName(TriggerUISchemaModel.Property typeProp) {
        if (typeProp == null || !"VARIATION_SELECTOR".equals(PayloadComposer.selectedFieldType(typeProp))) {
            return null;
        }
        Map<String, TriggerUISchemaModel.Property> variants = typeProp.properties();
        if (variants == null || variants.isEmpty()) {
            return null;
        }
        TriggerUISchemaModel.Property selected = null;
        Object value = typeProp.value();
        if (value != null && variants.containsKey(String.valueOf(value))) {
            selected = variants.get(String.valueOf(value));
        }
        if (selected == null) {
            for (TriggerUISchemaModel.Property variant : variants.values()) {
                if (variant.enabled()) {
                    selected = variant;
                    break;
                }
            }
        }
        return selected == null || selected.codedata() == null ? null : selected.codedata().originalName();
    }

    private static String qualifiers(TriggerUISchemaModel.FunctionModel function) {
        if (function.qualifiers() != null && !function.qualifiers().isEmpty()) {
            return String.join(SPACE, function.qualifiers()) + SPACE;
        }
        String keyword = qualifierKeyword(function.kind());
        return keyword.isEmpty() ? "" : keyword + SPACE;
    }

    private static String qualifierKeyword(String kind) {
        String normalized = kind == null ? "" : kind.toUpperCase(Locale.US);
        return switch (normalized) {
            case "REMOTE", "COMPLEX_REMOTE_FUNCTION" -> REMOTE;
            case "RESOURCE", "QUERY", "MUTATION", "SUBSCRIPTION" -> RESOURCE;
            default -> "";
        };
    }

    private static String buildParameterList(TriggerUISchemaModel.FunctionModel function, String selfPrefix,
                                             String emitAlias) {
        if (function.parameters() == null) {
            return "";
        }
        List<String> params = new ArrayList<>();
        for (TriggerUISchemaModel.Parameter parameter : function.parameters()) {
            if ("FLAG".equals(PayloadComposer.selectedFieldType(parameter.type()))) {
                // Framework param (caller/context): emitted only when the checkbox is ticked.
                if (!isFlagOn(parameter)) {
                    continue;
                }
            } else if (Boolean.TRUE.equals(parameter.optional())) {
                // Core params (REQUIRED / DATA_BINDING / VARIANT) always emit unless explicitly
                // optional. (The `enabled` marker is a UI-presence flag on the template, not an
                // emission gate — a schemaFunction template ships its core param as enabled:false.)
                continue;
            }
            String type = rewriteSelfPrefix(PayloadComposer.effectiveType(parameter.type()), selfPrefix, emitAlias);
            String name = paramName(parameter);
            if (!type.isEmpty() && !name.isEmpty()) {
                params.add(type + SPACE + name);
            }
        }
        return String.join(", ", params);
    }

    private static boolean isFlagOn(TriggerUISchemaModel.Parameter parameter) {
        Object value = parameter.type() == null ? null : parameter.type().value();
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(String.valueOf(value));
    }

    private static String paramName(TriggerUISchemaModel.Parameter parameter) {
        TriggerUISchemaModel.Property nameProp = parameter.name();
        if (nameProp == null || nameProp.value() == null) {
            return "";
        }
        return String.valueOf(nameProp.value());
    }

    private static String buildReturnType(TriggerUISchemaModel.ReturnType returnType, String selfPrefix,
                                           String emitAlias) {
        if (returnType == null || !returnType.enabled() || returnType.type() == null
                || returnType.type().isBlank()) {
            return "";
        }
        String type = rewriteSelfPrefix(returnType.type(), selfPrefix, emitAlias);
        if (Boolean.TRUE.equals(returnType.hasError()) && !type.contains(ERROR)) {
            type = type + "|" + ERROR;
        }
        if (Boolean.TRUE.equals(returnType.optional()) && !type.endsWith("?")) {
            type = type + "?";
        }
        return "returns" + SPACE + type;
    }

    private static String renderListenerDeclaration(String emitAlias, ListenerArgs args) {
        String listenerType;
        if (args.listenerType != null && !args.listenerType.isBlank()) {
            // The hint carries the listener's type name (e.g. `CdcListener`), which is not always
            // `Listener`. The type always lives in the connector's own module, so it is prefixed with the
            // emitted import alias. A hint that arrives already qualified may carry the full dotted
            // module name (e.g. a `trigger.google.mail:Listener` type signature); only its simple name is
            // kept so the emitted prefix is the import alias, not the full module path.
            listenerType = emitAlias + COLON + simpleName(args.listenerType);
        } else {
            listenerType = emitAlias + COLON + LISTENER_TYPE;
        }
        return String.format("%s %s %s = %s (%s);", LISTENER, listenerType, args.varName, NEW, args.render());
    }

    // ------------------------------------------------------------------
    // Listener argument collection (CHOICE + GROUP_SECTION aware)
    // ------------------------------------------------------------------

    private static ListenerArgs collectListenerArgs(ServiceInitModel creationModel) {
        ListenerArgs args = new ListenerArgs();
        collect(creationModel.getProperties(), args);
        return args;
    }

    private static void collect(Map<String, Value> properties, ListenerArgs args) {
        if (properties == null) {
            return;
        }
        for (Map.Entry<String, Value> entry : properties.entrySet()) {
            Value field = entry.getValue();
            if (isChoice(field)) {
                Value branch = enabledOrFirstChoice(field.getChoices());
                if (branch != null && isEnumValueChoice(branch)) {
                    // The branch is a literal enum value (not a record-shaping sub-form): the selected
                    // value is the real arg (e.g. `protocol = ftp:FTP`) and must be placed itself, since
                    // no descendant path will ever recreate it. The selection is carried by the enabled
                    // branch's own `value`/`valueQualifier` (what the UI toggles), not the parent field's
                    // `value` — which the front end does not always echo back on submit — so render from
                    // the branch but place it at the parent CHOICE's arg slot (its argType/path).
                    String rendered = qualifiedValue(branch);
                    if (!rendered.isEmpty()) {
                        placeArg(field.getCodedata(), entry.getKey(), rendered, args);
                    }
                }
                if (branch != null) {
                    collect(branch.getProperties(), args);
                }
                continue;
            }
            if (isExistingListener(entry.getKey(), field)) {
                // "Use existing" branch: attach to the selected listener(s), no new declaration.
                // A MULTIPLE_SELECT_LISTENER yields several names -> `service ... on l1, l2`.
                String existing = existingListenerAttach(field);
                if (!existing.isEmpty()) {
                    args.varName = existing;
                }
                continue;
            }
            Codedata codedata = field.getCodedata();
            if (isVarName(codedata)) {
                // Presence of this field is itself the "create new listener" signal -- it only exists
                // in that branch's form, never the "use existing" one -- so a declaration must always
                // be emitted here even when every other (optional/defaultable) listener param was left
                // blank: `new ()` rather than silently dropping the declaration while the service block
                // still references this variable name.
                args.declareListener = true;
                String varName = value(field);
                if (!varName.isEmpty()) {
                    args.varName = varName;
                }
                String listenerType = listenerTypeOf(field);
                if (listenerType != null) {
                    args.listenerType = listenerType;
                }
                continue;
            }
            if (isCdcOperationFlag(codedata)) {
                collectCdcOperationFlag(field, codedata, args);
                continue;
            }
            if (isGroup(field)) {
                collectGroup(entry.getKey(), field, args);
                continue;
            }
            placeLeaf(entry.getKey(), field, codedata, args);
        }
    }

    private static boolean isCdcOperationFlag(Codedata codedata) {
        return codedata != null && ARG_TYPE_CDC_OPERATION_ENABLE.equals(codedata.getArgType());
    }

    /**
     * A CDC operation checkbox (e.g. MSSQL's "Insert events") is not emitted as its own listener
     * argument: instead it toggles membership of a record-field list. Deselecting it (value
     * {@code false}) adds its {@code originalName} op-code (e.g. {@code "c"}) to that list; a selected
     * flag contributes nothing. The target list is the flag's dotted {@code path}
     * ({@code <recordField>.<listField>}, e.g. {@code options.skippedOperations}) when authored, and
     * defaults to {@code options.skippedOperations} otherwise. The collected codes are folded into the
     * target record arg at render time ({@link ListenerArgs#render()}).
     */
    private static void collectCdcOperationFlag(Value field, Codedata codedata, ListenerArgs args) {
        boolean enabled = !"false".equalsIgnoreCase(value(field));
        if (enabled) {
            return;
        }
        String code = codedata.getOriginalName();
        if (code == null || code.isBlank()) {
            return;
        }
        List<String> segments = dottedPathSegments(codedata);
        String recordField = segments.size() >= 2 ? segments.get(0) : CDC_OPTIONS_FIELD;
        String listField = segments.size() >= 2 ? segments.get(1) : CDC_SKIPPED_OPERATIONS_FIELD;
        args.addSkippedOperation(recordField, listField, "\"" + code + "\"");
    }

    /**
     * A GROUP_SECTION is a UI grouping — it may be a plain UI-only container boxing the whole
     * "create new listener" branch (no {@code argType}/{@code position} of its own), or it may
     * itself occupy a positional slot because a record-typed listener param's fields were flattened
     * directly into it. When the group has a slot, its {@code CONFIG_FIELD} children form that one
     * record argument; when it is UI-only, each child keeps its <b>own</b> {@code position} — fields
     * sharing a position merge into a record at that slot (e.g. HubSpot's {@code {clientSecret,
     * callbackURL}} at slot 1, ahead of {@code listenOn} at slot 2), and position-less fields fall
     * back to a trailing loose record. Other children (nested positional params, the listener
     * variable name, nested groups) are collected as their own args.
     */
    private static void collectGroup(String key, Value group, ListenerArgs args) {
        Codedata groupCodedata = group.getCodedata();
        boolean groupHasSlot = groupCodedata != null
                && ARG_TYPE_LISTENER_PARAM_REQUIRED.equals(groupCodedata.getArgType());
        Map<String, Object> recordFields = new LinkedHashMap<>();
        Map<String, Value> rest = new LinkedHashMap<>();
        if (group.getProperties() != null) {
            for (Map.Entry<String, Value> child : group.getProperties().entrySet()) {
                Codedata childCodedata = child.getValue().getCodedata();
                if (childCodedata != null
                        && ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD.equals(childCodedata.getArgType())) {
                    String rendered = qualifiedValue(child.getValue());
                    if (rendered.isEmpty()) {
                        continue;
                    }
                    List<String> segments = fieldNameSegments(childCodedata, child.getKey());
                    if (groupHasSlot) {
                        // Merge into the one record literal this group occupies, nesting dotted paths.
                        ListenerArgs.insertNested(recordFields, segments, rendered);
                    } else {
                        args.addConfigField(childCodedata.getPosition(), segments, rendered);
                    }
                } else {
                    rest.put(child.getKey(), child.getValue());
                }
            }
        }
        if (groupHasSlot && !recordFields.isEmpty()) {
            args.addPositional(groupCodedata.getPosition(), ListenerArgs.renderIncludedValue(recordFields));
        }
        // Non-config children: nested positional params (e.g. listenOn), the var name, nested groups.
        collect(rest, args);
    }

    private static void placeLeaf(String key, Value field, Codedata codedata, ListenerArgs args) {
        if (codedata == null) {
            return;
        }
        String rendered = qualifiedValue(field);
        if (rendered.isEmpty()) {
            return;
        }
        String argType = codedata.getArgType();
        if (ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD.equals(argType)) {
            // A config field with no enclosing GROUP_SECTION: fields sharing the same `position`
            // (the record param's own positional slot) are merged into one record-literal argument
            // at that slot; a field with no `position` falls back to a trailing loose record. A
            // dotted `path` (e.g. `auth.username`) nests into a record at its top-level segment.
            args.addConfigField(codedata.getPosition(), fieldNameSegments(codedata, key), rendered);
            return;
        }
        placeArg(codedata, key, rendered, args);
    }

    /** Places a rendered value (leaf or group record) as positional / included per its argType. */
    private static void placeArg(Codedata codedata, String key, String rendered, ListenerArgs args) {
        String argType = codedata == null ? null : codedata.getArgType();
        if (ARG_TYPE_LISTENER_PARAM_REQUIRED.equals(argType)) {
            args.addPositional(codedata.getPosition(), rendered);
        } else if (ARG_TYPE_LISTENER_PARAM_INCLUDED_FIELD.equals(argType)
                || ARG_TYPE_LISTENER_PARAM_INCLUDED_DEFAULTABLE_FIELD.equals(argType)) {
            List<String> pathSegments = dottedPathSegments(codedata);
            if (pathSegments.size() > 1) {
                // path crosses into a nested record field (e.g. a CHOICE/GROUP_SECTION modeling a
                // record- or union-typed included field, such as `auth.credentials.username`) ->
                // nest it into a record literal assigned to the top-level segment, instead of a
                // bogus flat named arg using only the leaf's own key.
                args.addIncludedPath(pathSegments, rendered);
            } else {
                args.included.add(argName(codedata, key) + " = " + rendered);
            }
        } else if (ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD.equals(argType)) {
            args.addConfigField(codedata.getPosition(), fieldNameSegments(codedata, key), rendered);
        }
        // SERVICE_TYPE_DESCRIPTOR / unknown -> not a listener argument.
    }

    private static List<String> dottedPathSegments(Codedata codedata) {
        if (codedata == null || codedata.getPath() == null || codedata.getPath().isBlank()) {
            return List.of();
        }
        return List.of(codedata.getPath().split("\\."));
    }

    private static String findServiceType(Map<String, Value> properties) {
        if (properties == null) {
            return null;
        }
        for (Value field : properties.values()) {
            if (isChoice(field)) {
                Value branch = enabledOrFirstChoice(field.getChoices());
                String nested = branch == null ? null : findServiceType(branch.getProperties());
                if (nested != null) {
                    return nested;
                }
                continue;
            }
            Codedata codedata = field.getCodedata();
            // v1 tags the descriptor field with argType; the unified model uses codedata.type.
            if (codedata != null && field.isEnabledWithValue()
                    && (ARG_TYPE_SERVICE_TYPE_DESCRIPTOR.equals(codedata.getArgType())
                        || ARG_TYPE_SERVICE_TYPE_DESCRIPTOR.equals(codedata.getType()))) {
                return value(field);
            }
            if (isGroup(field)) {
                String nested = findServiceType(field.getProperties());
                if (nested != null) {
                    return nested;
                }
            }
        }
        return null;
    }

    /**
     * The service base path (e.g. Salesforce's event channel {@code /data/ChangeEvents}) — the value
     * of a {@code SERVICE_BASE_PATH} or {@code STRING_LITERAL} field anywhere in the filled init form,
     * emitted verbatim between the service descriptor and {@code on} (matching the DB-backed builders'
     * {@code service <type> <basePath> on ...} shape). Empty when the model ships no base-path field.
     */
    private static String resolveBasePath(ServiceInitModel filledInitForm) {
        return findBasePath(filledInitForm.getProperties());
    }

    private static String findBasePath(Map<String, Value> properties) {
        if (properties == null) {
            return "";
        }
        for (Value field : properties.values()) {
            if (isChoice(field)) {
                Value branch = enabledOrFirstChoice(field.getChoices());
                String nested = branch == null ? "" : findBasePath(branch.getProperties());
                if (!nested.isEmpty()) {
                    return nested;
                }
                continue;
            }
            Codedata codedata = field.getCodedata();
            if (codedata != null && field.isEnabledWithValue()
                    && (ARG_TYPE_SERVICE_BASE_PATH.equals(codedata.getType())
                        || ARG_TYPE_SERVICE_BASE_PATH.equals(codedata.getArgType())
                        || CD_TYPE_STRING_LITERAL.equals(codedata.getType())
                        || CD_TYPE_STRING_LITERAL.equals(codedata.getArgType()))) {
                return value(field);
            }
            if (isGroup(field)) {
                String nested = findBasePath(field.getProperties());
                if (!nested.isEmpty()) {
                    return nested;
                }
            }
        }
        return "";
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    private static boolean isVarName(Codedata codedata) {
        if (codedata == null) {
            return false;
        }
        return LISTENER_VAR_NAME_KIND.equals(codedata.getType())
                || ARG_TYPE_LISTENER_VAR_NAME.equals(codedata.getArgType());
    }

    /**
     * The listener's actual Ballerina type (e.g. {@code mssql:CdcListener}), read off the
     * {@code listenerVarName} field's {@code ballerinaType} — the connector's declared listener type
     * name is not always {@code Listener} (MSSQL CDC's is {@code CdcListener}). Falls back to
     * {@code null} (so the caller defaults to {@code <protocol>:Listener}) when unset, for manifests
     * authored before this hint existed.
     */
    private static String listenerTypeOf(Value field) {
        if (field.getTypes() == null) {
            return null;
        }
        for (PropertyType type : field.getTypes()) {
            if (type.ballerinaType() != null && !type.ballerinaType().isBlank()) {
                return type.ballerinaType();
            }
        }
        return null;
    }

    private static boolean isEnumValueChoice(Value branch) {
        Codedata branchCodedata = branch.getCodedata();
        return branchCodedata != null && CD_TYPE_ENUM_VALUE.equals(branchCodedata.getType());
    }

    private static Value enabledOrFirstChoice(List<Value> choices) {
        if (choices == null || choices.isEmpty()) {
            return null;
        }
        return choices.stream().filter(Value::isEnabled).findFirst().orElse(choices.getFirst());
    }

    /**
     * The record-field name split into its dotted segments, so a config field whose {@code path}
     * crosses into a nested record (e.g. {@code auth.username}) nests instead of emitting a flat
     * {@code auth.username: ...} key. A plain name yields a single segment.
     */
    private static List<String> fieldNameSegments(Codedata codedata, String key) {
        return List.of(fieldName(codedata, key).split("\\."));
    }

    private static String qualifiedValue(Value field) {
        String rendered = value(field);
        if (rendered.isEmpty()) {
            return "";
        }
        Codedata codedata = field.getCodedata();
        if (codedata != null && codedata.getValueQualifier() != null && !codedata.getValueQualifier().isBlank()) {
            return codedata.getValueQualifier() + COLON + rendered;
        }
        return rendered;
    }

    private static String value(Value field) {
        if (field == null) {
            return "";
        }
        String rendered = field.getValue();
        if (rendered != null && !rendered.isEmpty()) {
            return rendered;
        }
        // Multi-valued fields (TEXT_SET / EXPRESSION_SET / MULTIPLE_SELECT) carry their entries in
        // `values`, not `value` (e.g. MSSQL CDC's `databaseNames`) -> render as an array literal.
        List<String> values = field.getValues();
        if (values != null && !values.isEmpty()) {
            return "[" + String.join(", ", values) + "]";
        }
        return "";
    }

    /** The "use existing" selector — by key or by {@code codedata.type == KEY_EXISTING_LISTENER}. */
    private static boolean isExistingListener(String key, Value field) {
        if (KEY_EXISTING_LISTENER.equals(key)) {
            return true;
        }
        Codedata codedata = field == null ? null : field.getCodedata();
        return codedata != null && "KEY_EXISTING_LISTENER".equals(codedata.getType());
    }

    /**
     * The listener name(s) to attach to. A single-select yields one name; a
     * {@code MULTIPLE_SELECT_LISTENER} yields several, joined so the service attaches to all
     * (`service ... on l1, l2`).
     */
    private static String existingListenerAttach(Value field) {
        if (field == null) {
            return "";
        }
        List<String> values = field.getValues();
        if (values != null && !values.isEmpty()) {
            return String.join(", ", values);
        }
        return value(field);
    }

    /** Accumulates listener arguments: positional (by position, then unordered), included, loose config. */
    static final class ListenerArgs {
        private final TreeMap<Integer, String> byPosition = new TreeMap<>();
        private final TreeMap<Integer, Map<String, Object>> configFieldsByPosition = new TreeMap<>();
        private final List<String> noPosition = new ArrayList<>();
        private final List<String> included = new ArrayList<>();
        private final Map<String, Object> looseConfig = new LinkedHashMap<>();
        private final Map<String, Object> includedTree = new LinkedHashMap<>();
        // Aggregated CDC-style skip lists, keyed by the record-field arg they merge into (e.g.
        // "options") -> its list field name (e.g. "skippedOperations") -> the collected op-code
        // literals for that list field. Nested by list field (not flattened to one-per-recordField)
        // so two independently-toggled flag groups that happen to target the same record slot with
        // different list-field names both survive, instead of the second silently overwriting the
        // first's list-field name.
        private final Map<String, LinkedHashMap<String, List<String>>> skipLists = new LinkedHashMap<>();
        private String varName = "";
        private String listenerType;
        // Set only when the walk actually enters the "create new listener" branch (its LISTENER_VAR_NAME
        // field is unique to that form -- the "use existing" branch has no such field). Whether to emit
        // a declaration must key off this, never off "were any constructor args collected": a connector
        // whose listener config is entirely optional and left blank still needs `new ();` emitted, not a
        // silently-dropped declaration.
        private boolean declareListener;

        void addSkippedOperation(String recordField, String listField, String code) {
            skipLists.computeIfAbsent(recordField, ignored -> new LinkedHashMap<>())
                    .computeIfAbsent(listField, ignored -> new ArrayList<>())
                    .add(code);
        }

        /** Seeds a pre-rendered {@code <recordField> = {...}} included arg (test support). */
        void addIncludedArg(String rendered) {
            included.add(rendered);
        }

        private void addPositional(Integer position, String rendered) {
            if (position != null) {
                byPosition.put(position, rendered);
            } else {
                noPosition.add(rendered);
            }
        }

        /**
         * Adds a flat {@code LISTENER_PARAM_CONFIG_FIELD} (no enclosing GROUP_SECTION). Fields
         * sharing the same {@code position} are merged into one record literal at that positional
         * slot — this is how a record-typed listener param's fields are laid out (see
         * {@link #collect}). A field with no {@code position} falls back to a trailing loose record
         * for backward compatibility with older manifests. A dotted {@code path} (e.g. a nested
         * record field such as {@code auth.username}) nests into a record literal at its top-level
         * segment, so the sibling {@code auth.password} lands in the same {@code auth: {...}} record
         * rather than emitting bogus flat {@code auth.username: ...} keys.
         */
        private void addConfigField(Integer position, List<String> pathSegments, String rendered) {
            if (position != null) {
                insertNested(configFieldsByPosition.computeIfAbsent(position, ignored -> new LinkedHashMap<>()),
                        pathSegments, rendered);
            } else {
                insertNested(looseConfig, pathSegments, rendered);
            }
        }

        /**
         * Merges a rendered value into the nested-record tree at a dotted path (e.g.
         * {@code auth.credentials.username}) — intermediate segments become nested record literals,
         * so the top-level segment ({@code auth}) renders as one named arg: {@code auth = {credentials:
         * {username: "...", password: "..."}}}.
         */
        private void addIncludedPath(List<String> segments, String renderedValue) {
            insertNested(includedTree, segments, renderedValue);
        }

        /**
         * Merges a rendered value into a nested-record tree at a dotted path — intermediate segments
         * become nested record literals (shared by included args and dotted config fields).
         */
        @SuppressWarnings("unchecked")
        private static void insertNested(Map<String, Object> tree, List<String> segments, String renderedValue) {
            Map<String, Object> node = tree;
            for (int i = 0; i < segments.size() - 1; i++) {
                node = (Map<String, Object>) node.computeIfAbsent(segments.get(i), ignored -> new LinkedHashMap<>());
            }
            node.put(segments.getLast(), renderedValue);
        }

        @SuppressWarnings("unchecked")
        private static String renderIncludedValue(Object value) {
            if (value instanceof String rendered) {
                return rendered;
            }
            Map<String, Object> nested = (Map<String, Object>) value;
            List<String> fields = new ArrayList<>();
            for (Map.Entry<String, Object> entry : nested.entrySet()) {
                fields.add(entry.getKey() + ": " + renderIncludedValue(entry.getValue()));
            }
            return "{" + String.join(", ", fields) + "}";
        }

        String render() {
            TreeMap<Integer, String> positional = new TreeMap<>(byPosition);
            for (Map.Entry<Integer, Map<String, Object>> entry : configFieldsByPosition.entrySet()) {
                positional.put(entry.getKey(), renderIncludedValue(entry.getValue()));
            }
            List<String> args = new ArrayList<>(positional.values());
            args.addAll(noPosition);
            if (!looseConfig.isEmpty()) {
                args.add(renderIncludedValue(looseConfig));
            }
            // User-provided included args (with any skip list merged in place) come first, then the
            // record args from dotted paths (e.g. `database = {...}`), then freshly-created skip-list
            // args (e.g. `options = {skippedOperations: [...]}`) last — mirroring the hand-written CDC
            // builder's `database` first / `options` last ordering.
            List<String> newSkipArgs = new ArrayList<>();
            args.addAll(mergeSkipLists(newSkipArgs));
            for (Map.Entry<String, Object> entry : includedTree.entrySet()) {
                args.add(entry.getKey() + " = " + renderIncludedValue(entry.getValue()));
            }
            args.addAll(newSkipArgs);
            return String.join(", ", args);
        }

        /**
         * Folds each aggregated skip list into the matching included record argument. When that
         * record arg is already present (the user filled it, e.g. {@code options = {snapshotMode:
         * "no_data"}}) each list field is inserted/replaced inside it in place, in encounter order —
         * so two distinct list fields targeting the same record (e.g. {@code skippedOperations} and
         * a hypothetical {@code excludedColumns}) both land in it rather than the second overwriting
         * the first. Otherwise a fresh {@code <record> = {...}} argument is collected into
         * {@code newSkipArgs} for the caller to append last (also merging further list fields for the
         * same record into that same fresh argument, not one-per-list-field). Returns the
         * user-provided included args with in-place merges applied.
         */
        private List<String> mergeSkipLists(List<String> newSkipArgs) {
            List<String> result = new ArrayList<>(included);
            for (Map.Entry<String, LinkedHashMap<String, List<String>>> entry : skipLists.entrySet()) {
                String recordField = entry.getKey();
                for (Map.Entry<String, List<String>> listEntry : entry.getValue().entrySet()) {
                    List<String> codes = listEntry.getValue();
                    if (codes.isEmpty()) {
                        continue;
                    }
                    String listField = listEntry.getKey();
                    String listAssignment = listField + ": [" + String.join(", ", codes) + "]";
                    int index = indexOfIncludedArg(result, recordField);
                    if (index >= 0) {
                        result.set(index, insertListField(result.get(index), listField, listAssignment));
                        continue;
                    }
                    int freshIndex = indexOfIncludedArg(newSkipArgs, recordField);
                    if (freshIndex < 0) {
                        newSkipArgs.add(recordField + " = {" + listAssignment + "}");
                    } else {
                        newSkipArgs.set(freshIndex, insertListField(newSkipArgs.get(freshIndex), listField,
                                listAssignment));
                    }
                }
            }
            return result;
        }

        /** Index of the {@code <recordField> = ...} entry in a rendered included-arg list, or -1. */
        private static int indexOfIncludedArg(List<String> args, String recordField) {
            String prefix = recordField + " = ";
            for (int i = 0; i < args.size(); i++) {
                if (args.get(i).startsWith(prefix)) {
                    return i;
                }
            }
            return -1;
        }

        /**
         * Inserts (or replaces) a {@code <listField>: [...]} field inside an existing
         * {@code <recordField> = {...}} record argument, by splitting the record's <i>top-level</i>
         * fields (quote/brace/bracket-depth aware, so a nested record or array is never split into,
         * and a value that happens to contain {@code ]} or a field-name substring never misleads the
         * match) and replacing the one whose name exactly equals {@code listField}, or appending a new
         * one when absent. Falls back to leaving the argument untouched when its value is not a record
         * literal (a variable reference or expression the user typed).
         */
        static String insertListField(String recordArg, String listField, String listAssignment) {
            int brace = recordArg.indexOf('{');
            if (brace < 0 || !recordArg.trim().endsWith("}")) {
                return recordArg;
            }
            int close = recordArg.lastIndexOf('}');
            String inner = recordArg.substring(brace + 1, close).trim();
            List<String> fields = new ArrayList<>(splitTopLevelFields(inner));
            int existingIndex = -1;
            for (int i = 0; i < fields.size(); i++) {
                if (listField.equals(topLevelFieldName(fields.get(i)))) {
                    existingIndex = i;
                    break;
                }
            }
            if (existingIndex >= 0) {
                fields.set(existingIndex, listAssignment);
            } else {
                fields.add(listAssignment);
            }
            return recordArg.substring(0, brace + 1) + String.join(", ", fields) + "}";
        }

        /**
         * Splits a record literal's inner content into its top-level {@code field: value} entries.
         * Tracks brace/bracket/paren depth and quoted-string state so a comma inside a nested record,
         * array, or a quoted string value (which may itself contain any of {@code {}[]()},}) never
         * splits early or misdirects a match to a nested field of the same name.
         */
        static List<String> splitTopLevelFields(String inner) {
            List<String> fields = new ArrayList<>();
            if (inner.isEmpty()) {
                return fields;
            }
            int depth = 0;
            boolean inString = false;
            int start = 0;
            for (int i = 0; i < inner.length(); i++) {
                char c = inner.charAt(i);
                if (inString) {
                    if (c == '\\') {
                        i++; // skip the escaped character (e.g. \")
                    } else if (c == '"') {
                        inString = false;
                    }
                    continue;
                }
                switch (c) {
                    case '"' -> inString = true;
                    case '{', '[', '(' -> depth++;
                    case '}', ']', ')' -> depth--;
                    case ',' -> {
                        if (depth == 0) {
                            fields.add(inner.substring(start, i).trim());
                            start = i + 1;
                        }
                    }
                    default -> { }
                }
            }
            fields.add(inner.substring(start).trim());
            return fields;
        }

        /** The field name of a top-level {@code name: value} record entry, or null if malformed. */
        private static String topLevelFieldName(String field) {
            int colon = field.indexOf(':');
            return colon < 0 ? null : field.substring(0, colon).trim();
        }
    }
}
