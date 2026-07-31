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

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.Qualifier;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.VariableSymbol;
import io.ballerina.compiler.syntax.tree.CheckExpressionNode;
import io.ballerina.compiler.syntax.tree.FunctionArgumentNode;
import io.ballerina.compiler.syntax.tree.ListenerDeclarationNode;
import io.ballerina.compiler.syntax.tree.MappingConstructorExpressionNode;
import io.ballerina.compiler.syntax.tree.MappingFieldNode;
import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.compiler.syntax.tree.NamedArgumentNode;
import io.ballerina.compiler.syntax.tree.NewExpressionNode;
import io.ballerina.compiler.syntax.tree.Node;
import io.ballerina.compiler.syntax.tree.NonTerminalNode;
import io.ballerina.compiler.syntax.tree.PositionalArgumentNode;
import io.ballerina.compiler.syntax.tree.SeparatedNodeList;
import io.ballerina.compiler.syntax.tree.SpecificFieldNode;
import io.ballerina.projects.Document;
import io.ballerina.projects.DocumentId;
import io.ballerina.projects.Project;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.util.ListenerUtil;
import io.ballerina.tools.diagnostics.Location;
import io.ballerina.tools.text.TextRange;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.logging.Level;
import java.util.logging.Logger;

import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.argName;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.fieldName;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.isChoice;
import static io.ballerina.servicemodelgenerator.extension.connector.ValueTreeUtils.isGroup;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_CDC_OPERATION_ENABLE;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_INCLUDED_DEFAULTABLE_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_INCLUDED_FIELD;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.ARG_TYPE_LISTENER_PARAM_REQUIRED;

/**
 * Builds the "use existing" listener selector for the schema-driven path, resolving each existing
 * listener's configuration from both the model (field template) and the source ({@code new(...)} args)
 * as read-only fields.
 *
 * @since 1.8.0
 */
public final class ExistingListenerResolver {

    private static final Logger LOGGER = Logger.getLogger(ExistingListenerResolver.class.getName());

    // A bare enum-literal selector (e.g. ftp's protocol) rather than a record-shaping sub-form.
    private static final String CD_TYPE_ENUM_VALUE = "ENUM_VALUE";

    private ExistingListenerResolver() {
    }

    /**
     * Builds a {@code SINGLE_SELECT} of the given listeners; selecting one reveals its config
     * (read-only) resolved from source, using {@code createNewBranch} as the field template.
     */
    public static Value buildSelector(Value createNewBranch, List<String> listenerNames,
                                      SemanticModel semanticModel, Project project, String protocol) {
        ListenerTemplate template = collectTemplate(createNewBranch);
        Map<String, Value> createNewProps = createNewBranch == null ? null : createNewBranch.getProperties();
        Map<String, Value> perListenerConfigs = new LinkedHashMap<>();
        for (String name : listenerNames) {
            Map<String, Value> fields = new LinkedHashMap<>();
            parseListener(name, semanticModel, project).ifPresent(parsed -> {
                fields.putAll(buildFieldsFromParsed(parsed, template));
                fields.putAll(resolveIncludedFields(createNewProps, parsed.named()));
            });
            Value configGroup = new Value.ValueBuilder()
                    .metadata(name, protocol + " listener: " + name)
                    .value(name)
                    .types(List.of(PropertyType.types(Value.FieldType.FORM)))
                    .enabled(true)
                    .editable(false)
                    .setProperties(fields)
                    .build();
            perListenerConfigs.put(name, configGroup);
        }
        return assembleSelector(listenerNames, perListenerConfigs, protocol);
    }

    /**
     * Assembles the {@code existingListener} dropdown (pure; unit-testable). Must NOT carry
     * {@code options} — that would route it to the expression/enum editor instead of the nested
     * per-listener config view (front-end {@code DropdownChoiceForm}).
     */
    static Value assembleSelector(List<String> listenerNames, Map<String, Value> perListenerConfigs,
                                  String protocol) {
        return new Value.ValueBuilder()
                .metadata("Select Listener", String.format("Select from the existing %s listeners", protocol))
                .value(listenerNames.getFirst())
                .types(List.of(PropertyType.types(Value.FieldType.SINGLE_SELECT)))
                .enabled(true)
                .editable(true)
                .setItems(new ArrayList<>(listenerNames))
                .setProperties(perListenerConfigs)
                .build();
    }

    /** The listener-parameter field template derived from the create-new branch. */
    static final class ListenerTemplate {
        final Map<Integer, Field> positionalScalars = new LinkedHashMap<>();
        final Map<Integer, LinkedHashMap<String, Value>> recordGroups = new LinkedHashMap<>();
        final LinkedHashMap<String, Value> named = new LinkedHashMap<>();
    }

