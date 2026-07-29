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

package io.ballerina.servicemodelgenerator.extension.connector.adapter;

import io.ballerina.modelgenerator.commons.trigger.models.Repeatable;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.connector.PayloadComposer;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Function;
import io.ballerina.servicemodelgenerator.extension.model.FunctionReturnType;
import io.ballerina.servicemodelgenerator.extension.model.MetaData;
import io.ballerina.servicemodelgenerator.extension.model.Parameter;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.Value;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static io.ballerina.servicemodelgenerator.extension.util.Constants.KIND_RESOURCE;

/**
 * Adapts a unified {@link TriggerUISchemaModel.FunctionModel} into the wire {@link Function} POJOs the
 * Integrator understands ({@code Value}-wrapped name/type/return). In the unified model a
 * parameter's {@code type} and {@code name} are already {@code Property} sub-nodes, so this reads
 * their value/rendering directly instead of wrapping flat strings.
 *
 * <p><b>Variant expansion.</b> A handler with a {@code VARIANT} parameter (a {@code
 * VARIATION_SELECTOR} type whose sub-forms fix the emitted function name — e.g. FTP/SMB's
 * onFileCsv/onFileJson/… file formats) fans out into one self-contained wire {@link Function} per
 * variant. Each carries the catalog fields ({@code group}/{@code variantLabel}/{@code addLabel}/
 * {@code repeatable}), the variant's composed payload parameter (typed by {@link PayloadComposer},
 * with the composition inputs — template/defaultType/boundType/bindable — on its {@code codedata} so
 * the UI can recompose on stream/schema edits), its composition flags (PAYLOAD_MODIFIER /
 * METADATA_FLAG siblings) as wire properties, and the function-level annotation tree. The generic
 * front-end handler form and the existing wire source emitter both consume this shape without
 * per-connector code.
 *
 * @since 1.9.0
 */
public final class TriggerFunctionAdapter {

    private static final String KIND_VARIANT = "VARIANT";
    private static final String KIND_DATA_BINDING = "DATA_BINDING";
    private static final String KIND_REQUIRED = "REQUIRED";
    private static final String FIELD_TYPE_VARIATION_SELECTOR = "VARIATION_SELECTOR";

    private TriggerFunctionAdapter() {
    }

    /**
     * Converts one unified function model into its wire {@link Function}(s) — one per format variant
     * when the handler carries a VARIANT parameter, else a single function.
     */
    public static List<Function> toFunctions(TriggerUISchemaModel.FunctionModel model) {
        TriggerUISchemaModel.Parameter variantParameter = findVariantParameter(model);
        if (variantParameter == null || variantParameter.type() == null
                || variantParameter.type().properties() == null
                || variantParameter.type().properties().isEmpty()) {
            return List.of(toFunction(model, null, null));
        }
        List<Function> functions = new ArrayList<>();
        for (Map.Entry<String, TriggerUISchemaModel.Property> variant
                : variantParameter.type().properties().entrySet()) {
            functions.add(toFunction(model, variantParameter, variant.getValue()));
        }
        return functions;
    }

    /** Converts one unified function model into a single wire {@link Function} (no variant fan-out). */
    public static Function toFunction(TriggerUISchemaModel.FunctionModel model) {
        return toFunction(model, null, null);
    }

