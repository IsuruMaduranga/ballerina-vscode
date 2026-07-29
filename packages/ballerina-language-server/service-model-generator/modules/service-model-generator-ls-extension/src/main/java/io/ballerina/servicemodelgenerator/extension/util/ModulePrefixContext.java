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

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The import prefixes one code-generation operation will emit, resolved <b>once</b> against the target
 * file and then reused at every emission site.
 *
 * <p>Connector models author every module reference against a module's <i>natural</i> prefix — its last
 * dot-segment ({@code twilio:CallStatusEventWrapper}, {@code @ftp:FunctionConfig}, {@code cdc:Service}).
 * That prefix is not always what the file can bind the module to: a dotted module collides with its
 * single-segment sibling ({@code ballerinax/trigger.twilio} vs {@code ballerinax/twilio}), and even a
 * plain module collides when the file already bound that prefix elsewhere
 * ({@code import ballerina/file as ftp;}). Resolving this per emission site is what made the listener,
 * descriptor, parameter, and annotation paths each drift out of agreement; a single context keeps them
 * consistent by construction.
 *
 * <p>One operation generally spans <b>several</b> modules — MSSQL CDC references its own {@code mssql}
 * (listener type) and {@code ballerinax/cdc} (service type + annotations) — so this is a map, not a
 * single "self" prefix. Register each module with {@link #prefixFor}, then use {@link #requalify} to map
 * model-authored text onto the resolved prefixes and {@link #pendingImports} to emit the imports the
 * file is still missing.
 *
 * <p>Not thread-safe; build one per operation.
 *
 * @since 1.9.0
 */
public final class ModulePrefixContext {

    /** Prefixes already bound in the file, plus every prefix this context has handed out. */
    private final Set<String> claimed = new HashSet<>();
    /** {@code org/module} -> resolved prefix. */
    private final Map<String, String> byModule = new LinkedHashMap<>();
    /** natural prefix -> resolved prefix, driving {@link #requalify}. */
    private final Map<String, String> naturalToEmitted = new LinkedHashMap<>();
    /** Natural prefixes claimed by more than one registered module, so no longer able to identify one. */
    private final Set<String> ambiguousNaturals = new HashSet<>();
    /** {@code org/module} -> resolved prefix, for modules the file does not import yet. */
    private final Map<String, String> pendingImports = new LinkedHashMap<>();
    private final ModulePartNode rootNode;

    private ModulePrefixContext(ModulePartNode rootNode) {
        this.rootNode = rootNode;
        if (rootNode != null) {
            claimed.addAll(Utils.importedPrefixes(rootNode));
        }
    }

    /** A context bound to the file the edits will be applied to. A null root means "no file knowledge". */
    public static ModulePrefixContext from(ModulePartNode rootNode) {
        return new ModulePrefixContext(rootNode);
    }

    /**
     * The prefix to emit for {@code org/module}, resolved once and cached.
     *
     * <p>An import already in the file wins outright — its prefix is authoritative, so anything this
     * operation emits lines up with what is already there (including a prefix the user hand-edited).
     * Otherwise a free prefix is allocated (the module's natural prefix when free, else its generated
     * alias, else that alias numerically disambiguated against everything already claimed) and recorded
     * in {@link #pendingImports} — see {@link #allocate}.
     *
     * @param org    organization name; blank matches any org
     * @param module module name
     * @return the prefix, or the module itself when it cannot be resolved
     */
    public String prefixFor(String org, String module) {
        if (module == null || module.isBlank()) {
            return "";
        }
        String key = (org == null ? "" : org) + "/" + module;
        String cached = byModule.get(key);
        if (cached != null) {
            return cached;
        }
        String natural = ModuleAliasResolver.selfPrefix(module);
        Optional<String> existing = rootNode == null
                ? Optional.empty() : Utils.existingImportPrefix(rootNode, org, module);
        String resolved;
        if (existing.isPresent()) {
            resolved = existing.get();
        } else {
            resolved = allocate(module);
            pendingImports.put(key, resolved);
        }
        claimed.add(resolved);
        byModule.put(key, resolved);
        // Two distinct modules sharing a natural prefix (ballerina/ftp and ballerina/abc.ftp) make that
        // prefix useless as an identifier; record it so bare-prefix lookups decline to guess.
        String previous = naturalToEmitted.putIfAbsent(natural, resolved);
        if (previous != null && !previous.equals(resolved)) {
            ambiguousNaturals.add(natural);
        }
        return resolved;
    }

    /**
     * A free prefix for a module not yet imported in this file: its natural prefix (last dot-segment)
     * when free, else the generated alias (unique to the dotted path, so it cannot collide with the
     * sibling package that just claimed the natural one), else that alias numerically disambiguated.
     */
    private String allocate(String module) {
        String natural = ModuleAliasResolver.selfPrefix(module);
        if (!claimed.contains(natural)) {
            return natural;
        }
        String fallback = ModuleAliasResolver.defaultAlias(module);
        if (!fallback.equals(natural) && !claimed.contains(fallback)) {
            return fallback;
        }
        String base = fallback.equals(natural) ? natural : fallback;
        int suffix = 2;
        while (claimed.contains(base + suffix)) {
            suffix++;
        }
        return base + suffix;
    }

    /**
     * Maps every registered module's natural prefix in {@code text} onto its resolved prefix, e.g.
     * {@code twilio:CallStatusEventWrapper} &rarr; {@code triggerTwilio:CallStatusEventWrapper}.
     *
     * <p>Only standalone module qualifiers are rewritten: a prefix must be followed by {@code :} and not
     * be preceded by an identifier character or a dot. So this reaches every position a type can occupy
     * in a union, array or nilable expression ({@code int|twilio:Foo[]?}) and an annotation qualifier
     * ({@code @ftp:FunctionConfig}), while leaving unregistered modules ({@code http:Request}), longer
     * identifiers ({@code mytwilio:Foo}), and dotted paths untouched.
     */
    public String requalify(String text) {
        if (text == null || text.isEmpty() || naturalToEmitted.isEmpty()) {
            return text == null ? "" : text;
        }
        List<String> changing = new ArrayList<>();
        for (Map.Entry<String, String> entry : naturalToEmitted.entrySet()) {
            if (!entry.getKey().equals(entry.getValue()) && !entry.getKey().isBlank()
                    && !ambiguousNaturals.contains(entry.getKey())) {
                changing.add(entry.getKey());
            }
        }
        if (changing.isEmpty()) {
            return text;
        }
        StringBuilder alternation = new StringBuilder();
        for (String natural : changing) {
            if (!alternation.isEmpty()) {
                alternation.append('|');
            }
            alternation.append(Pattern.quote(natural));
        }
        Pattern qualifier = Pattern.compile("(?<![\\w.])(" + alternation + ")(?=:)");
        Matcher matcher = qualifier.matcher(text);
        StringBuilder out = new StringBuilder();
        while (matcher.find()) {
            matcher.appendReplacement(out, Matcher.quoteReplacement(naturalToEmitted.get(matcher.group(1))));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    /**
     * The prefix to emit for a qualifier that may or may not carry module identity.
     *
     * <p>When {@code moduleName} is present the module is identified exactly and resolved as such. When
     * it is absent the qualifier is only a bare prefix, which does <b>not</b> identify a module on its
     * own — {@code ballerina/ftp} and {@code ballerina/abc.ftp} both present as {@code ftp} — so it is
     * resolved by natural prefix and left alone if that is ambiguous or unknown.
     */
    public String prefixForQualifier(String org, String moduleName, String qualifier) {
        if (moduleName != null && !moduleName.isBlank()) {
            return prefixFor(org, moduleName);
        }
        return resolveNatural(qualifier);
    }

    /**
     * The resolved prefix for a bare natural prefix, for references that name a module by its prefix
     * alone rather than by {@code org/module} — chiefly {@code codedata.valueQualifier}, which qualifies
     * an enum literal ({@code ftp:FTP}, {@code ftp:DELETE}).
     *
     * <p>A prefix is not a module identity, so this can only answer when exactly one registered module
     * claims it. An unregistered prefix, or one claimed by two registered modules, is returned unchanged:
     * emitting the authored text is recoverable, whereas silently retargeting a reference at the wrong
     * module is not.
     */
    public String resolveNatural(String naturalPrefix) {
        if (naturalPrefix == null || naturalPrefix.isBlank() || ambiguousNaturals.contains(naturalPrefix)) {
            return naturalPrefix;
        }
        return naturalToEmitted.getOrDefault(naturalPrefix, naturalPrefix);
    }

    /**
     * The modules that still need an import statement, as {@code org/module} -> resolved prefix, in
     * registration order. A module the file already imports is absent.
     */
    public Map<String, String> pendingImports() {
        return Map.copyOf(pendingImports);
    }

    /** Whether any registered module resolved to something other than its natural prefix. */
    public boolean hasAliases() {
        return naturalToEmitted.entrySet().stream().anyMatch(e -> !e.getKey().equals(e.getValue()));
    }
}
