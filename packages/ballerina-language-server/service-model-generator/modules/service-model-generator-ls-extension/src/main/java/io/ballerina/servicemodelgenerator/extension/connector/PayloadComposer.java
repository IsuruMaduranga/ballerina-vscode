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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Computes the effective Ballerina type text of a parameter from its {@code type} {@link
 * TriggerUISchemaModel.Property} tree — the payload-composition algorithm of the phase-6 spec:
 *
 * <pre>
 *   element = codedata.boundType (if set) else codedata.defaultType
 *   base    = codedata.template applied to element   ({{type}} / T -> element)
 *   result  = the highest-precedence active PAYLOAD_MODIFIER sibling's template (value == true,
 *             supersedes base), else base
 * </pre>
 *
 * Handles the widget nesting: a plain {@code TYPE} field yields its value; a {@code FLAG} field
 * (framework caller/context) yields its {@code ballerinaType}; a {@code DATA_BINDING} /
 * {@code COMPLEX_PAYLOAD} field descends to its {@code PAYLOAD_TYPE} child (+ modifier siblings); a
 * {@code VARIATION_SELECTOR} descends to the selected variant's payload. Pure and unit-testable.
 *
 * @since 1.9.0
 */
public final class PayloadComposer {

    private static final String BRACED = "{{type}}";

    private PayloadComposer() {
    }

    /** The emitted Ballerina type of a parameter, from its {@code type} Property. */
    public static String effectiveType(TriggerUISchemaModel.Property typeProp) {
        if (typeProp == null) {
            return "";
        }
        String fieldType = selectedFieldType(typeProp);
        if ("FLAG".equals(fieldType)) {
            // Framework param (caller/context): the type is the widget's ballerinaType.
            String ballerinaType = selectedBallerinaType(typeProp);
            return ballerinaType == null ? "" : ballerinaType;
        }

        Located located = locatePayload(typeProp);
        if (located == null) {
            // Plain TYPE (or anything without a payload node): the field value is the type.
            return stringValue(typeProp.value());
        }

        TriggerUISchemaModel.Codedata cd = located.payload.codedata();
        String element = element(cd);
        // An active modifier (a checked FLAG sibling tagged PAYLOAD_MODIFIER) supersedes the base wrap.
        if (located.siblings != null) {
            for (TriggerUISchemaModel.Property sibling : located.siblings) {
                TriggerUISchemaModel.Codedata sc = sibling.codedata();
                if (sc != null && "PAYLOAD_MODIFIER".equals(sc.type()) && isTrue(sibling.value())
                        && sc.template() != null && !sc.template().isBlank()) {
                    return applyTemplate(sc.template(), element);
                }
            }
        }
        String base = applyTemplate(templateOf(cd), element);
        return base.isEmpty() ? element : base;
    }

    /**
     * The default composition of a parameter's type — element = {@code defaultType} (ignoring any
     * bound type) wrapped by the base template only (ignoring active modifiers). This is the
     * "placeholder" type the UI resets to when the user removes a custom schema.
     */
    public static String defaultComposedType(TriggerUISchemaModel.Property typeProp) {
        Located located = locatePayload(typeProp);
        if (located == null) {
            return effectiveType(typeProp);
        }
        TriggerUISchemaModel.Codedata cd = located.payload.codedata();
        String element = cd == null || cd.defaultType() == null ? "" : cd.defaultType();
        String base = applyTemplate(templateOf(cd), element);
        return base.isEmpty() ? element : base;
    }

    /** The PAYLOAD_TYPE node backing a parameter's type tree (a variant sub-form or the type itself). */
    public static TriggerUISchemaModel.Property payloadNode(TriggerUISchemaModel.Property typeProp) {
        Located located = locatePayload(typeProp);
        return located == null ? null : located.payload;
    }

    /** The base wrap template of the payload backing a type tree (e.g. {@code {{type}}[]}), or empty. */
    public static String payloadTemplate(TriggerUISchemaModel.Property typeProp) {
        Located located = locatePayload(typeProp);
        return located == null ? "" : templateOf(located.payload.codedata());
    }

    /**
     * The non-payload siblings composed alongside the payload (PAYLOAD_MODIFIER flags such as
     * {@code stream}, METADATA_FLAG markers such as {@code rows}), keyed as declared. Empty when the
     * type tree has no payload sub-form.
     */
    public static Map<String, TriggerUISchemaModel.Property> compositionSiblings(
            TriggerUISchemaModel.Property typeProp) {
        if (typeProp == null) {
            return Map.of();
        }
        String fieldType = selectedFieldType(typeProp);
        Map<String, TriggerUISchemaModel.Property> children = typeProp.properties();
        if ("VARIATION_SELECTOR".equals(fieldType) && children != null) {
            TriggerUISchemaModel.Property variant = selectedVariant(typeProp, children);
            return variant == null ? Map.of() : compositionSiblings(variant);
        }
        if (children == null || isPayload(typeProp)) {
            return Map.of();
        }
        Map<String, TriggerUISchemaModel.Property> siblings = new LinkedHashMap<>();
        for (Map.Entry<String, TriggerUISchemaModel.Property> child : children.entrySet()) {
            if (!isPayload(child.getValue())) {
                siblings.put(child.getKey(), child.getValue());
            }
        }
        return siblings;
    }