    private static Function toFunction(TriggerUISchemaModel.FunctionModel model,
                                       TriggerUISchemaModel.Parameter variantParameter,
                                       TriggerUISchemaModel.Property variant) {
        String label = label(model.metadata(), model.name());
        String description = description(model.metadata());
        String notice = model.metadata() == null ? null : model.metadata().notice();
        String badge = model.metadata() == null ? null : model.metadata().badge();
        String functionName = variant != null && variant.codedata() != null
                && notBlank(variant.codedata().originalName())
                        ? variant.codedata().originalName() : model.name();
        String variantLabel = variantLabel(model, variant);
        // The name field's own label/description, when the schema wants the rename prompt to read
        // differently from the handler's own metadata (e.g. MCP's "Function Name" / "The name of the
        // function" vs. the catalog card's "Tool" / "Define a tool function..."). Falls back to the
        // handler's own label/description, matching every schema authored before this field existed.
        String nameLabel = model.nameMetadata() != null && notBlank(model.nameMetadata().label())
                ? model.nameMetadata().label() : (variantLabel != null ? variantLabel : label);
        String nameDescription = model.nameMetadata() != null && notBlank(model.nameMetadata().description())
                ? model.nameMetadata().description() : description;

        Function.FunctionBuilder builder = new Function.FunctionBuilder()
                .setMetadata(new MetaData(label, description, notice, null, badge))
                .kind(wireKind(model.kind()))
                .name(identifierValue(functionName, nameLabel, nameDescription,
                        Boolean.TRUE.equals(model.nameEditable())))
                .parameters(toParameters(model.parameters(), variantParameter, variant))
                .returnType(toReturnType(model.returnType()))
                .enabled(model.enabled())
                .optional(Boolean.TRUE.equals(model.optional()))
                .editable(model.editable() == null || model.editable())
                .canAddParameters(Boolean.TRUE.equals(model.canAddParameters()));

        // Do NOT copy `qualifiers` — the source emitter derives the keyword from `kind`.
        if (KIND_RESOURCE.equalsIgnoreCase(model.kind()) && model.accessor() != null) {
            builder.accessor(identifierValue(model.accessor(), model.accessor(), description));
        }
        // A user-editable doc-comment (e.g. MCP's "Tool Description") rides the same
        // Function.documentation the generic emitter already turns into a `# ...` doc comment — no
        // new emission path needed, just a Value built from the schema's own template.
        if (model.documentationSchema() != null) {
            builder.documentation(PropertyValueAdapter.toValue(model.documentationSchema()));
        }
        Function function = builder.build();
        function.setGroup(notBlank(model.group()) ? model.group() : model.name());
        function.setVariantLabel(variantLabel);
        function.setAddLabel(model.metadata() == null ? null : model.metadata().addLabel());
        function.setRepeatable(Repeatable.orDefault(model.repeatable()).effective(function.getGroup()));
        function.setNameEditable(model.nameEditable());
        function.setProperties(toWireProperties(model, variant));
        function.setSchema(toParameterSchema(model.parameterSchema()));
        return function;
    }

    /**
     * Converts the addable-parameter templates ({@code canAddParameters}'s backing data) into the
     * wire {@code Function.schema} the front-end's generic {@code ParamManager} reads — one entry per
     * kind (e.g. {@code parameter}, {@code header}), each a fully-formed template {@link Parameter}
     * (editable {@code type}/{@code name}, plus {@code defaultValue}/{@code documentation}/
     * {@code headerName} where the kind uses them). Cloning one of these per user "+ Add" click, then
     * appending the clone to the function's own {@code parameters}, is exactly how
     * {@code functions/http_resource.json}'s non-schema-driven {@code schema} map already works —
     * this generalizes the same mechanism into the unified {@link TriggerUISchemaModel}.
     */
    private static Map<String, Parameter> toParameterSchema(
            Map<String, TriggerUISchemaModel.Parameter> parameterSchema) {
        if (parameterSchema == null || parameterSchema.isEmpty()) {
            return null;
        }
        Map<String, Parameter> schema = new LinkedHashMap<>();
        parameterSchema.forEach((key, template) -> schema.put(key, toParameterSchemaTemplate(template)));
        return schema;
    }

    private static Parameter toParameterSchemaTemplate(TriggerUISchemaModel.Parameter model) {
        if (model == null) {
            return null;
        }
        String label = label(model.metadata(), paramNameText(model));
        String description = description(model.metadata());
        return new Parameter.Builder()
                .metadata(new MetaData(label, description))
                .kind(model.kind())
                .type(PropertyValueAdapter.toValue(model.type()))
                .name(PropertyValueAdapter.toValue(model.name()))
                .defaultValue(PropertyValueAdapter.toValue(model.defaultValue()))
                .documentation(PropertyValueAdapter.toValue(model.documentation()))
                .headerName(PropertyValueAdapter.toValue(model.headerName()))
                .httpParamType(model.httpParamType())
                .optional(Boolean.TRUE.equals(model.optional()))
                .enabled(model.enabled() == null || model.enabled())
                .editable(model.editable() == null || model.editable())
                .build();
    }

