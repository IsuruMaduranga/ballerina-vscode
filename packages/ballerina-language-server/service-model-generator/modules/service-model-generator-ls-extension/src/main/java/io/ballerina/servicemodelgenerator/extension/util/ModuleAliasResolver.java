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

package io.ballerina.servicemodelgenerator.extension.util;

import io.ballerina.compiler.syntax.tree.ModulePartNode;

import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides the import prefix a connector's own module is referenced under in generated source, and
 * re-qualifies references authored against the module's natural prefix onto it. Needed because the
 * natural (last dot-segment) prefix can collide with a sibling package or an existing import alias.
 *
 * @since 1.9.0
 */
public final class ModuleAliasResolver {

    private ModuleAliasResolver() {
    }

    /** The prefix a module's own model strings are authored with — its last dot-segment. */
    public static String selfPrefix(String moduleName) {
        if (moduleName == null || moduleName.isBlank()) {
            return "";
        }
        int lastDot = moduleName.lastIndexOf('.');
        return lastDot < 0 ? moduleName : moduleName.substring(lastDot + 1);
    }

    /**
     * CamelCase join of a dotted module's segments (e.g. {@code trigger.twilio} &rarr;
     * {@code triggerTwilio}), used as a fallback alias. Returned unchanged if there's no dot.
     */
    public static String defaultAlias(String moduleName) {
        if (moduleName == null || moduleName.isBlank() || !moduleName.contains(".")) {
            return moduleName == null ? "" : moduleName;
        }
        String[] segments = moduleName.split("\\.");
        StringBuilder alias = new StringBuilder(segments[0]);
        for (int i = 1; i < segments.length; i++) {
            String segment = segments[i];
            if (segment.isEmpty()) {
                continue;
            }
            alias.append(Character.toUpperCase(segment.charAt(0))).append(segment.substring(1));
        }
        return alias.toString();
    }

    /**
     * The prefix to emit for {@code org/module} in an actual file: reuses an existing import's prefix
     * verbatim, else the natural prefix if free, else the generated alias, else a numeric suffix
     * ({@code ftp} &rarr; {@code ftp2}).
     *
     * @param overridePrefix a model-pinned prefix to prefer over the computed one; may be null/blank
     */
    public static String resolve(ModulePartNode rootNode, String org, String module, String overridePrefix) {
        if (module == null || module.isBlank()) {
            return "";
        }
        boolean pinned = overridePrefix != null && !overridePrefix.isBlank();
        String preferred = pinned ? overridePrefix : selfPrefix(module);
        if (rootNode == null) {
            return preferred;
        }
        Optional<String> existing = Utils.existingImportPrefix(rootNode, org, module);
        if (existing.isPresent()) {
            return existing.get();
        }
        Set<String> taken = Utils.importedPrefixes(rootNode);
        if (!taken.contains(preferred)) {
            return preferred;
        }
        String base = preferred;
        if (!pinned) {
            String fallback = defaultAlias(module);
            if (!fallback.equals(preferred) && !taken.contains(fallback)) {
                return fallback;
            }
            if (!fallback.equals(preferred)) {
                base = fallback;
            }
        }
        int suffix = 2;
        while (taken.contains(base + suffix)) {
            suffix++;
        }
        return base + suffix;
    }

    /**
     * Re-qualifies a standalone module qualifier ({@code prefix:Type}) from {@code selfPrefix} to
     * {@code emitAlias} (e.g. {@code twilio:Foo} &rarr; {@code triggerTwilio:Foo}), without touching
     * other modules, longer identifiers, or dotted paths. No-op when no aliasing is in effect.
     */
    public static String rewriteSelfPrefix(String text, String selfPrefix, String emitAlias) {
        if (text == null || text.isEmpty() || selfPrefix == null || selfPrefix.isBlank()
                || selfPrefix.equals(emitAlias)) {
            return text == null ? "" : text;
        }
        Pattern qualifier = Pattern.compile("(?<![\\w.])" + Pattern.quote(selfPrefix) + "(?=:)");
        return qualifier.matcher(text).replaceAll(Matcher.quoteReplacement(emitAlias));
    }
}
