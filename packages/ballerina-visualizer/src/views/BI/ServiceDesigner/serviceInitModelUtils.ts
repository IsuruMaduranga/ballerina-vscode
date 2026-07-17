/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { FormField, FormImports, FormValues } from "@wso2/ballerina-side-panel";
import { getPrimaryInputType, Property, PropertyModel, RecordTypeField, ServiceInitModel } from "@wso2/ballerina-core";
import { getImportsForProperty } from "../../../utils/bi";
import { sanitizedHttpPath, normalizeValueToArray } from "./utils";

/**
 * Maps the properties to an array of FormField objects.
 *
 * @param properties The properties to map.
 * @returns An array of FormField objects.
 */
export function mapPropertiesToFormFields(properties: { [key: string]: PropertyModel; }): FormField[] {
    if (!properties) return [];

    return Object.entries(properties).map(([key, property]) => {

        // Determine value for MULTIPLE_SELECT, EXPRESSION_SET, and TEXT_SET
        let value: any = property.value;
        const fieldType = getPrimaryInputType(property.types)?.fieldType;
        if (fieldType === "MULTIPLE_SELECT" || fieldType === "EXPRESSION_SET" || fieldType === "TEXT_SET") {
            if (property.values && property.values.length > 0) {
                value = property.values;
            } else if (property.value) {
                value = [property.value];
            } else if (property.items && property.items.length > 0) {
                value = [property.items[0]];
            } else {
                value = [];
            }
        }

        let items = undefined;
        if (fieldType === "MULTIPLE_SELECT" || fieldType === "SINGLE_SELECT") {
            items = property.items;
        }

        // For SINGLE_SELECT with nested per-option properties, build dynamicFormFields
        // Each key in properties maps to a dropdown option whose inner properties become FormField[]
        let dynamicFormFields: { [key: string]: FormField[] } | undefined = undefined;
        if (fieldType === "SINGLE_SELECT" && property.properties && property.items) {
            dynamicFormFields = {};
            for (const optionKey in property.properties) {
                const optionValue = property.properties[optionKey];
                if (optionValue.properties) {
                    dynamicFormFields[optionKey] = mapPropertiesToFormFields(optionValue.properties);
                } else {
                    dynamicFormFields[optionKey] = [];
                }
            }
        }

        return {
            key,
            label: property?.metadata?.label,
            type: fieldType,
            documentation: property?.metadata?.description || "",
            valueType: getPrimaryInputType(property.types)?.ballerinaType,
            editable: property.editable ?? true,
            enabled: property.enabled ?? true,
            optional: property.optional,
            value,
            types: property.types,
            advanced: property.advanced,
            diagnostics: [],
            items,
            choices: property.choices,
            placeholder: property.placeholder,
            addNewButton: property.addNewButton,
            lineRange: property?.codedata?.lineRange,
            advanceProps: !dynamicFormFields ? mapPropertiesToFormFields(property.properties) : undefined,
            dynamicFormFields,
            groupName: property?.metadata?.groupName,
            groupNo: property?.metadata?.groupNo,
        } as FormField;
    });
}

/**
 * Populate the ServiceInitModel from the form fields.
 *
 * @param formFields The form fields to update.
 * @param model The ServiceInitModel to update.
 * @returns The updated ServiceInitModel.
 */
export function populateServiceInitModelFromFormFields(formFields: FormField[], model: ServiceInitModel): ServiceInitModel {
    if (!model || !model.properties || !formFields) return model;

    formFields.forEach(field => {
        const property = model.properties[field.key];
        if (!property) return;

        const value = field.value;

        // Handle MULTIPLE_SELECT, EXPRESSION_SET, and TEXT_SET types
        if (field.type === "MULTIPLE_SELECT" || field.type === "EXPRESSION_SET" || field.type === "TEXT_SET") {
            property.values = normalizeValueToArray(value);
        } else {
            property.value = value as string;
        }
    });
    return model;
}

/**
 * Recursively collects record type fields from properties and nested choices.
 *
 * @param properties The top-level properties to collect from.
 * @returns The collected record type fields.
 */
