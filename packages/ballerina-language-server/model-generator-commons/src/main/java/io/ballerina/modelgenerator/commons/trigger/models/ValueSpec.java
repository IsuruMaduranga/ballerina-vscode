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
 * Requiredness plus legal literal values for a resource handler's {@code accessor}/{@code path} slot.
 * A single {@code "*"} in {@code values} means any value the language accepts.
 *
 * @since 1.10.0
 */
public record ValueSpec(String presence, List<String> values) {

    public static final String PRESENCE_REQUIRED = "required";
    public static final String PRESENCE_OPTIONAL = "optional";
}