    record Field(String key, Value template) {
    }

    static ListenerTemplate collectTemplate(Value createNewBranch) {
        ListenerTemplate template = new ListenerTemplate();
        collectTemplate(createNewBranch == null ? null : createNewBranch.getProperties(), template);
        return template;
    }

    private static void collectTemplate(Map<String, Value> properties, ListenerTemplate template) {
        if (properties == null) {
            return;
        }
        for (Map.Entry<String, Value> entry : properties.entrySet()) {
            Value field = entry.getValue();
            if (isGroup(field)) {
                Codedata groupCodedata = field.getCodedata();
                boolean groupHasSlot = groupCodedata != null
                        && ARG_TYPE_LISTENER_PARAM_REQUIRED.equals(groupCodedata.getArgType())
                        && groupCodedata.getPosition() != null;
                LinkedHashMap<String, Value> configChildren = new LinkedHashMap<>();
                Map<String, Value> rest = new LinkedHashMap<>();
                if (field.getProperties() != null) {
                    for (Map.Entry<String, Value> child : field.getProperties().entrySet()) {
                        Codedata childCodedata = child.getValue().getCodedata();
                        if (childCodedata != null
                                && ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD.equals(childCodedata.getArgType())) {
                            String name = fieldName(childCodedata, child.getKey());
                            if (groupHasSlot) {
                                configChildren.put(name, child.getValue());
                            } else if (childCodedata.getPosition() != null) {
                                template.recordGroups
                                        .computeIfAbsent(childCodedata.getPosition(),
                                                ignored -> new LinkedHashMap<>())
                                        .put(name, child.getValue());
                            } else {
                                template.named.put(name, child.getValue());
                            }
                        } else {
                            rest.put(child.getKey(), child.getValue());
                        }
                    }
                }
                if (groupHasSlot && !configChildren.isEmpty()) {
                    template.recordGroups.put(groupCodedata.getPosition(), configChildren);
                }
                collectTemplate(rest, template);
                continue;
            }
            Codedata codedata = field.getCodedata();
            if (codedata == null) {
                continue;
            }
            String argType = codedata.getArgType();
            if (ARG_TYPE_LISTENER_PARAM_REQUIRED.equals(argType) && codedata.getPosition() != null) {
                template.positionalScalars.put(codedata.getPosition(), new Field(entry.getKey(), field));
            } else if (ARG_TYPE_LISTENER_PARAM_INCLUDED_FIELD.equals(argType)
                    || ARG_TYPE_LISTENER_PARAM_INCLUDED_DEFAULTABLE_FIELD.equals(argType)) {
                template.named.put(argName(codedata, entry.getKey()), field);
            } else if (ARG_TYPE_LISTENER_PARAM_CONFIG_FIELD.equals(argType)) {
                template.named.put(fieldName(codedata, entry.getKey()), field);
            }
        }
    }

    /**
     * A parsed {@code new(...)}: positional args (scalar or record) and named args (as a nested-record tree).
     *
     * @param positional the args passed by position
     * @param named      the args passed by name, as a nested-record tree
     */
    record ParsedListener(List<ParsedArg> positional, LinkedHashMap<String, Object> named) {
    }

    /**
     * One argument: exactly one of {@code scalar} / {@code recordFields} is set.
     *
     * @param scalar       the argument's value, when it is a simple scalar
     * @param recordFields the argument's fields, when it is a record
     */
    record ParsedArg(String scalar, LinkedHashMap<String, String> recordFields) {
        static ParsedArg scalar(String value) {
            return new ParsedArg(value, null);
        }

        static ParsedArg record(LinkedHashMap<String, String> fields) {
            return new ParsedArg(null, fields);
        }
    }

    static Map<String, Value> buildFieldsFromParsed(ParsedListener parsed, ListenerTemplate template) {
        Map<String, Value> fields = new LinkedHashMap<>();
        List<ParsedArg> positional = parsed.positional();
        for (int i = 0; i < positional.size(); i++) {
            int position = i + 1;
            ParsedArg arg = positional.get(i);
            if (arg.recordFields() != null && template.recordGroups.containsKey(position)) {
                LinkedHashMap<String, Value> configTemplates = template.recordGroups.get(position);
                arg.recordFields().forEach((name, value) ->
                        fields.put(name, readOnly(configTemplates.get(name), name, value)));
            } else if (template.positionalScalars.containsKey(position)) {
                Field field = template.positionalScalars.get(position);
                String value = arg.scalar() != null ? arg.scalar() : renderRecord(arg.recordFields());
                fields.put(field.key(), readOnly(field.template(), field.key(), value));
            }
        }
        return fields;
    }