    // --- navigation ---------------------------------------------------------

    private record Located(TriggerUISchemaModel.Property payload, List<TriggerUISchemaModel.Property> siblings) {
    }

    private static Located locatePayload(TriggerUISchemaModel.Property node) {
        if (node == null) {
            return null;
        }
        if (isPayload(node)) {
            return new Located(node, null);
        }
        String fieldType = selectedFieldType(node);
        Map<String, TriggerUISchemaModel.Property> children = node.properties();
        // VARIATION_SELECTOR: descend into the selected (by value) or enabled variant sub-form.
        if ("VARIATION_SELECTOR".equals(fieldType) && children != null) {
            TriggerUISchemaModel.Property variant = selectedVariant(node, children);
            return variant == null ? null : locatePayload(variant);
        }
        // DATA_BINDING / COMPLEX_PAYLOAD / VARIANT sub-form: the payload is a child; the rest are
        // its modifier siblings.
        if (children != null) {
            TriggerUISchemaModel.Property payload = null;
            for (TriggerUISchemaModel.Property child : children.values()) {
                if (isPayload(child)) {
                    payload = child;
                    break;
                }
            }
            if (payload != null) {
                TriggerUISchemaModel.Property found = payload;
                List<TriggerUISchemaModel.Property> siblings = children.values().stream()
                        .filter(c -> c != found)
                        .toList();
                return new Located(found, siblings);
            }
        }
        return null;
    }

    private static TriggerUISchemaModel.Property selectedVariant(TriggerUISchemaModel.Property selector,
                                                         Map<String, TriggerUISchemaModel.Property> variants) {
        Object value = selector.value();
        if (value != null && variants.containsKey(String.valueOf(value))) {
            return variants.get(String.valueOf(value));
        }
        for (TriggerUISchemaModel.Property variant : variants.values()) {
            if (variant.enabled()) {
                return variant;
            }
        }
        return variants.values().stream().findFirst().orElse(null);
    }

    private static boolean isPayload(TriggerUISchemaModel.Property node) {
        TriggerUISchemaModel.Codedata cd = node == null ? null : node.codedata();
        if (cd == null || cd.type() == null) {
            return false;
        }
        return "PAYLOAD_TYPE".equals(cd.type()) || "PAYLOAD_TYPE_INCLUDED_RECORD".equals(cd.type());
    }

    // --- element / template -------------------------------------------------

    private static String element(TriggerUISchemaModel.Codedata cd) {
        if (cd == null) {
            return "";
        }
        if (cd.boundType() != null && !cd.boundType().isBlank()) {
            return cd.boundType();
        }
        return cd.defaultType() == null ? "" : cd.defaultType();
    }

    /** The base wrap template: {@code codedata.template}, else a {@code modifiers.template} (kafka). */
    private static String templateOf(TriggerUISchemaModel.Codedata cd) {
        if (cd == null) {
            return "";
        }
        if (cd.template() != null && !cd.template().isBlank()) {
            return cd.template();
        }
        if (cd.modifiers() instanceof Map<?, ?> modifiers) {
            Object template = modifiers.get("template");
            if (template != null) {
                return String.valueOf(template);
            }
        }
        return "";
    }

    /** Substitutes the element into a wrap template. Supports both {@code {{type}}} and a standalone {@code T}. */
    private static String applyTemplate(String template, String element) {
        if (template == null || template.isBlank()) {
            return element == null ? "" : element;
        }
        String safe = element == null ? "" : element;
        String result = template.contains(BRACED) ? template.replace(BRACED, safe) : template;
        // Replace a standalone T (word-boundary) used by the included-record form (e.g. "T[]").
        result = result.replaceAll("\\bT\\b", java.util.regex.Matcher.quoteReplacement(safe));
        return result;
    }

    // --- small helpers ------------------------------------------------------

    public static String selectedFieldType(TriggerUISchemaModel.Property property) {
        if (property == null || property.types() == null) {
            return null;
        }
        TriggerUISchemaModel.PropertyType selected = null;
        for (TriggerUISchemaModel.PropertyType type : property.types()) {
            if (type.selected()) {
                selected = type;
                break;
            }
        }
        if (selected == null && !property.types().isEmpty()) {
            selected = property.types().getFirst();
        }
        return selected == null ? null : selected.fieldType();
    }

    private static String selectedBallerinaType(TriggerUISchemaModel.Property property) {
        if (property == null || property.types() == null) {
            return null;
        }
        for (TriggerUISchemaModel.PropertyType type : property.types()) {
            if (type.selected() && type.ballerinaType() != null) {
                return type.ballerinaType();
            }
        }
        for (TriggerUISchemaModel.PropertyType type : property.types()) {
            if (type.ballerinaType() != null) {
                return type.ballerinaType();
            }
        }
        return null;
    }

    private static boolean isTrue(Object value) {
        return Boolean.TRUE.equals(value) || "true".equalsIgnoreCase(String.valueOf(value));
    }

    private static String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }
}
