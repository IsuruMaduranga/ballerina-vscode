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
 * re-qualifies references authored against the module's natural prefix onto it.
 *
 * <p>A module is imported under its last dot-segment by default, which breaks in two ways:
 * <ul>
 *   <li>a dotted module collides with a same-named sibling package — {@code ballerinax/trigger.twilio}
 *       and {@code ballerinax/twilio} both want {@code twilio}, as do {@code ballerinax/solace.jms}
 *       and {@code ballerina/jms};</li>
 *   <li>even a single-segment module collides when the file has already bound that prefix to something
 *       else, e.g. {@code import ballerina/file as ftp;} shadowing {@code ballerina/ftp}.</li>
 * </ul>
 * Both are resolved the same way: pick a prefix that is actually free in the target file and emit every
 * self-module reference under it.
 *
 * @since 1.9.0
 */
public final class ModuleAliasResolver {

    private ModuleAliasResolver() {
    }

    /**
     * The prefix a module's own model strings are authored with — its last dot-segment. This is the
     * token that {@link #rewriteSelfPrefix} rewrites FROM.
     */
    public static String selfPrefix(String moduleName) {
        if (moduleName == null || moduleName.isBlank()) {
            return "";
        }
        int lastDot = moduleName.lastIndexOf('.');
        return lastDot < 0 ? moduleName : moduleName.substring(lastDot + 1);
    }

    /**
     * The preferred alias for a module, ignoring the target file: a camelCase join of its dot-separated
     * segments ({@code trigger.twilio} &rarr; {@code triggerTwilio}, {@code solace.jms} &rarr;
     * {@code solaceJms}), which cannot collide with the single-segment sibling it would otherwise clash
     * with. A module with no dot is returned unchanged — it is only aliased if the file forces it.
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
     * The prefix to emit for {@code org/module} in the context of an actual file.
     *
     * <p>An import of that module already present wins outright — its prefix is reused verbatim, so
     * added functions and follow-up service blocks agree with the import already in the file (including
     * one the user hand-aliased). Otherwise the module's natural prefix ({@code trigger.github} &rarr;
     * {@code github}) is preferred, so the common case is a plain, unaliased import. The generated alias
     * ({@code triggerGithub}) is only a fallback, tried when the natural prefix is already bound to
     * something else in the file (a same-named sibling package, or an unrelated import claiming it); if
     * even that collides, a numeric suffix disambiguates ({@code ftp} &rarr; {@code ftp2}).
     *
     * @param rootNode       the target file's root node
     * @param org            organization name; blank matches any org
     * @param module         module name
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
        // Reaching here means this module is NOT imported yet, so any prefix already claimed in the file
        // belongs to a different module and would shadow this one.
        Set<String> taken = Utils.importedPrefixes(rootNode);
        if (!taken.contains(preferred)) {
            return preferred;
        }
        String base = preferred;
        if (!pinned) {
            // The natural prefix lost to a real collision — the generated alias is unique to this
            // module's dotted path, so it cannot collide with the sibling package that just claimed it.
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
     * Re-qualifies references to a module in a type expression, mapping the prefix the text was authored
     * with ({@code selfPrefix}) onto the prefix the import is actually bound to ({@code emitAlias}) —
     * e.g. {@code twilio:CallStatusEventWrapper} &rarr; {@code triggerTwilio:CallStatusEventWrapper}.
     *
     * <p>Only a standalone module qualifier is rewritten: the prefix must be followed by {@code :} and
     * must not be preceded by an identifier character or a dot. So it reaches every position a type can
     * occupy in a union, array or nilable expression ({@code int|twilio:Foo[]?}) and an annotation
     * qualifier ({@code @twilio:Config}), while leaving other modules ({@code http:Request}), longer
     * identifiers ({@code mytwilio:Foo}) and dotted module paths untouched. A no-op when no aliasing is
     * in effect.
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
