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

package io.ballerina.modelgenerator.commons.trigger.models;

import java.util.List;

/**
 * A requiredness + legal-shape pair shared by several slots in a {@link TriggerMetadataModel}
 * document that describe a syntactic form rather than a Ballerina type: a service type's own
 * {@code identifier} (the string/path after {@code service}), and a resource-kind handler's
 * {@code path}/{@code fieldName} extras. {@code form} enumerates the legal shapes for the slot, e.g.
 * {@code "basePath"}, {@code "stringLiteral"}, {@code "identifierSegment"}.
 *
 * @param presence {@code "required"} or {@code "optional"}
 * @param form     the legal shapes for this slot; more than one entry means either is syntactically
 *                 valid
 * @since 1.10.0
 */
public record PresenceForm(String presence, List<String> form) {

    public static final String PRESENCE_REQUIRED = "required";
    public static final String PRESENCE_OPTIONAL = "optional";

    public static final String FORM_BASE_PATH = "basePath";
    public static final String FORM_STRING_LITERAL = "stringLiteral";
    public static final String FORM_IDENTIFIER_SEGMENT = "identifierSegment";
}
