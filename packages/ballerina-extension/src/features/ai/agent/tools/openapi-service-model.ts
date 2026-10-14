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

/**
 * Prepares the HTTP service init model so the language server generates a service from an OpenAPI
 * spec: the same "Import From OpenAPI Specification" path the service designer takes. Kept apart
 * from connector-generator.ts because that module imports the language client, which cannot be
 * loaded in a unit test.
 */

import type { ServiceInitModel, ValidationResult } from "@wso2/ballerina-core";

const DESIGN_APPROACH = "designApproach";
const SPEC = "spec";
const SERVICE_TYPE_NAME = "serviceTypeName";

/**
 * A service contract type name from the spec title, e.g. "Order Management API" ->
 * "OrderManagementAPIService". The suffix keeps it clear of the record types the spec generates,
 * which the language server rejects as a collision.
 */
export function toServiceTypeName(title: string | undefined): string {
    const words = (title ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    let name = words.map(word => word[0].toUpperCase() + word.slice(1)).join("") || "Api";
    if (/^[0-9]/.test(name)) {
        name = `Api${name}`;
    }
    return name.endsWith("Service") ? name : `${name}Service`;
}

/**
 * Returns a copy of the model with the OpenAPI design approach selected and pointed at the spec.
 * Throws when the model has no such option, which means the language server is too old for it.
 */
export function selectOpenApiDesign(model: ServiceInitModel, specPath: string, typeName: string): ServiceInitModel {
    const result: ServiceInitModel = structuredClone(model);
    const designApproach = result.properties?.[DESIGN_APPROACH];
    const openApiChoice = designApproach?.choices?.find(choice => choice.properties?.[SPEC]);
    if (!designApproach || !openApiChoice) {
        throw new Error("The HTTP service model has no 'Import From OpenAPI Specification' option");
    }
    for (const choice of designApproach.choices) {
        choice.enabled = choice === openApiChoice;
    }
    openApiChoice.properties[SPEC].value = specPath;
    const serviceTypeName = openApiChoice.properties[SERVICE_TYPE_NAME];
    if (serviceTypeName) {
        serviceTypeName.value = typeName;
    }
    return result;
}

/** The messages of the validation results that stop the language server from generating source. */
export function blockingValidationMessages(results: ValidationResult[] | undefined): string[] {
    return (results ?? []).filter(result => result.severity === "ERROR").map(result => result.message);
}
