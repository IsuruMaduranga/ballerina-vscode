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

package io.ballerina.servicemodelgenerator.extension.builder.function;

import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.projects.Document;
import io.ballerina.servicemodelgenerator.extension.connector.AnnotationEmitter;
import io.ballerina.servicemodelgenerator.extension.connector.ConnectorModelReader;
import io.ballerina.servicemodelgenerator.extension.connector.IncludedRecordBinder;
import io.ballerina.servicemodelgenerator.extension.connector.adapter.PropertyValueAdapter;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Function;
import io.ballerina.servicemodelgenerator.extension.model.MetaData;
import io.ballerina.servicemodelgenerator.extension.model.Parameter;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.model.context.AddModelContext;
import io.ballerina.servicemodelgenerator.extension.model.context.ModelFromSourceContext;
import io.ballerina.servicemodelgenerator.extension.model.context.UpdateModelContext;
import io.ballerina.servicemodelgenerator.extension.util.ModulePrefixContext;
import org.eclipse.lsp4j.TextEdit;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

import static io.ballerina.servicemodelgenerator.extension.util.Constants.CD_TYPE_ANNOTATION_ATTACHMENT;
import static io.ballerina.servicemodelgenerator.extension.util.ServiceModelUtils.getServiceTypeIdentifier;

/**
 * Generic, schema-driven function builder for connectors that ship a unified {@link TriggerUISchemaModel}.
 * Function <b>source generation</b> (add/update) is already connector-agnostic in {@link AbstractFunctionBuilder}
 * (via {@code Utils.generateFunctionDefSource}), so this builder inherits it. Its own contributions:
 *
 * <ul>
 *   <li><b>Edit enrichment</b> — when a function is read from source for editing, the raw parse is
 *       overlaid with the connector's curated metadata (labels/descriptions/type constraints) and
 *       stamped with the connector identity so the follow-up {@code updateFunction} routes back here.</li>
 *   <li><b>Annotation pre-render</b> — before add/update, an edited unified-model annotation tree
 *       ({@code codedata.type == COMPLEX_FUNCTION_ANNOTATION}, e.g. {@code @smb:FunctionConfig})
 *       collapses into the generic {@code ANNOTATION_ATTACHMENT} property the wire emitter already
 *       understands, its value rendered by {@link AnnotationEmitter}.</li>
 * </ul>
 *
 * @since 1.8.0
 */
public class SchemaDrivenFunctionBuilder extends AbstractFunctionBuilder {

    public static final String KIND = "schema-driven";

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public Map<String, List<TextEdit>> addModel(AddModelContext context) throws Exception {
        // Strictly before renderComplexAnnotations: that collapses the annotation tree into a rendered
        // `{...}` string, baking in each enum literal's qualifier, so the qualifiers must already be
        // resolved by then.
        requalifyModuleReferences(context.function(), context.document());
        renderComplexAnnotations(context.function());
        // Must run before the emitter: it rewrites the payload param's type to the generated wrapper.
        Map<String, List<TextEdit>> typeEdits = IncludedRecordBinder.forAdd(context);
        return mergeEdits(super.addModel(context), typeEdits);
    }

    @Override
    public Map<String, List<TextEdit>> updateModel(UpdateModelContext context) {
        requalifyModuleReferences(context.function(), context.document());
        renderComplexAnnotations(context.function());
        Map<String, List<TextEdit>> typeEdits = IncludedRecordBinder.forUpdate(context);
        return mergeEdits(super.updateModel(context), typeEdits);
    }

    /**
     * Re-qualifies every module reference a function emits — parameter types, return type, and the
     * module qualifier of its annotation attachments — onto the prefixes the target file actually binds.
     *
     * <p>The trigger model authors all of these against a module's natural prefix (e.g.
     * {@code twilio:CallStatusEventWrapper}, {@code @ftp:FunctionConfig}). That prefix is not always in
     * scope: the file may import the module under an alias, either because the natural one collides with
     * a sibling package ({@code ballerinax/trigger.twilio} vs {@code ballerinax/twilio}) or because
     * something else already bound it ({@code import ballerina/file as ftp;}). The file's own imports are
     * authoritative — an added function must line up with what the service block already committed to.
     *
     * <p>Prefixes are resolved once into a {@link ModulePrefixContext} and reused for all three sites, so
     * they cannot drift apart. The function's own module and each annotation's module are registered,
     * since a function may reference several (MSSQL CDC spans {@code mssql} and {@code cdc}).
     */
    private static void requalifyModuleReferences(Function function, Document document) {
        Codedata codedata = function == null ? null : function.getCodedata();
        if (codedata == null || document == null
                || !(document.syntaxTree().rootNode() instanceof ModulePartNode rootNode)) {
            return;
        }
        String module = codedata.getModuleName();
        if (module == null || module.isBlank()) {
            return;
        }
        ModulePrefixContext prefixes = ModulePrefixContext.from(rootNode);
        // Register the function's own module first so it wins any natural-prefix tie.
        prefixes.prefixFor(codedata.getOrgName(), module);
        requalifyProperties(function.getProperties(), prefixes);
        if (!prefixes.hasAliases()) {
            return;
        }
        if (function.getParameters() != null) {
            for (Parameter parameter : function.getParameters()) {
                requalify(parameter.getType(), prefixes);
            }
        }
        requalify(function.getReturnType(), prefixes);
    }

