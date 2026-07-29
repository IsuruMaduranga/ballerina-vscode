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

import io.ballerina.compiler.syntax.tree.ServiceDeclarationNode;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Function;
import io.ballerina.servicemodelgenerator.extension.model.Parameter;
import io.ballerina.servicemodelgenerator.extension.model.Service;
import io.ballerina.servicemodelgenerator.extension.model.context.AddModelContext;
import io.ballerina.servicemodelgenerator.extension.model.context.ModelFromSourceContext;
import io.ballerina.servicemodelgenerator.extension.model.context.UpdateModelContext;
import io.ballerina.servicemodelgenerator.extension.util.DatabindUtil;
import org.eclipse.lsp4j.TextEdit;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Included-record payload binding for schema-driven trigger handlers (the {@code
 * PAYLOAD_TYPE_INCLUDED_RECORD} marker on a payload parameter's {@code codedata}). Where a plain
 * {@code PAYLOAD_TYPE} binds the user's schema into the parameter type directly, this form wraps it
 * in a generated record that includes the connector's base record — e.g. binding {@code json} to
 * kafka's {@code onConsumerRecord} generates in {@code types.bal}:
 *
 * <pre>
 * type KafkaAnydataConsumer1 record {|
 *     *kafka:AnydataConsumerRecord;
 *     json value;
 * |};
 * </pre>
 *
 * and emits the parameter as {@code KafkaAnydataConsumer1[] records}. The UI only ever sees the
 * payload type ({@code json}): the save flows swap in the generated wrapper, and the read flow
 * resolves the wrapper's payload field back out. The binding inputs ride on the wire codedata —
 * {@code defaultType} (base record), {@code field} (payload field name), {@code typeIdentifier}
 * (generated-name base), {@code template} (parameter wrap) — put there by
 * {@code TriggerFunctionAdapter} from the connector's schema.
 *
 * @since 1.9.0
 */
public final class IncludedRecordBinder {

    private static final String CD_PAYLOAD_TYPE_INCLUDED_RECORD = "PAYLOAD_TYPE_INCLUDED_RECORD";
    private static final String TYPE_PLACEHOLDER = "{{type}}";
    /** Builtin element types a direct (non-wrapper) binding can use — never wrapper type names. */
    private static final Set<String> BUILTIN_TYPES = Set.of(
            "int", "string", "boolean", "float", "decimal", "byte", "json", "xml",
            "anydata", "any", "error", "readonly");

    private IncludedRecordBinder() {
    }

    /**
     * Applies the binding for an add-handler save: generates a fresh uniquely-named wrapper type in
     * {@code types.bal} and rewrites the parameter's emitted type to the wrapped form.
     *
     * @param context the add context (function carries the user's bound type on the payload codedata)
     * @return the {@code types.bal} edits, or empty when nothing is bound
     */
    public static Map<String, List<TextEdit>> forAdd(AddModelContext context) {
        Parameter param = includedRecordParam(context.function());
        if (param == null) {
            return Map.of();
        }
        Codedata codedata = param.getType().getCodedata();
        String boundType = codedata.getBoundType();
        String fieldName = codedata.getField();
        if (isBlank(boundType) || isBlank(fieldName)) {
            // Nothing bound (or no field declared -> degrade to direct binding): emit the type as-is.
            return Map.of();
        }
        String typeName = DatabindUtil.generateNewDataBindTypeName(context.filePath(), context.workspaceManager(),
                context.semanticModel(), null, typeIdentifierOf(codedata));
        Map<String, List<TextEdit>> edits = DatabindUtil.createTypeDefinitionEdits(context.project(), typeName,
                codedata.getDefaultType(), boundType, fieldName, context.filePath(), context.workspaceManager(),
                param.getType().getImports());
        if (!edits.isEmpty()) {
            // Only reference the wrapper once its definition actually lands (types.bal resolvable).
            applyWrappedType(param, codedata, typeName);
        }
        return edits;
    }

    /**
     * Applies the binding for an edit-handler save: rewrites the wrapper the source parameter already
     * uses (or generates one on first bind), and drops it when the binding is removed and nothing
     * else references it.
     *
     * @param context the update context (function node gives the current source parameter type)
     * @return the {@code types.bal} edits, or empty when nothing changed there
     */
    public static Map<String, List<TextEdit>> forUpdate(UpdateModelContext context) {
        Parameter param = includedRecordParam(context.function());
        if (param == null) {
            return Map.of();
        }
        Codedata codedata = param.getType().getCodedata();
        String fieldName = codedata.getField();
        String baseType = codedata.getDefaultType();
        if (isBlank(fieldName)) {
            return Map.of();
        }
        String boundType = codedata.getBoundType();
        if (isBlank(boundType)) {
            String defaultComposed = applyTemplate(codedata.getTemplate(), baseType);
            String currentValue = param.getType().getValue();
            if (currentValue != null && !currentValue.trim().equals(defaultComposed)) {
                // No binding defined and a non-default type in play (e.g. a hand-written int[]):
                // that is a custom direct binding — emit it untouched, no wrapper involved.
                return Map.of();
            }
            // Binding removed: the parameter reverts to the base composed type, and the wrapper is
            // deleted when no other code references it.
            param.getType().setValue(defaultComposed);
            return DatabindUtil.handleDataBindingDeletion(context, context.function(), param, baseType);
        }
        String existingTypeName = existingWrapperTypeName(context, param, baseType);
        if (!isBlank(existingTypeName)) {
            applyWrappedType(param, codedata, existingTypeName);
            return DatabindUtil.updateTypeDefinitionEdits(context, existingTypeName, baseType, boundType,
                    fieldName, null, param.getType().getImports());
        }
        String typeName = DatabindUtil.generateNewDataBindTypeName(context.filePath(), context.workspaceManager(),
                context.semanticModel(), context.functionNode(), typeIdentifierOf(codedata));
        Map<String, List<TextEdit>> edits = DatabindUtil.createTypeDefinitionEdits(context.project(), typeName,
                baseType, boundType, fieldName, context.filePath(), context.workspaceManager(),
                param.getType().getImports());
        if (!edits.isEmpty()) {
            applyWrappedType(param, codedata, typeName);
        }
        return edits;
    }

    /**
     * Read-side overlay: for each source handler whose payload parameter is a generated wrapper
     * (e.g. {@code KafkaAnydataConsumer1[]}), resolves the wrapper's payload field type and presents
     * <i>that</i> as the bound type — so the UI shows {@code json}, never the wrapper. Runs after the
     * textual source merge, which can only see the wrapper's name.
     *
     * @param serviceModel the merged designer model
     * @param context      the source context (semantic model + service declaration node)
     */
    public static void overlayFromSource(Service serviceModel, ModelFromSourceContext context) {
        if (serviceModel.getFunctions() == null || context.semanticModel() == null
                || !(context.node() instanceof ServiceDeclarationNode serviceNode)) {
            return;
        }
        for (Function function : serviceModel.getFunctions()) {
            Parameter param = includedRecordParam(function);
            if (param == null || !function.isEnabled()) {
                continue;
            }
            Codedata codedata = param.getType().getCodedata();
            String fieldName = codedata.getField();
            if (isBlank(fieldName) || function.getName() == null) {
                continue;
            }
            DatabindUtil.FunctionMatch match = DatabindUtil.findMatchingFunctions(serviceModel,
                    function.getName().getValue(), serviceNode);
            if (match == null || match.sourceFunctionNode() == null) {
                continue;
            }
            DatabindUtil.DataBindingTypeInfo info = DatabindUtil.extractDataBindingType(match.sourceFunctionNode(),
                    param.getName().getValue(), context.semanticModel(), fieldName);
            if (info == null || isBlank(info.typeName())) {
                // Not a recognizable binding shape (e.g. a hand-written int[]): present it as
                // unbound — the UI offers "Define ..." while the raw source type (kept as the
                // parameter value by the merge) survives a bind-less save untouched.
                codedata.setBoundType(null);
                continue;
            }
            codedata.setBoundType(info.typeName());
            param.getType().setValue(applyTemplate(codedata.getTemplate(), info.typeName()));
        }
    }

    /**
     * The wrapper type the source parameter currently uses, if any. The generic extraction is
     * syntax-first and can echo back a builtin element (e.g. {@code int} from a hand-written
     * {@code int[]}) — that is a direct binding, not a wrapper, so it is filtered out here.
     */
    private static String existingWrapperTypeName(UpdateModelContext context, Parameter param, String baseType) {
        if (context.functionNode() == null) {
            return null;
        }
        String typeName = DatabindUtil.extractExistingDatabindTypeName(context.functionNode(),
                param.getName().getValue(), context.semanticModel(), context.document(), baseType);
        return typeName == null || BUILTIN_TYPES.contains(typeName) ? null : typeName;
    }

    /** The function's included-record payload parameter, or null when it has none. */
    static Parameter includedRecordParam(Function function) {
        if (function == null || function.getParameters() == null) {
            return null;
        }
        for (Parameter parameter : function.getParameters()) {
            Codedata codedata = parameter.getType() == null ? null : parameter.getType().getCodedata();
            if (codedata != null && CD_PAYLOAD_TYPE_INCLUDED_RECORD.equals(codedata.getType())) {
                return parameter;
            }
        }
        return null;
    }

    /** The base identifier for generated wrapper names, falling back to the base type's local name. */
    static String typeIdentifierOf(Codedata codedata) {
        if (!isBlank(codedata.getTypeIdentifier())) {
            return codedata.getTypeIdentifier();
        }
        String baseType = codedata.getDefaultType() == null ? "" : codedata.getDefaultType();
        int colon = baseType.indexOf(':');
        String localName = colon >= 0 ? baseType.substring(colon + 1) : baseType;
        return localName.isBlank() ? "PayloadRecord" : localName;
    }

    private static void applyWrappedType(Parameter param, Codedata codedata, String typeName) {
        param.getType().setValue(applyTemplate(codedata.getTemplate(), typeName));
    }

    static String applyTemplate(String template, String element) {
        String safe = element == null ? "" : element;
        if (template == null || template.isBlank() || !template.contains(TYPE_PLACEHOLDER)) {
            return safe;
        }
        return template.replace(TYPE_PLACEHOLDER, safe);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
