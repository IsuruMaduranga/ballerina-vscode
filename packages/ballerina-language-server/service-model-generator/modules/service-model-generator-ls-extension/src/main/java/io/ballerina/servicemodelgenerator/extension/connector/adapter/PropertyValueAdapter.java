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

import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.MetaData;
import io.ballerina.servicemodelgenerator.extension.model.Option;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.PropertyTypeMemberInfo;
import io.ballerina.servicemodelgenerator.extension.model.ValidationRule;
import io.ballerina.servicemodelgenerator.extension.model.Value;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Recursive converter between the unified TriggerUISchemaModel's {@link TriggerUISchemaModel.Property} tree and the
 * wire {@link Value} tree the Integrator UI edits. The two shapes are structurally aligned; the
 * mapping preserves the fields the schema-driven flows depend on:
 *
 * <ul>
 *   <li><b>codedata roles</b> — {@code type}/{@code field}/{@code optional}
 *       (annotation trees: COMPLEX_FUNCTION_ANNOTATION → MAPPING_FIELD → FIELD_VALUE_CHOICE …) and
 *       {@code template}/{@code defaultType}/{@code boundType}/{@code bindable}/{@code modifier}/
 *       {@code targetParam} (payload composition: PAYLOAD_TYPE / PAYLOAD_MODIFIER / METADATA_FLAG);</li>
 *   <li><b>field types</b> — mapped into the wire enum where a constant exists; open-vocabulary UI
 *       markers with no wire constant fall back to the closest widget (METADATA_FLAG → FLAG) since
 *       their behaviour is driven by {@code codedata.type}, not the widget.</li>
 * </ul>
 *
 * @since 1.9.0
 */
public final class PropertyValueAdapter {

    private PropertyValueAdapter() {
    }

    /** Converts a unified-model property tree into a wire {@link Value} tree. */
    public static Value toValue(TriggerUISchemaModel.Property property) {
        if (property == null) {
            return null;
        }
        Value.ValueBuilder builder = new Value.ValueBuilder()
                .value(property.value())
                .enabled(property.enabled())
                .editable(property.editable())
                .optional(Boolean.TRUE.equals(property.optional()))
                .setAdvanced(Boolean.TRUE.equals(property.advanced()));
        if (property.metadata() != null) {
            builder.setMetadata(new MetaData(property.metadata().label(), property.metadata().description(),
                    property.metadata().notice()));
        }
        if (property.placeholder() != null) {
            builder.setPlaceholder(property.placeholder());
        }
        if (property.types() != null) {
            List<PropertyType> types = new ArrayList<>();
            for (TriggerUISchemaModel.PropertyType type : property.types()) {
                types.add(toPropertyType(type));
            }
            builder.types(types);
        }
        if (property.codedata() != null) {
            builder.setCodedata(toCodedata(property.codedata()));
        }
        if (property.properties() != null) {
            Map<String, Value> children = new LinkedHashMap<>();
            property.properties().forEach((key, child) -> children.put(key, toValue(child)));
            builder.setProperties(children);
        }
        if (property.items() != null) {
            builder.setItems(new ArrayList<>(property.items()));
        }
        // Validations now live on the type members (see toPropertyType); the property-level slot is
        // no longer populated by connector models.
        Value value = builder.build();
        if (property.choices() != null) {
            List<Value> choices = new ArrayList<>();
            for (TriggerUISchemaModel.Property choice : property.choices()) {
                choices.add(toValue(choice));
            }
            value.setChoices(choices);
        }
        return value;
    }

    /** Converts an edited wire {@link Value} tree back into a unified-model property tree. */
    public static TriggerUISchemaModel.Property toProperty(Value value) {
        if (value == null) {
            return null;
        }
        TriggerUISchemaModel.Metadata metadata = value.getMetadata() == null ? null
                : new TriggerUISchemaModel.Metadata(value.getMetadata().label(), value.getMetadata().description(),
                        null, null, null, null, null, null);
        List<TriggerUISchemaModel.PropertyType> types = null;
        if (value.getTypes() != null) {
            types = new ArrayList<>();
            for (PropertyType type : value.getTypes()) {
                types.add(new TriggerUISchemaModel.PropertyType(
                        type.fieldType() == null ? null : type.fieldType().name(),
                        type.selected(), type.ballerinaType(), null,
                        toModelTypeMembers(type.typeMembers()), null, null, null));
            }
        }
        Map<String, TriggerUISchemaModel.Property> children = null;
        if (value.getProperties() != null) {
            children = new LinkedHashMap<>();
            for (Map.Entry<String, Value> child : value.getProperties().entrySet()) {
                children.put(child.getKey(), toProperty(child.getValue()));
            }
        }
        List<TriggerUISchemaModel.Property> choices = null;
        if (value.getChoices() != null) {
            choices = new ArrayList<>();
            for (Value choice : value.getChoices()) {
                choices.add(toProperty(choice));
            }
        }
        return new TriggerUISchemaModel.Property(metadata, value.isEnabled(), value.isEditable(), value.isOptional(),
                value.isAdvanced(), value.getPlaceholder(), leafValue(value), types, null, choices, children,
                toModelCodedata(value.getCodedata()), null);
    }