    /**
     * Walks the create-new field tree and, for every included-field leaf / CHOICE, resolves its value
     * from the parsed named-arg tree by the leaf's dotted {@code path}. Fields whose value cannot be
     * located are dropped. GROUP_SECTIONs and enum-value CHOICEs are flattened; a record-shaping CHOICE
     * is kept as a read-only radio with only the matching branch selected and populated.
     */
    static Map<String, Value> resolveIncludedFields(Map<String, Value> templateProps,
                                                    Map<String, Object> named) {
        Map<String, Value> resolved = new LinkedHashMap<>();
        if (templateProps == null) {
            return resolved;
        }
        for (Map.Entry<String, Value> entry : templateProps.entrySet()) {
            Value field = entry.getValue();
            if (isChoice(field)) {
                if (isEnumValueChoiceField(field)) {
                    Value branch = selectEnumBranch(field, named);
                    if (branch != null) {
                        resolved.putAll(resolveIncludedFields(branch.getProperties(), named));
                    }
                    continue;
                }
                Value choice = resolveRecordChoice(field, named);
                if (choice != null) {
                    resolved.put(entry.getKey(), choice);
                }
                continue;
            }
            if (isGroup(field)) {
                resolved.putAll(resolveIncludedFields(field.getProperties(), named));
                continue;
            }
            Codedata codedata = field.getCodedata();
            if (!isIncludedField(codedata) || isCdcOperationFlag(codedata)) {
                continue;
            }
            String value = resolveByPath(named, lookupSegments(codedata, entry.getKey()));
            if (value != null && !value.isBlank()) {
                resolved.put(entry.getKey(), readOnlyClone(field, value));
            }
        }
        return resolved;
    }

