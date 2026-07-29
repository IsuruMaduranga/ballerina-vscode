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

/**
 * A reference to a Ballerina type from within a {@link TriggerMetadataModel} document — a listener
 * class, a service type, an annotation type, or a parameter/return type. Every such reference across
 * the whole document uses this one shape, so a consumer only needs one resolution rule.
 *
 * <p>{@link #packageInfo} is present only for a <b>cross-module</b> reference (a type that belongs to
 * a different module than the one the {@code trigger-metadata.json} file is scoped to, e.g. a
 * connector's handler reusing {@code ballerina/http}'s {@code Headers}). A bare {@code {"name": ...}}
 * always means "same module as this connector's own types."
 *
 * <p>A slot that may hold either a single type or a union of types (e.g. a handler's {@code returns},
 * or a parameter's {@code type}) is always modeled as {@code List<TypeRef>} at the field level —
 * see {@link TriggerMetadataGson} for how a bare single-object JSON value is normalized into a
 * singleton list. Order matters for a union: the first element is the codegen default when nothing
 * else disambiguates.
 *
 * @param name        the type's simple name, e.g. {@code "Caller"}, {@code "AnydataConsumerRecord[]"},
 *                    {@code "()"} (the expansion of a nilable {@code T?} member)
 * @param packageInfo the originating module's coordinates; {@code null} for a same-module reference
 * @since 1.10.0
 */
public record TypeRef(String name, PackageInfo packageInfo) {

    /**
     * The coordinates of the module a cross-module {@link TypeRef} originates from.
     *
     * @param org         the organization, e.g. {@code "ballerina"}
     * @param packageName the package name, e.g. {@code "http"}
     * @param moduleName  the module name, e.g. {@code "http"}
     * @param version     the package version, e.g. {@code "2.16.5"}
     */
    public record PackageInfo(String org, String packageName, String moduleName, String version) {
    }
}
