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
 * A Ballerina type reference.
 *
 * @param name           a plain type name; mutually exclusive with {@code shape}
 * @param packageInfo    cross-module origin; {@code null} for same-module
 * @param shape          {@link #SHAPE_ARRAY} or {@link #SHAPE_STREAM}; {@code null} for a named type
 * @param elementType    the array element or stream value type
 * @param completionType what a stream terminates with; stream-only, optional
 * @since 1.10.0
 */
public record TypeRef(String name, PackageInfo packageInfo, String shape, List<TypeRef> elementType,
                      List<TypeRef> completionType) {

    /** {@code T[]}. */
    public static final String SHAPE_ARRAY = "array";
    /** {@code stream<T>} or {@code stream<T, C>}. */
    public static final String SHAPE_STREAM = "stream";

    public TypeRef(String name, PackageInfo packageInfo) {
        this(name, packageInfo, null, null, null);
    }

    public boolean isNamed() {
        return shape == null;
    }

    public record PackageInfo(String org, String packageName, String moduleName, String version) {
    }
}