    private static List<TriggerUISchemaModel.TypeMember> toModelTypeMembers(List<PropertyTypeMemberInfo> typeMembers) {
        if (typeMembers == null) {
            return null;
        }
        List<TriggerUISchemaModel.TypeMember> result = new ArrayList<>();
        for (PropertyTypeMemberInfo member : typeMembers) {
            result.add(new TriggerUISchemaModel.TypeMember(
                    member.type(), member.packageInfo(), member.packageName(),
                    member.kind(), member.selected()));
        }
        return result;
    }

    private static PropertyType toPropertyType(TriggerUISchemaModel.PropertyType type) {
        PropertyType.Builder builder = new PropertyType.Builder()
                .fieldType(wireFieldType(type.fieldType()))
                .selected(type.selected())
                .ballerinaType(type.ballerinaType());
        if (type.options() != null) {
            List<Option> options = new ArrayList<>();
            for (TriggerUISchemaModel.Option option : type.options()) {
                options.add(new Option(option.label(), option.value()));
            }
            builder.options(options);
        }
        if (type.typeMembers() != null) {
            List<PropertyTypeMemberInfo> typeMembers = new ArrayList<>();
            for (TriggerUISchemaModel.TypeMember member : type.typeMembers()) {
                typeMembers.add(new PropertyTypeMemberInfo(
                        member.type(), member.packageInfo(), member.packageName(),
                        member.kind(), Boolean.TRUE.equals(member.selected())));
            }
            builder.typeMembers(typeMembers);
        }
        if (type.validations() != null) {
            builder.validations(toWireValidations(type.validations()));
        }
        return builder.build();
    }

    /** Converts the model's validation rules into their wire form (passed through untouched). */
    private static List<ValidationRule> toWireValidations(List<TriggerUISchemaModel.ValidationRule> modelRules) {
        List<ValidationRule> validations = new ArrayList<>();
        for (TriggerUISchemaModel.ValidationRule rule : modelRules) {
            ValidationRule wireRule = new ValidationRule(rule.rule());
            wireRule.setArgs(rule.args());
            wireRule.setMessage(rule.message());
            wireRule.setSeverity(rule.severity());
            validations.add(wireRule);
        }
        return validations;
    }

    /**
     * Maps an open-vocabulary fieldType string onto the wire enum. METADATA_FLAG (a read-only
     * informational marker with no wire constant) renders as a FLAG checkbox — the UI derives its
     * disabled state from {@code codedata.type}, so the widget downgrade is lossless.
     */
    private static Value.FieldType wireFieldType(String fieldType) {
        if (fieldType == null) {
            return null;
        }
        if ("METADATA_FLAG".equals(fieldType)) {
            return Value.FieldType.FLAG;
        }
        try {
            return Value.FieldType.valueOf(fieldType);
        } catch (IllegalArgumentException e) {
            return Value.FieldType.EXPRESSION;
        }
    }

    private static Codedata toCodedata(TriggerUISchemaModel.Codedata cd) {
        Codedata codedata = new Codedata.Builder()
                .setType(cd.type())
                .setArgType(cd.argType())
                .setOriginalName(cd.originalName())
                .setModuleName(cd.moduleName())
                .setOrgName(cd.orgName())
                .setPackageName(cd.packageName())
                .setPosition(cd.position())
                .setPath(cd.path())
                .setValueQualifier(cd.valueQualifier())
                .build();
        codedata.setTemplate(cd.template());
        codedata.setDefaultType(cd.defaultType());
        codedata.setBoundType(cd.boundType());
        codedata.setBindable(cd.bindable());
        codedata.setModifier(cd.modifier());
        codedata.setTargetParam(cd.targetParam());
        codedata.setField(cd.field());
        codedata.setOptional(cd.optional());
        codedata.setValue(cd.value());
        codedata.setNameEditable(cd.nameEditable());
        return codedata;
    }

    private static TriggerUISchemaModel.Codedata toModelCodedata(Codedata cd) {
        if (cd == null) {
            return null;
        }
        return new TriggerUISchemaModel.Codedata(cd.getType(), cd.getArgType(), cd.getOriginalName(),
                cd.getModuleName(), cd.getOrgName(), cd.getPackageName(), cd.getPosition(), cd.getPath(),
                cd.getDefaultType(), cd.getBoundType(), cd.getBindable(), null, null, cd.getTemplate(),
                cd.getModifier(), null,
                cd.getTargetParam(), null, cd.getField(), cd.getOptional(), cd.getValue(),
                cd.getValueQualifier(), null, null, cd.getNameEditable());
    }

    /**
     * A leaf's value normalized for source generation: string templates typed in the UI (e.g.
     * {@code string `x`}) collapse to their literal form via {@link Value#getValue()}; non-string
     * values (booleans of FLAG/choice state) pass through raw so enable/checked semantics survive.
     */
    private static Object leafValue(Value value) {
        Object raw = value.getValueAsObject();
        if (raw instanceof String) {
            return value.getValue();
        }
        return raw;
    }
}