    /**
     * Normalizes the unified model's open function-kind vocabulary onto the wire vocabulary the
     * generic emitter derives qualifiers from (e.g. {@code COMPLEX_REMOTE_FUNCTION} — a remote
     * handler with a composed payload — emits the {@code remote} qualifier).
     */
    private static String wireKind(String kind) {
        if (kind == null) {
            return null;
        }
        return switch (kind.toUpperCase(java.util.Locale.US)) {
            case "COMPLEX_REMOTE_FUNCTION" -> "REMOTE";
            case "COMPLEX_RESOURCE_FUNCTION" -> "RESOURCE";
            default -> kind;
        };
    }

    /** The parameter whose selection fans the handler out into per-format variants, if any. */
    private static TriggerUISchemaModel.Parameter findVariantParameter(TriggerUISchemaModel.FunctionModel model) {
        if (model.parameters() == null) {
            return null;
        }
        for (TriggerUISchemaModel.Parameter parameter : model.parameters()) {
            if (KIND_VARIANT.equals(parameter.kind())
                    || FIELD_TYPE_VARIATION_SELECTOR.equals(PayloadComposer.selectedFieldType(parameter.type()))) {
                return parameter;
            }
        }
        return null;
    }

    private static String variantLabel(TriggerUISchemaModel.FunctionModel model,
                                        TriggerUISchemaModel.Property variant) {
        if (variant != null) {
            if (variant.codedata() != null && notBlank(variant.codedata().variantLabel())) {
                return variant.codedata().variantLabel();
            }
            if (variant.metadata() != null && notBlank(variant.metadata().label())) {
                return variant.metadata().label();
            }
        }
        return notBlank(model.variantLabel()) ? model.variantLabel() : null;
    }

    /**
     * The wire function's properties: the function-level tree (annotations such as {@code
     * functionConfig}) plus, for an expanded variant, its composition flags (the PAYLOAD_MODIFIER
     * {@code stream} toggle, METADATA_FLAG markers) so the UI can render/toggle them.
     */
    private static Map<String, Value> toWireProperties(TriggerUISchemaModel.FunctionModel model,
                                                       TriggerUISchemaModel.Property variant) {
        Map<String, Value> properties = new LinkedHashMap<>();
        if (model.properties() != null) {
            model.properties().forEach((key, property) ->
                    properties.put(key, PropertyValueAdapter.toValue(property)));
        }
        if (variant != null) {
            // Fanned-out variant (VARIATION_SELECTOR): the composition siblings live on the selected
            // variant sub-form.
            addCompositionSiblings(variant, properties);
        } else if (model.parameters() != null) {
            // Variant-less payload param(s) — e.g. FTP's onFileCsv, whose `content` is a
            // COMPLEX_PAYLOAD directly rather than under a VARIATION_SELECTOR. The composition
            // siblings (the `stream` PAYLOAD_MODIFIER toggle, the `rows` METADATA_FLAG marker) live
            // on the parameter's own type tree and must surface as wire properties just as a
            // variant's do — otherwise the handler form drops the toggle/marker entirely.
            for (TriggerUISchemaModel.Parameter parameter : model.parameters()) {
                if (PayloadComposer.payloadNode(parameter.type()) != null) {
                    addCompositionSiblings(parameter.type(), properties);
                }
            }
        }
        return properties;
    }

    private static void addCompositionSiblings(TriggerUISchemaModel.Property payloadTree,
                                               Map<String, Value> properties) {
        PayloadComposer.compositionSiblings(payloadTree).forEach((key, sibling) ->
                properties.put(key, PropertyValueAdapter.toValue(sibling)));
    }

    private static List<Parameter> toParameters(List<TriggerUISchemaModel.Parameter> parameters,
                                                TriggerUISchemaModel.Parameter variantParameter,
                                                TriggerUISchemaModel.Property variant) {
        List<Parameter> result = new ArrayList<>();
        if (parameters == null) {
            return result;
        }
        for (TriggerUISchemaModel.Parameter parameter : parameters) {
            if (parameter == variantParameter && variant != null) {
                result.add(toPayloadParameter(parameter, variant));
            } else if (PayloadComposer.payloadNode(parameter.type()) != null) {
                // Variant-less payload param (e.g. kafka's consumer records): same composition
                // ride-along as a variant's, sourced from the parameter's own type tree.
                result.add(toPayloadParameter(parameter, parameter.type()));
            } else {
                result.add(toParameter(parameter));
            }
        }
        return result;
    }