export function collectRecordTypeFields(properties: { [key: string]: PropertyModel }): RecordTypeField[] {
    const recordTypeFields: RecordTypeField[] = [];

    // Recursive function to collect record type fields from properties and nested choices
    const collect = (properties: any) => {
        if (!properties) return;

        Object.entries(properties).forEach(([key, property]: [string, any]) => {
            // Check if this property itself is a record type
            const primaryType = getPrimaryInputType(property.types);
            if (primaryType?.typeMembers && primaryType.typeMembers.some((member: any) => member.kind === "RECORD_TYPE")) {
                recordTypeFields.push({
                    key,
                    property: {
                        ...property,
                        metadata: {
                            label: property.metadata?.label || key,
                            description: property.metadata?.description || ''
                        },
                        types: property.types,
                        diagnostics: {
                            hasDiagnostics: property.diagnostics && property.diagnostics.length > 0,
                            diagnostics: property.diagnostics
                        }
                    } as Property,
                    recordTypeMembers: primaryType.typeMembers.filter((member: any) => member.kind === "RECORD_TYPE")
                });
            }

            // If this property has choices, recursively collect from all choice properties
            if (property.choices && property.choices.length > 0) {
                property.choices.forEach((choice: any) => {
                    if (choice.properties) {
                        collect(choice.properties);
                    }
                });
            }

            // If this property is a GROUP_SECTION, recurse into its nested properties
            if (primaryType?.fieldType === "GROUP_SECTION" && property.properties) {
                collect(property.properties);
            }
        });
    };

    // Start collection from top-level properties
    collect(properties);
    return recordTypeFields;
}

/**
 * Recursively processes a property and its nested CHOICE fields
 *
 * @param property The property to process
 * @param data The form data containing all field values
 */
export function processPropertyRecursively(property: PropertyModel, data: FormValues, propertyKey?: string): void {
    // If this property is a CHOICE field, process it
    if (getPrimaryInputType(property.types)?.fieldType === "CHOICE" && property.choices) {
        // Get the selected index from form data if available, otherwise use property.value
        const selectedIndex = propertyKey && data[propertyKey] !== undefined
            ? Number(data[propertyKey])
            : (property.value !== undefined ? Number(property.value) : 0);

        // Update property.value with the current UI selection
        if (propertyKey && data[propertyKey] !== undefined) {
            property.value = data[propertyKey] as string;
        }

        property.choices.forEach((choice, index) => {
            // Disable all choices first
            choice.enabled = false;

            // Enable the selected choice based on form data or property.value
            if (selectedIndex === index) {
                choice.enabled = true;

                // Process all properties in this selected choice
                if (choice.properties) {
                    for (const nestedKey in choice.properties) {
                        const nestedProperty = choice.properties[nestedKey];

                        // Set value from form data if available
                        if (data[nestedKey] !== undefined) {
                            // Handle MULTIPLE_SELECT, EXPRESSION_SET, and TEXT_SET types
                            if (getPrimaryInputType(nestedProperty.types)?.fieldType === "MULTIPLE_SELECT" || getPrimaryInputType(nestedProperty.types)?.fieldType === "EXPRESSION_SET" || getPrimaryInputType(nestedProperty.types)?.fieldType === "TEXT_SET") {
                                const value = data[nestedKey];
                                nestedProperty.values = normalizeValueToArray(value);
                            } else {
                                nestedProperty.value = data[nestedKey] as string;
                            }
                        }

                        // Recursively process this nested property, passing the key
                        processPropertyRecursively(nestedProperty, data, nestedKey);
                    }
                }
            }
        });
    }
    // If this property has nested properties (like CONDITIONAL_FIELDS), process them
    else if (property.properties) {
        for (const nestedKey in property.properties) {
            const nestedProperty = property.properties[nestedKey];

            // Set value from form data if available
            if (data[nestedKey] !== undefined) {
                if (getPrimaryInputType(nestedProperty.types)?.fieldType === "MULTIPLE_SELECT" || getPrimaryInputType(nestedProperty.types)?.fieldType === "EXPRESSION_SET" || getPrimaryInputType(nestedProperty.types)?.fieldType === "TEXT_SET") {
                    const value = data[nestedKey];
                    nestedProperty.values = normalizeValueToArray(value);
                } else {
                    nestedProperty.value = data[nestedKey] as string;
                }
            }

            // Recursively process nested properties, passing the key
            processPropertyRecursively(nestedProperty, data, nestedKey);
        }
    }
}

