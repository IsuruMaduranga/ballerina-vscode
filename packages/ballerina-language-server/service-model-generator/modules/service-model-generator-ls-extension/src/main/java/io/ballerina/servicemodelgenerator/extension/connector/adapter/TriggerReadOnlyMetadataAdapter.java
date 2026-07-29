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

import io.ballerina.compiler.syntax.tree.ServiceDeclarationNode;
import io.ballerina.modelgenerator.commons.ReadOnlyMetaData;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.extractor.AnnotationExtractor;
import io.ballerina.servicemodelgenerator.extension.extractor.ListenerParamExtractor;
import io.ballerina.servicemodelgenerator.extension.extractor.ServiceDescriptionExtractor;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.Service;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.model.context.ModelFromSourceContext;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds the schema-driven service model's {@code readOnlyMetadata} property — the read-only summary
 * chips ("Monitored Path", "Queue Name", ...) the designer renders in the service-card header, resolved
 * from the user's source.
 *
 * <p>The chip definitions ship in the unified {@link TriggerUISchemaModel}'s {@code readOnlyMetadata} list
 * ({@code key}/{@code displayName}/{@code kind}/{@code path}); this resolves each one's value(s) from
 * the service declaration and packs them into a {@code READONLY} {@link Value} whose {@code value} is a
 * map of {@code displayName -> resolved values}, matching the DB-backed builders'
 * {@link io.ballerina.servicemodelgenerator.extension.util.ServiceModelUtils#getReadonlyMetadata} shape.
 * Resolution is delegated to the shared extractors:
 * <ul>
 *   <li>{@code SERVICE_ANNOTATION} &rarr; {@link AnnotationExtractor} (the {@code path}'s trailing field,
 *       e.g. {@code ServiceConfig.path} &rarr; {@code path});</li>
 *   <li>{@code LISTENER_PARAM} &rarr; {@link ListenerParamExtractor} (the listener constructor argument
 *       named {@code key});</li>
 *   <li>{@code STRING_LITERAL} &rarr; the service's string-literal attach point;</li>
 *   <li>{@code SERVICE_DESCRIPTION} / {@code SERVICE_BASE_PATH} &rarr; {@link ServiceDescriptionExtractor}
 *       (e.g. Salesforce's {@code serviceType} off the service's type descriptor, {@code basePath} off
 *       its attach point/base path — {@code service <type> <basePath> on ...}).</li>
 * </ul>
 *
 * A definition whose value cannot be resolved simply contributes no values (its display name stays with
 * an empty array); unknown kinds are skipped.
 *
 * @since 1.9.0
 */
public final class TriggerReadOnlyMetadataAdapter {

    private static final String KIND_SERVICE_ANNOTATION = "SERVICE_ANNOTATION";
    private static final String KIND_LISTENER_PARAM = "LISTENER_PARAM";
    private static final String KIND_STRING_LITERAL = "STRING_LITERAL";
    private static final String KIND_SERVICE_DESCRIPTION = "SERVICE_DESCRIPTION";
    private static final String KIND_SERVICE_BASE_PATH = "SERVICE_BASE_PATH";

    // Wire kinds understood by the shared extractors (differ from the trigger-model JSON kinds above).
    private static final String EXTRACTOR_KIND_ANNOTATION = "ANNOTATION";
    private static final String EXTRACTOR_KIND_LISTENER_PARAM = "LISTENER_PARAM";
    private static final String EXTRACTOR_KIND_SERVICE_DESCRIPTION = "SERVICE_DESCRIPTION";

    private static final String READONLY = "READONLY";
    private static final String PLACEHOLDER_FALSE = "false";

    private TriggerReadOnlyMetadataAdapter() {
    }

    /**
     * Builds the {@code readOnlyMetadata} wire {@link Value} from the trigger model's chip definitions,
     * resolving each chip's value(s) from the source. Returns {@code null} when the model ships no
     * definitions, so callers can leave the property off entirely.
     */
    public static Value build(List<TriggerUISchemaModel.ReadOnlyMetadata> definitions, Service serviceModel,
                              ServiceDeclarationNode serviceNode, ModelFromSourceContext context) {
        if (definitions == null || definitions.isEmpty()) {
            return null;
        }

        // LinkedHashMap: preserve the model's declaration order; aggregate values sharing a display name
        // (e.g. the two "Queue Name" definitions RabbitMQ ships) under a single chip.
        Map<String, List<String>> resolved = new LinkedHashMap<>();
        for (TriggerUISchemaModel.ReadOnlyMetadata definition : definitions) {
            if (definition == null) {
                continue;
            }
            String displayName = displayNameOf(definition);
            List<String> bucket = resolved.computeIfAbsent(displayName, key -> new ArrayList<>());
            bucket.addAll(resolveValues(definition, serviceModel, serviceNode, context));
        }

        return new Value.ValueBuilder()
                .setCodedata(new Codedata(READONLY))
                .value(resolved)
                .types(List.of(PropertyType.types(Value.FieldType.SINGLE_SELECT)))
                .setPlaceholder(PLACEHOLDER_FALSE)
                .optional(false)
                .setAdvanced(false)
                .enabled(true)
                .editable(true)
                .build();
    }

    private static List<String> resolveValues(TriggerUISchemaModel.ReadOnlyMetadata definition, Service serviceModel,
                                               ServiceDeclarationNode serviceNode, ModelFromSourceContext context) {
        String kind = definition.kind() == null ? "" : definition.kind();
        String displayName = displayNameOf(definition);
        return switch (kind) {
            case KIND_SERVICE_ANNOTATION -> flatten(new AnnotationExtractor().extractValues(
                    new ReadOnlyMetaData(annotationField(definition), displayName, EXTRACTOR_KIND_ANNOTATION),
                    serviceNode, context));
            case KIND_LISTENER_PARAM -> flatten(new ListenerParamExtractor().extractValues(
                    new ReadOnlyMetaData(definition.key(), displayName, EXTRACTOR_KIND_LISTENER_PARAM),
                    serviceNode, context));
            case KIND_STRING_LITERAL -> stringLiteralValue(serviceModel);
            case KIND_SERVICE_DESCRIPTION, KIND_SERVICE_BASE_PATH -> flatten(new ServiceDescriptionExtractor()
                    .extractValues(new ReadOnlyMetaData(definition.key(), displayName,
                            EXTRACTOR_KIND_SERVICE_DESCRIPTION), serviceNode, context));
            default -> List.of();
        };
    }

    /**
     * The annotation field the value lives in: the trailing segment of {@code path} (e.g.
     * {@code ServiceConfig.path} &rarr; {@code path}) when present, otherwise the definition {@code key}.
     */
    private static String annotationField(TriggerUISchemaModel.ReadOnlyMetadata definition) {
        String path = definition.path();
        if (path != null && !path.isBlank()) {
            int lastDot = path.lastIndexOf('.');
            return lastDot >= 0 ? path.substring(lastDot + 1) : path;
        }
        return definition.key();
    }

    private static List<String> stringLiteralValue(Service serviceModel) {
        Value stringLiteral = serviceModel.getStringLiteralProperty();
        if (stringLiteral == null) {
            return List.of();
        }
        String value = stringLiteral.getValue();
        if (value == null || value.isBlank()) {
            return List.of();
        }
        value = unquote(value.trim());
        return value.isEmpty() ? List.of() : List.of(value);
    }

    private static String unquote(String value) {
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    private static String displayNameOf(TriggerUISchemaModel.ReadOnlyMetadata definition) {
        String displayName = definition.displayName();
        return displayName != null && !displayName.isBlank() ? displayName : definition.key();
    }

    private static List<String> flatten(Map<String, List<String>> extracted) {
        List<String> values = new ArrayList<>();
        extracted.values().forEach(values::addAll);
        return values;
    }
}