    /**
     * The composed payload parameter of a variant sub-form or a variant-less DATA_BINDING type tree.
     * The rendered type comes from the composition algorithm; the inputs of that composition (base
     * template, default/bound element type, bindability) ride on the type's {@code codedata} so the
     * UI can recompose when the user toggles a modifier or binds a custom schema.
     */
    private static Parameter toPayloadParameter(TriggerUISchemaModel.Parameter model,
                                                 TriggerUISchemaModel.Property payloadTree) {
        TriggerUISchemaModel.Property payload = PayloadComposer.payloadNode(payloadTree);
        TriggerUISchemaModel.Codedata payloadCodedata = payload == null ? null : payload.codedata();

        String label = payload != null && payload.metadata() != null && notBlank(payload.metadata().label())
                ? payload.metadata().label() : label(model.metadata(), paramNameText(model));
        String description = payload != null && payload.metadata() != null
                && notBlank(payload.metadata().description())
                        ? payload.metadata().description() : description(model.metadata());

        String composedType = PayloadComposer.effectiveType(payloadTree);
        String defaultType = PayloadComposer.defaultComposedType(payloadTree);
        boolean bindable = payloadCodedata != null && Boolean.TRUE.equals(payloadCodedata.bindable());

        // Preserve the payload marker as shipped: PAYLOAD_TYPE_INCLUDED_RECORD additionally tells the
        // save flow to generate a wrapper record in types.bal instead of binding the type directly.
        Codedata typeCodedata = new Codedata(payloadCodedata != null && notBlank(payloadCodedata.type())
                ? payloadCodedata.type() : "PAYLOAD_TYPE");
        typeCodedata.setBindable(bindable);
        typeCodedata.setTemplate(normalizeTemplate(PayloadComposer.payloadTemplate(payloadTree)));
        if (payloadCodedata != null) {
            typeCodedata.setDefaultType(payloadCodedata.defaultType());
            typeCodedata.setBoundType(payloadCodedata.boundType());
            typeCodedata.setField(includedRecordHint(payloadCodedata, payloadCodedata.field(), "field"));
            typeCodedata.setTypeIdentifier(
                    includedRecordHint(payloadCodedata, null, "typeIdentifier", "typeIndentidier"));
            typeCodedata.setNameEditable(payloadCodedata.nameEditable());
        }

        Value type = new Value.ValueBuilder()
                .setMetadata(new MetaData(label, description))
                .value(composedType)
                .types(List.of(PropertyType.types(Value.FieldType.TYPE)))
                .setPlaceholder(defaultType)
                .editable(bindable && payload.editable())
                .enabled(true)
                .setCodedata(typeCodedata)
                .build();

        Value name = identifierValue(paramNameText(model), label, description);
        return new Parameter.Builder()
                .metadata(new MetaData(label, description))
                .kind(bindable ? KIND_DATA_BINDING : KIND_REQUIRED)
                .type(type)
                .name(name)
                .optional(false)
                .enabled(true)
                .editable(model.editable() == null || model.editable())
                .build();
    }

    /**
     * An included-record hint (payload field name / wrapper type identifier) declared either directly
     * on the payload {@code codedata} or inside its {@code modifiers} map, checked under the given
     * keys (the schema's historical {@code typeIndentidier} spelling included).
     */
    private static String includedRecordHint(TriggerUISchemaModel.Codedata payloadCodedata, String direct,
                                              String... keys) {
        if (notBlank(direct)) {
            return direct;
        }
        if (payloadCodedata.modifiers() instanceof Map<?, ?> modifiers) {
            for (String key : keys) {
                Object value = modifiers.get(key);
                if (value != null && notBlank(String.valueOf(value))) {
                    return String.valueOf(value);
                }
            }
        }
        return null;
    }

    /**
     * Normalizes a wrap template onto the {@code {{type}}} placeholder the front-end recomposer
     * understands — the included-record form (kafka) declares its wrap as a standalone {@code T}
     * (e.g. {@code T[]}), which only the LS-side composer accepts.
     */
    private static String normalizeTemplate(String template) {
        if (template == null || template.isBlank() || template.contains("{{type}}")) {
            return template;
        }
        return template.replaceAll("\\bT\\b", "{{type}}");
    }