/**
 * Recursively updates CHOICE field selections in the model
 *
 * @param properties The properties object to search through
 * @param fieldKey The key of the field that changed
 * @param value The new value
 * @returns true if the field was found and updated
 */
export function updateChoiceInModel(properties: { [key: string]: PropertyModel }, fieldKey: string, value: any): boolean {
    // Check if the field exists at this level
    if (properties[fieldKey]) {
        const property = properties[fieldKey];
        if (getPrimaryInputType(property.types)?.fieldType === "CHOICE" && property.choices) {
            property.value = value as string;
            property.choices.forEach((choice, index) => {
                choice.enabled = (Number(value) === index);
            });
            return true;
        }
    }

    // Search in nested choice properties - ONLY search through enabled choices
    for (const key in properties) {
        const property = properties[key];
        if (property.choices) {
            // Only search in the currently enabled choice
            const enabledChoice = property.choices.find(choice => choice.enabled);
            if (enabledChoice?.properties && updateChoiceInModel(enabledChoice.properties, fieldKey, value)) {
                return true;
            }
        }
        // Also check nested properties (for CONDITIONAL_FIELDS, etc.)
        if (property.properties && updateChoiceInModel(property.properties, fieldKey, value)) {
            return true;
        }
    }

    return false;
}

/**
 * Applies submitted form values (including CHOICE/CONDITIONAL_FIELDS selections and
 * per-field imports) onto the form fields, then populates the ServiceInitModel from them.
 *
 * Mutates both `formFields` and `model` in place, mirroring the original submit flow.
 *
 * @param formFields The form fields backing the form.
 * @param model The ServiceInitModel to populate.
 * @param data The submitted form values.
 * @param formImports The imports collected by the form.
 * @returns The populated ServiceInitModel.
 */
export function applyFormValuesToModel(formFields: FormField[], model: ServiceInitModel, data: FormValues, formImports: FormImports): ServiceInitModel {
    formFields.forEach(val => {
        if (val.type === "CHOICE") {
            val.choices.forEach((choice, index) => {
                choice.enabled = false;
                if (data[val.key] === index) {
                    choice.enabled = true;
                    if (choice.properties) {
                        for (const key in choice.properties) {
                            const property = choice.properties[key];
                            if (data[key] !== undefined) {
                                const fieldType = getPrimaryInputType(property.types)?.fieldType;
                                // Handle array types (TEXT_SET, EXPRESSION_SET, MULTIPLE_SELECT)
                                if (fieldType === "MULTIPLE_SELECT" || fieldType === "EXPRESSION_SET" || fieldType === "TEXT_SET") {
                                    property.values = normalizeValueToArray(data[key]);
                                } else {
                                    if (key === "basePath") {
                                        property.value = sanitizedHttpPath(data[key]);
                                    } else {
                                        property.value = data[key];
                                    }
                                }
                            }
                            processPropertyRecursively(property, data, key);
                        }
                    }
                }
            })
        } else if (data[val.key] !== undefined) {
            val.value = data[val.key];
        }

        if (val.type === "CONDITIONAL_FIELDS") {
            val.advanceProps.forEach(subField => {
                const subProperty = model.properties[val.key]?.properties?.[subField.key];
                if (subProperty) {
                    if (data[subField.key] !== undefined) {
                        subProperty.value = data[subField.key];
                    }
                    processPropertyRecursively(subProperty, data, subField.key);
                }
            });
        }

        val.imports = getImportsForProperty(val.key, formImports);
    })
    return populateServiceInitModelFromFormFields(formFields, model);
}