    /**
     * Picks the record-shaping CHOICE branch that best matches the source (most resolved values wins,
     * ties break toward the smaller branch) and returns a read-only radio with only that branch populated.
     */
    private static Value resolveRecordChoice(Value field, Map<String, Object> named) {
        List<Value> branches = field.getChoices();
        if (branches == null || branches.isEmpty()) {
            return null;
        }
        int bestIndex = -1;
        int bestScore = -1;
        int bestLeaves = Integer.MAX_VALUE;
        List<Map<String, Value>> resolvedBranches = new ArrayList<>();
        for (int i = 0; i < branches.size(); i++) {
            Map<String, Value> branchFields = resolveIncludedFields(branches.get(i).getProperties(), named);
            resolvedBranches.add(branchFields);
            int leaves = countIncludedLeaves(branches.get(i).getProperties());
            int score = branchFields.size();
            if (score > bestScore || (score == bestScore && leaves < bestLeaves)) {
                bestScore = score;
                bestLeaves = leaves;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) {
            return null;
        }
        List<Value> readOnlyBranches = new ArrayList<>();
        for (int i = 0; i < branches.size(); i++) {
            Value branch = new Value(branches.get(i));
            branch.setEditable(false);
            if (i == bestIndex) {
                branch.setEnabled(true);
                branch.setProperties(resolvedBranches.get(i));
            } else {
                branch.setEnabled(false);
                branch.setProperties(new LinkedHashMap<>());
            }
            readOnlyBranches.add(branch);
        }
        Value choice = new Value(field);
        choice.setChoices(readOnlyBranches);
        choice.setProperties(null);
        choice.setValue("");
        choice.setEnabled(true);
        choice.setEditable(false);
        choice.setOptional(false);
        choice.setAdvanced(false);
        choice.setValidations(null);
        return choice;
    }

    /** Resolves the enum CHOICE's own value and returns the matching branch, falling back to the enabled/first. */
    private static Value selectEnumBranch(Value field, Map<String, Object> named) {
        List<Value> branches = field.getChoices();
        if (branches == null || branches.isEmpty()) {
            return null;
        }
        String own = resolveByPath(named, lookupSegments(field.getCodedata(), null));
        if (own != null && !own.isBlank()) {
            String selected = stripModulePrefix(own);
            for (Value branch : branches) {
                if (selected.equalsIgnoreCase(stripModulePrefix(branch.getValue()))) {
                    return branch;
                }
            }
        }
        return branches.stream().filter(Value::isEnabled).findFirst().orElse(branches.getFirst());
    }

    /** Navigates the parsed named-arg tree along the dotted path, rendering a sub-record if it terminates on one. */
    private static String resolveByPath(Map<String, Object> named, List<String> segments) {
        if (named == null || segments.isEmpty()) {
            return null;
        }
        Object current = named;
        for (String segment : segments) {
            if (!(current instanceof Map<?, ?> map)) {
                return null;
            }
            current = map.get(segment);
            if (current == null) {
                return null;
            }
        }
        if (current instanceof String scalar) {
            return scalar;
        }
        if (current instanceof Map<?, ?> record) {
            return renderRecordTree(record);
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static String renderRecordTree(Map<?, ?> record) {
        if (record.isEmpty()) {
            return "{}";
        }
        List<String> parts = new ArrayList<>();
        for (Map.Entry<?, ?> entry : record.entrySet()) {
            Object value = entry.getValue();
            String rendered = value instanceof Map<?, ?> nested
                    ? renderRecordTree(nested) : String.valueOf(value);
            parts.add(entry.getKey() + ": " + rendered);
        }
        return "{" + String.join(", ", parts) + "}";
    }

    /** The named-arg lookup path for a leaf: a multi-segment {@code path}, or the emitted arg name. */
    private static List<String> lookupSegments(Codedata codedata, String key) {
        String path = codedata == null ? null : codedata.getPath();
        if (path != null && !path.isBlank()) {
            String[] segments = path.split("\\.");
            if (segments.length > 1) {
                return List.of(segments);
            }
        }
        String name = argName(codedata, key);
        if (name != null && !name.isBlank()) {
            return List.of(name);
        }
        return path != null && !path.isBlank() ? List.of(path) : List.of();
    }

    private static int countIncludedLeaves(Map<String, Value> properties) {
        if (properties == null) {
            return 0;
        }
        int count = 0;
        for (Value field : properties.values()) {
            if (isChoice(field)) {
                for (Value branch : field.getChoices() == null ? List.<Value>of() : field.getChoices()) {
                    count += countIncludedLeaves(branch.getProperties());
                }
            } else if (isGroup(field)) {
                count += countIncludedLeaves(field.getProperties());
            } else if (isIncludedField(field.getCodedata())) {
                count++;
            }
        }
        return count;
    }

    private static boolean isIncludedField(Codedata codedata) {
        if (codedata == null) {
            return false;
        }
        String argType = codedata.getArgType();
        return ARG_TYPE_LISTENER_PARAM_INCLUDED_FIELD.equals(argType)
                || ARG_TYPE_LISTENER_PARAM_INCLUDED_DEFAULTABLE_FIELD.equals(argType);
    }

    private static boolean isCdcOperationFlag(Codedata codedata) {
        return codedata != null && ARG_TYPE_CDC_OPERATION_ENABLE.equals(codedata.getArgType());
    }

    /** A CHOICE whose (enabled/first) branch is a bare enum literal selector (ftp's protocol). */
    private static boolean isEnumValueChoiceField(Value field) {
        if (field.getChoices() == null) {
            return false;
        }
        return field.getChoices().stream()
                .anyMatch(branch -> branch.getCodedata() != null
                        && CD_TYPE_ENUM_VALUE.equals(branch.getCodedata().getType()));
    }

    private static String stripModulePrefix(String value) {
        if (value == null) {
            return "";
        }
        int colon = value.lastIndexOf(':');
        return colon >= 0 ? value.substring(colon + 1).trim() : value.trim();
    }

    /** Clones the template leaf (preserving label/type) as a read-only value carrying the resolved source. */
    private static Value readOnlyClone(Value template, String value) {
        Value copy = new Value(template);
        copy.setChoices(null);
        copy.setProperties(null);
        copy.setValue(value);
        copy.setEnabled(true);
        copy.setEditable(false);
        // Must be non-optional/non-advanced: DropdownChoiceForm hides those fields on the front end.
        copy.setOptional(false);
        copy.setAdvanced(false);
        copy.setValidations(null);
        return copy;
    }

    /** Clones the template field (preserving label/type) as a read-only value; falls back to a text value. */
    private static Value readOnly(Value template, String key, String value) {
        if (template == null) {
            return ListenerUtil.buildReadOnlyTextValue(key, "", value);
        }
        Value copy = new Value(template);
        copy.setValue(value);
        copy.setEnabled(true);
        copy.setEditable(false);
        copy.setOptional(false);
        copy.setAdvanced(false);
        copy.setValidations(null);
        return copy;
    }

    private static String renderRecord(LinkedHashMap<String, String> recordFields) {
        if (recordFields == null || recordFields.isEmpty()) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        recordFields.forEach((name, value) -> parts.add(name + ": " + value));
        return "{" + String.join(", ", parts) + "}";
    }

    static Optional<ParsedListener> parseListener(String listenerName, SemanticModel semanticModel, Project project) {
        try {
            ListenerDeclarationNode declaration = findListenerDeclaration(listenerName, semanticModel, project);
            if (declaration == null) {
                return Optional.empty();
            }
            NewExpressionNode newExpression = asNewExpression(declaration.initializer());
            if (newExpression == null) {
                return Optional.empty();
            }
            SeparatedNodeList<FunctionArgumentNode> arguments = ListenerUtil.getArgList(newExpression);
            if (arguments == null) {
                return Optional.empty();
            }
            List<ParsedArg> positional = new ArrayList<>();
            LinkedHashMap<String, Object> named = new LinkedHashMap<>();
            for (FunctionArgumentNode argument : arguments) {
                if (argument instanceof PositionalArgumentNode positionalArg) {
                    positional.add(toParsedArg(positionalArg.expression()));
                } else if (argument instanceof NamedArgumentNode namedArg) {
                    named.put(namedArg.argumentName().name().text().trim(),
                            parseExpression(namedArg.expression()));
                }
            }
            return Optional.of(new ParsedListener(positional, named));
        } catch (RuntimeException e) {
            // Never fail the "use existing listener" dropdown over one unparsable declaration.
            LOGGER.log(Level.FINE, e,
                    () -> "Failed to parse existing listener declaration '%s'".formatted(listenerName));
            return Optional.empty();
        }
    }

    /** A named-arg expression as a nested-record tree: a record literal becomes a {@code Map}, else trimmed source. */
    private static Object parseExpression(Node expression) {
        if (expression instanceof MappingConstructorExpressionNode mapping) {
            LinkedHashMap<String, Object> record = new LinkedHashMap<>();
            for (MappingFieldNode fieldNode : mapping.fields()) {
                if (fieldNode instanceof SpecificFieldNode specificField) {
                    String name = unquote(specificField.fieldName().toSourceCode().trim());
                    Object value = specificField.valueExpr()
                            .map(ExistingListenerResolver::parseExpression)
                            .orElse("");
                    record.put(name, value);
                }
            }
            return record;
        }
        return expression.toSourceCode().trim();
    }

    private static ParsedArg toParsedArg(Node expression) {
        if (expression instanceof MappingConstructorExpressionNode mapping) {
            LinkedHashMap<String, String> recordFields = new LinkedHashMap<>();
            for (MappingFieldNode fieldNode : mapping.fields()) {
                if (fieldNode instanceof SpecificFieldNode specificField) {
                    String name = unquote(specificField.fieldName().toSourceCode().trim());
                    String value = specificField.valueExpr()
                            .map(expr -> expr.toSourceCode().trim())
                            .orElse("");
                    recordFields.put(name, value);
                }
            }
            return ParsedArg.record(recordFields);
        }
        return ParsedArg.scalar(expression.toSourceCode().trim());
    }

    private static NewExpressionNode asNewExpression(Node initializer) {
        if (initializer instanceof CheckExpressionNode checkExpression
                && checkExpression.expression() instanceof NewExpressionNode newExpression) {
            return newExpression;
        }
        if (initializer instanceof NewExpressionNode newExpression) {
            return newExpression;
        }
        return null;
    }

    private static ListenerDeclarationNode findListenerDeclaration(String listenerName, SemanticModel semanticModel,
                                                                   Project project) {
        Optional<VariableSymbol> listenerSymbol = Optional.empty();
        for (Symbol symbol : semanticModel.moduleSymbols()) {
            if (symbol instanceof VariableSymbol variableSymbol
                    && variableSymbol.qualifiers().contains(Qualifier.LISTENER)
                    && variableSymbol.getName().map(listenerName::equals).orElse(false)) {
                listenerSymbol = Optional.of(variableSymbol);
                break;
            }
        }
        if (listenerSymbol.isEmpty() || listenerSymbol.get().getLocation().isEmpty()) {
            return null;
        }
        Location location = listenerSymbol.get().getLocation().get();
        Path path = project.sourceRoot().resolve(location.lineRange().fileName());
        DocumentId documentId = project.documentId(path);
        Document document = project.currentPackage().getDefaultModule().document(documentId);
        if (document == null) {
            return null;
        }
        ModulePartNode rootNode = document.syntaxTree().rootNode();
        TextRange range = TextRange.from(location.textRange().startOffset(), location.textRange().length());
        NonTerminalNode node = rootNode.findNode(range);
        while (node != null && !(node instanceof ListenerDeclarationNode)) {
            node = node.parent();
        }
        return (ListenerDeclarationNode) node;
    }

    private static String unquote(String text) {
        if (text.length() >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
            return text.substring(1, text.length() - 1);
        }
        return text;
    }
}
