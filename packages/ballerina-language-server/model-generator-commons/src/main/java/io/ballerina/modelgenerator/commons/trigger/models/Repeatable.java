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
 * How a schema-driven trigger handler may be added to a service, and how consuming one instance
 * affects the still-addable catalog. Carried on the {@code functions}/{@code schemaFunctions} of a
 * {@link TriggerUISchemaModel} and deserialized by name from the trigger UI schema JSON (e.g.
 * {@code "repeatable": "ONE_OF_GROUP"}); an absent value means {@link #FALSE}.
 *
 * <ul>
 *   <li>{@link #FALSE} — a single instance. Adding it removes only that handler from the catalog.
 *       The default for a plain, once-only handler (e.g. {@code onError}).</li>
 *   <li>{@link #TRUE} — may be added repeatedly; it never leaves the catalog. Pairs with a
 *       name-editable handler so the emitted function names do not collide.</li>
 *   <li>{@link #ONE_OF_GROUP} — mutually exclusive within its {@code group}: adding any one member
 *       removes every sibling of the group from the catalog (e.g. RabbitMQ {@code onMessage} /
 *       {@code onRequest} — the compiler plugin allows exactly one).</li>
 *   <li>{@link #ONE_EACH_PER_GROUP} — each member of the {@code group} may be added once,
 *       independently: adding one removes only that member, its siblings stay addable (e.g. FTP's
 *       per-file-format handlers {@code onFileCsv}/{@code onFileJson}/…).</li>
 *   <li>{@link #LEGACY} — a deprecated variant the schema keeps recognising for backward
 *       compatibility only, never for new development: it is absent from the addable catalog by
 *       default (a service with none of its instances present never offers it), but once the source
 *       already contains one, every NON-{@code LEGACY} schema function is displaced — the legacy
 *       handler and the "modern" catalog are mutually incompatible ways of handling the same surface
 *       (e.g. FTP's {@code onFileChange} vs. its format-specific / delete handlers). Distinct
 *       {@code LEGACY} handlers are independent of <i>each other</i> — consuming one never displaces
 *       another, and once any one of them is present the rest stop being hidden by the "not present
 *       yet" default too (the service is already committed to the legacy surface, so the remaining
 *       legacy options are no longer withheld). Ignores {@code group}.</li>
 * </ul>
 *
 * <p>{@link #ONE_OF_GROUP} and {@link #ONE_EACH_PER_GROUP} are meaningful only for a grouped handler;
 * on a handler with no {@code group} they degrade to {@link #FALSE} (see {@link #effective(String)}).
 *
 * @since 1.9.0
 */
public enum Repeatable {

    FALSE,
    TRUE,
    ONE_OF_GROUP,
    ONE_EACH_PER_GROUP,
    LEGACY;

    /** Null-safe accessor: an absent value is a non-repeatable single handler. */
    public static Repeatable orDefault(Repeatable value) {
        return value == null ? FALSE : value;
    }

    /**
     * This behaviour resolved against the handler's {@code group}: a group-scoped value on an
     * ungrouped handler is meaningless and collapses to {@link #FALSE}.
     */
    public Repeatable effective(String group) {
        if ((this == ONE_OF_GROUP || this == ONE_EACH_PER_GROUP) && (group == null || group.isBlank())) {
            return FALSE;
        }
        return this;
    }

    /** Whether the handler remains addable after an instance has been added. */
    public boolean staysAddable() {
        return this == TRUE;
    }

    /** Whether adding one member consumes (removes) every sibling sharing the group. */
    public boolean isGroupExclusive() {
        return this == ONE_OF_GROUP;
    }

    /**
     * Whether this is a deprecated variant hidden from the addable catalog until the source already
     * contains one, at which point it displaces every OTHER schema function (not just its group).
     */
    public boolean isLegacy() {
        return this == LEGACY;
    }
}