    /**
     * Resolves the {@code valueQualifier} of every enum literal in a property tree, in place, to the
     * prefix its module is bound to ({@code afterProcess: ftp:DELETE} &rarr; {@code ftp2:DELETE}).
     *
     * <p>Unlike {@code moduleName} — a module <i>identity</i>, which is resolved at render time and
     * deliberately never overwritten here — {@code valueQualifier} <i>is</i> a prefix by definition (it
     * renders verbatim as {@code <qualifier>:<value>}), so resolving it in place stores the right kind of
     * thing. It has to happen here rather than at render time because {@code renderComplexAnnotations}
     * collapses the tree into a rendered string well before any emitter sees it.
     *
     * <p>Registers each property's declared module so the qualifier resolves by identity where the model
     * provides one; a qualifier naming an unregistered or ambiguous module is left untouched rather than
     * guessed at. Recurses through nested properties and choice branches, since an enum literal's
     * qualifier lives on the selected branch of a nested choice.
     */
    private static void requalifyProperties(Map<String, Value> properties, ModulePrefixContext prefixes) {
        if (properties == null) {
            return;
        }
        for (Value property : properties.values()) {
            requalifyProperty(property, prefixes);
        }
    }

    private static void requalifyProperty(Value property, ModulePrefixContext prefixes) {
        if (property == null) {
            return;
        }
        Codedata codedata = property.getCodedata();
        if (codedata != null) {
            // Register (never overwrite) the declared module, so an identity-carrying qualifier below
            // can be resolved precisely instead of by bare prefix.
            if (codedata.getModuleName() != null && !codedata.getModuleName().isBlank()) {
                prefixes.prefixFor(codedata.getOrgName(), codedata.getModuleName());
            }
            if (codedata.getValueQualifier() != null && !codedata.getValueQualifier().isBlank()) {
                codedata.setValueQualifier(prefixes.prefixForQualifier(
                        codedata.getOrgName(), codedata.getModuleName(), codedata.getValueQualifier()));
            }
        }
        requalifyProperties(property.getProperties(), prefixes);
        if (property.getChoices() != null) {
            for (Value choice : property.getChoices()) {
                requalifyProperty(choice, prefixes);
            }
        }
    }

    private static void requalify(Value type, ModulePrefixContext prefixes) {
        if (type == null) {
            return;
        }
        String current = type.getValue();
        if (current == null || current.isEmpty()) {
            return;
        }
        String rewritten = prefixes.requalify(current);
        if (!rewritten.equals(current)) {
            type.setValue(rewritten);
        }
    }

    /** Merges the types.bal edits of an included-record binding into the emitter's edit map. */
    private static Map<String, List<TextEdit>> mergeEdits(Map<String, List<TextEdit>> main,
                                                          Map<String, List<TextEdit>> extra) {
        if (extra.isEmpty()) {
            return main;
        }
        Map<String, List<TextEdit>> merged = new HashMap<>(main);
        extra.forEach((file, edits) -> merged.merge(file, edits, (a, b) -> {
            List<TextEdit> all = new ArrayList<>(a);
            all.addAll(b);
            return all;
        }));
        return merged;
    }

    /**
     * Collapses every COMPLEX_FUNCTION_ANNOTATION property (the granular MAPPING_FIELD /
     * FIELD_VALUE_CHOICE tree the UI edits) into an ANNOTATION_ATTACHMENT property carrying the
     * rendered mapping body, which the generic wire emitter turns into
     * {@code @<module>:<Name> {field: value, ...}}. A tree whose fields are all unchecked renders no
     * attachment (the property is disabled instead). Public for testing.
     */
    public static void renderComplexAnnotations(Function function) {
        if (function == null) {
            return;
        }
        for (Map.Entry<String, Value> entry : function.getProperties().entrySet()) {
            Value property = entry.getValue();
            Codedata codedata = property.getCodedata();
            if (codedata == null || !"COMPLEX_FUNCTION_ANNOTATION".equals(codedata.getType())) {
                continue;
            }
            Optional<String> body = AnnotationEmitter.annotationBody(PropertyValueAdapter.toProperty(property));
            Codedata attachment = new Codedata(CD_TYPE_ANNOTATION_ATTACHMENT);
            attachment.setOriginalName(codedata.getOriginalName());
            attachment.setModuleName(codedata.getModuleName());
            Value rendered = new Value.ValueBuilder()
                    .setMetadata(property.getMetadata())
                    .value(body.orElse(""))
                    .enabled(body.isPresent())
                    .editable(true)
                    .setCodedata(attachment)
                    .build();
            entry.setValue(rendered);
        }
    }