    private static Parameter toParameter(TriggerUISchemaModel.Parameter model) {
        String label = label(model.metadata(), paramNameText(model));
        String description = description(model.metadata());

        Value name = identifierValue(paramNameText(model), label, description);

        String typeText = paramTypeText(model);
        Value.ValueBuilder typeBuilder = new Value.ValueBuilder()
                .setMetadata(new MetaData("Parameter Type", "The type of the parameter"))
                .value(typeText)
                .types(List.of(PropertyType.types(Value.FieldType.TYPE)))
                .setPlaceholder(typeText)
                .editable(false)
                .enabled(true)
                .optional(true);
        // A fixed parameter type from a module other than the connector's own (e.g. MCP's `http:Request`)
        // declares that module on its own codedata; ride it along as a wire import so the generic emitter
        // (Utils#generateFunctionParamListSource) adds the missing `import` whenever this parameter is
        // enabled — on initial add or when toggled on later on an already-existing function. Same principle
        // FunctionForm/ResourceForm already use for a user-picked type's import, just server-populated here
        // since this type is fixed by the schema rather than chosen through the type editor.
        TriggerUISchemaModel.Codedata typeCodedata = model.type() == null ? null : model.type().codedata();
        if (typeCodedata != null && notBlank(typeCodedata.moduleName()) && notBlank(typeCodedata.orgName())) {
            typeBuilder.addImport(typeCodedata.moduleName(),
                    typeCodedata.orgName() + "/" + typeCodedata.moduleName());
        }
        Value type = typeBuilder.build();

        return new Parameter.Builder()
                .metadata(new MetaData(label, description))
                .kind(model.kind())
                .type(type)
                .name(name)
                .optional(Boolean.TRUE.equals(model.optional()))
                .enabled(model.enabled() == null || model.enabled())
                .editable(model.editable() == null || model.editable())
                .advanced(Boolean.TRUE.equals(model.advanced()))
                .build();
    }

    private static FunctionReturnType toReturnType(TriggerUISchemaModel.ReturnType model) {
        if (model == null) {
            return null;
        }
        String rendered = renderReturnType(model);
        Value returnValue = new Value.ValueBuilder()
                .setMetadata(new MetaData("Return Type", "The return type of the function."))
                .value(rendered)
                .types(List.of(PropertyType.types(Value.FieldType.TYPE)))
                .setPlaceholder(rendered)
                .editable(Boolean.TRUE.equals(model.typeEditable()))
                .enabled(model.enabled())
                .optional(Boolean.TRUE.equals(model.optional()))
                .build();
        FunctionReturnType returnType = new FunctionReturnType(returnValue);
        returnType.setHasError(Boolean.TRUE.equals(model.hasError()));
        return returnType;
    }

    private static String renderReturnType(TriggerUISchemaModel.ReturnType model) {
        String type = model.type() == null ? "" : model.type();
        if (Boolean.TRUE.equals(model.hasError()) && !type.contains("error")) {
            type = type.isEmpty() ? "error" : type + "|error";
        }
        if (Boolean.TRUE.equals(model.optional()) && !type.endsWith("?")) {
            type = type + "?";
        }
        return type;
    }

    private static String paramTypeText(TriggerUISchemaModel.Parameter parameter) {
        // The effective type: plain value for TYPE, ballerinaType for FLAG, or the composed
        // payload type (element + template + active modifier) for DATA_BINDING / VARIANT / PAYLOAD_TYPE.
        return PayloadComposer.effectiveType(parameter.type());
    }

    private static String paramNameText(TriggerUISchemaModel.Parameter parameter) {
        if (parameter.name() == null || parameter.name().value() == null) {
            return "";
        }
        return String.valueOf(parameter.name().value());
    }

    private static Value identifierValue(String value, String label, String description) {
        return identifierValue(value, label, description, false);
    }

    /** {@code editable} marks the function-name identifier user-renamable (see {@code nameEditable}). */
    private static Value identifierValue(String value, String label, String description, boolean editable) {
        return new Value.ValueBuilder()
                .metadata(label, description)
                .value(value)
                .types(List.of(PropertyType.types(Value.FieldType.IDENTIFIER)))
                .setPlaceholder(value)
                .enabled(true)
                .editable(editable)
                .build();
    }

    private static String label(TriggerUISchemaModel.Metadata metadata, String fallback) {
        if (metadata != null && notBlank(metadata.label())) {
            return metadata.label();
        }
        return fallback;
    }

    private static String description(TriggerUISchemaModel.Metadata metadata) {
        return metadata == null || metadata.description() == null ? "" : metadata.description();
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }
}
