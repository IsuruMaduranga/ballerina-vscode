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

import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Emits Ballerina annotation attachments (e.g. {@code @ftp:FunctionConfig { ... }}) from a node's
 * {@code properties} map, driven entirely by the granular {@code codedata} roles — no per-connector
 * code. Recursion mirrors the role hierarchy of the phase-6 spec:
 *
 * <ul>
 *   <li>{@code COMPLEX_FUNCTION_ANNOTATION} -> {@code @<module>:<name> { <fields> }}</li>
 *   <li>{@code MAPPING_FIELD} -> {@code <field>: <value>} (skipped when {@code optional} and its flag
 *       is unchecked); a childless field is a <i>leaf</i> that renders its own value, otherwise the
 *       value is a nested node</li>
 *   <li>{@code FIELD_VALUE_CHOICE} -> the selected (enabled) branch's value</li>
 *   <li>{@code MAPPING_CONSTRUCTOR} -> {@code { <fields> }}</li>
 *   <li>{@code ENUM_LITERAL} -> {@code <valueQualifier>:<value>}</li>
 * </ul>
 *
 * A leaf's rendered kind derives from its declared {@code types[]} (a {@code ballerinaType} of
 * {@code string} quotes the value, everything else renders raw) — which is what makes
 * {@code moveTo: "/x"} emit correctly rather than as a raw template.
 *
 * <p>Service-level {@code SERVICE_ANNOTATION} attachments (e.g. RabbitMQ's
 * {@code @rabbitmq:ServiceConfig}) are a different shape — collected purely from the filled
 * {@code ServiceInitModel} at add-time — and are handled by
 * {@link SchemaDrivenSourceGenerator#buildServiceAnnotations}, not here.
 *
 * @since 1.9.0
 */
public final class AnnotationEmitter {

    private static final String STRING_TYPE = "string";

    private AnnotationEmitter() {
    }

    /**
     * The annotation attachment strings (e.g. {@code @ftp:FunctionConfig {...}}) in a properties map.
     * A node whose body renders empty (every optional field unchecked) is skipped entirely, matching
     * {@link #annotationBody}'s behavior for the update-time path — an attachment with nothing to say
     * should not be emitted at all.
     *
     * <p>Also recognizes a whole-value {@code ANNOTATION_ATTACHMENT} node — a single
     * {@code RECORD_MAP_EXPRESSION} the user edits as one expression (a connector-synthesized
     * function-level annotation, e.g. an SMB-shaped handler annotation; see
     * {@code TriggerModelSynthesizer}), whose own {@code value} already IS the complete mapping-
     * constructor body, unlike {@code COMPLEX_FUNCTION_ANNOTATION}'s per-field {@code properties} tree.
     */
    public static List<String> annotationsOf(Map<String, TriggerUISchemaModel.Property> properties) {
        List<String> annotations = new ArrayList<>();
        if (properties == null) {
            return annotations;
        }
        for (TriggerUISchemaModel.Property node : properties.values()) {
            TriggerUISchemaModel.Codedata cd = node.codedata();
            if (cd == null) {
                continue;
            }
            if ("COMPLEX_FUNCTION_ANNOTATION".equals(cd.type())) {
                emitAnnotation(node).ifPresent(annotations::add);
            } else if ("ANNOTATION_ATTACHMENT".equals(cd.type()) && isEnabledWithValue(node)) {
                annotations.add(emitWholeValueAnnotation(node));
            }
        }
        return annotations;
    }

    private static boolean isEnabledWithValue(TriggerUISchemaModel.Property node) {
        return node.enabled() && node.value() != null && !String.valueOf(node.value()).isBlank();
    }

    /** {@code @<module>:<name> <value>} — the node's own value is already the complete attachment body. */
    private static String emitWholeValueAnnotation(TriggerUISchemaModel.Property node) {
        TriggerUISchemaModel.Codedata cd = node.codedata();
        String module = cd.moduleName();
        String name = cd.originalName();
        String prefix = module == null || module.isBlank() ? "@" + name : "@" + module + ":" + name;
        return prefix + " " + node.value();
    }

    /** The rendered annotation attachment, or empty when {@link #annotationBody} has nothing to emit. */
    private static Optional<String> emitAnnotation(TriggerUISchemaModel.Property node) {
        Optional<String> body = annotationBody(node);
        if (body.isEmpty()) {
            return Optional.empty();
        }
        TriggerUISchemaModel.Codedata cd = node.codedata();
        String module = cd.moduleName();
        String name = cd.originalName();
        String prefix = module == null || module.isBlank() ? "@" + name : "@" + module + ":" + name;
        return Optional.of(prefix + " " + body.get());
    }

    /**
     * The mapping-constructor body ({@code {field: value, ...}}) of a COMPLEX_FUNCTION_ANNOTATION
     * node, or empty when no field is emitted (all optional fields unchecked) — in which case the
     * annotation attachment should be skipped entirely.
     */
    public static Optional<String> annotationBody(TriggerUISchemaModel.Property node) {
        String body = mappingBody(node.properties());
        return "{}".equals(body) ? Optional.empty() : Optional.of(body);
    }

    /** {@code {field: value, ...}} from the MAPPING_FIELD children of a container. */
    private static String mappingBody(Map<String, TriggerUISchemaModel.Property> properties) {
        List<String> fields = new ArrayList<>();
        if (properties != null) {
            for (TriggerUISchemaModel.Property child : properties.values()) {
                String field = emitMappingField(child);
                if (field != null) {
                    fields.add(field);
                }
            }
        }
        return "{" + String.join(", ", fields) + "}";
    }

    /** {@code <field>: <value>}, or {@code null} when an optional field's flag is unchecked. */
    private static String emitMappingField(TriggerUISchemaModel.Property node) {
        TriggerUISchemaModel.Codedata cd = node.codedata();
        if (cd == null || cd.field() == null) {
            return null;
        }
        if (Boolean.TRUE.equals(cd.optional()) && !isIncluded(node)) {
            return null;
        }
        return cd.field() + ": " + fieldValue(node);
    }

    /**
     * Whether an optional mapping field is included. Two shapes exist: a flag-gated container
     * (OPTIONAL_FIELD widget — {@code value:true} is the include flag, a child node carries the
     * actual value, e.g. FTP's {@code afterProcess}) and a plain leaf (childless — {@code value} IS
     * the payload, so inclusion is its {@code enabled} state plus a non-empty value, e.g. SMB's
     * {@code fileNamePattern}).
     */
    private static boolean isIncluded(TriggerUISchemaModel.Property node) {
        if (isLeaf(node)) {
            String raw = node.value() == null ? "" : String.valueOf(node.value());
            return node.enabled() && !raw.isBlank() && !"\"\"".equals(raw);
        }
        return isTrue(node.value());
    }

    /** A mapping field is a leaf when it renders its own value — it has no nested value node. */
    private static boolean isLeaf(TriggerUISchemaModel.Property node) {
        return node.properties() == null || node.properties().isEmpty();
    }

    /** The value side of a mapping field: a rendered leaf, or a nested value node. */
    private static String fieldValue(TriggerUISchemaModel.Property node) {
        if (isLeaf(node)) {
            return renderLeaf(node);
        }
        // Nested value: the first child value node (e.g. a FIELD_VALUE_CHOICE).
        return emitValue(node.properties().values().iterator().next());
    }

    /** Renders a value node by its {@code codedata.type}. */
    private static String emitValue(TriggerUISchemaModel.Property node) {
        TriggerUISchemaModel.Codedata cd = node.codedata();
        String type = cd == null ? null : cd.type();
        if (type == null) {
            return renderLeaf(node);
        }
        return switch (type) {
            case "MAPPING_CONSTRUCTOR" -> mappingBody(node.properties());
            case "ENUM_LITERAL" -> enumLiteral(cd);
            case "FIELD_VALUE_CHOICE" -> {
                TriggerUISchemaModel.Property selected = selectedChoice(node);
                yield selected == null ? "" : emitValue(selected);
            }
            default -> renderLeaf(node);
        };
    }

    private static String enumLiteral(TriggerUISchemaModel.Codedata cd) {
        String value = cd.value() == null ? "" : cd.value();
        return cd.valueQualifier() == null || cd.valueQualifier().isBlank()
                ? value : cd.valueQualifier() + ":" + value;
    }

    private static TriggerUISchemaModel.Property selectedChoice(TriggerUISchemaModel.Property choiceNode) {
        if (choiceNode.choices() == null) {
            return null;
        }
        for (TriggerUISchemaModel.Property choice : choiceNode.choices()) {
            if (choice.enabled()) {
                return choice;
            }
        }
        return choiceNode.choices().isEmpty() ? null : choiceNode.choices().getFirst();
    }

    /**
     * Renders a leaf value by its declared type: a {@code string}-typed leaf emits a quoted literal
     * (idempotently — a value normalized upstream, e.g. a {@code string `x`} template collapsed to
     * {@code "x"} by the wire model, must not be double-quoted); everything else renders raw.
     */
    private static String renderLeaf(TriggerUISchemaModel.Property node) {
        String raw = node.value() == null ? "" : String.valueOf(node.value());
        if (!isStringTyped(node)) {
            return raw;
        }
        return raw.length() >= 2 && raw.startsWith("\"") && raw.endsWith("\"") ? raw : "\"" + raw + "\"";
    }

    /** Whether the node's selected (or sole) declared type is a plain {@code string}. */
    private static boolean isStringTyped(TriggerUISchemaModel.Property node) {
        if (node.types() == null || node.types().isEmpty()) {
            return false;
        }
        TriggerUISchemaModel.PropertyType selected = node.types().stream()
                .filter(type -> Boolean.TRUE.equals(type.selected()))
                .findFirst()
                .orElse(node.types().getFirst());
        return STRING_TYPE.equals(selected.ballerinaType());
    }

    private static boolean isTrue(Object value) {
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(String.valueOf(value));
    }
}