    @Override
    public Function getModelFromSource(ModelFromSourceContext context) {
        Function function = super.getModelFromSource(context);
        // The bundled schema. Stamp the connector identity so the follow-up addFunction/updateFunction
        // routes back to this builder (FunctionBuilderRouter reads org/pkg/module off the function's
        // Codedata).
        // Reading an existing function already knows the exact version from the source's ModuleID
        // (context.version()), so the bundled tier can pick the version-appropriate variant directly.
        Optional<TriggerUISchemaModel> triggerModel = ConnectorModelReader.getInstance()
                .getSchemaDrivenTriggerModel(context.orgName(), context.moduleName(), context.version());
        if (triggerModel.isPresent()) {
            overlayConnectorMetadata(function, triggerModel.get(), context.serviceType());
            stampCodedata(function, context);
        }
        return function;
    }

    /**
     * Overlays the connector's curated function/parameter metadata onto a source-parsed function from
     * the bundled unified {@link TriggerUISchemaModel}. The source parse
     * yields the real names/types/ranges; the connector model supplies the human labels, descriptions
     * and type constraints the raw source cannot. Package-visible for testing.
     */
    static void overlayConnectorMetadata(Function function, TriggerUISchemaModel triggerModel, String serviceType) {
        TriggerUISchemaModel.FunctionModel model = findFunctionModel(triggerModel, serviceType,
                function.getName() != null ? function.getName().getValue() : null);
        if (model == null) {
            return;
        }
        if (model.metadata() != null) {
            function.setMetadata(new MetaData(
                    orElse(model.metadata().label(), function.getName().getValue()),
                    orElse(model.metadata().description(), "")));
        }
        if (model.parameters() == null || function.getParameters() == null) {
            return;
        }
        for (Parameter wireParam : function.getParameters()) {
            String name = wireParam.getName() != null ? wireParam.getName().getValue() : null;
            model.parameters().stream()
                    .filter(p -> p.name() != null && Objects.equals(String.valueOf(p.name().value()), name))
                    .findFirst()
                    .ifPresent(p -> {
                        if (p.metadata() != null) {
                            wireParam.setMetadata(new MetaData(
                                    orElse(p.metadata().label(), name),
                                    orElse(p.metadata().description(), "")));
                        }
                    });
        }
    }

    private static TriggerUISchemaModel.FunctionModel findFunctionModel(TriggerUISchemaModel triggerModel,
                                                                  String serviceType, String functionName) {
        if (triggerModel == null || triggerModel.serviceTypes() == null || functionName == null) {
            return null;
        }
        TriggerUISchemaModel.ServiceTypeModel type = findServiceType(triggerModel, serviceType);
        if (type == null) {
            return null;
        }
        TriggerUISchemaModel.FunctionModel found = findByName(type.functions(), functionName);
        return found != null ? found : findByName(type.schemaFunctions(), functionName);
    }

    private static TriggerUISchemaModel.ServiceTypeModel findServiceType(TriggerUISchemaModel triggerModel,
                                                                          String serviceType) {
        String typeKey = serviceType == null ? null : getServiceTypeIdentifier(serviceType);
        if (typeKey != null) {
            for (TriggerUISchemaModel.ServiceTypeModel candidate : triggerModel.serviceTypes()) {
                if (typeKey.equals(candidate.name())
                        || (candidate.name() != null && candidate.name().endsWith(":" + typeKey))
                        || (candidate.codedata() != null && typeKey.equals(candidate.codedata().originalName()))) {
                    return candidate;
                }
            }
        }
        return triggerModel.serviceTypes().size() == 1 ? triggerModel.serviceTypes().get(0) : null;
    }

    private static TriggerUISchemaModel.FunctionModel findByName(List<TriggerUISchemaModel.FunctionModel> functions,
                                                                   String name) {
        if (functions == null) {
            return null;
        }
        return functions.stream().filter(f -> name.equals(f.name())).findFirst().orElse(null);
    }

    private void stampCodedata(Function function, ModelFromSourceContext context) {
        Codedata codedata = function.getCodedata();
        if (codedata == null) {
            codedata = new Codedata();
            function.setCodedata(codedata);
        }
        codedata.setOrgName(context.orgName());
        codedata.setPackageName(context.packageName());
        codedata.setModuleName(context.moduleName());
        if (context.version() != null) {
            codedata.setVersion(context.version());
        }
    }

    private static String orElse(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }
}
