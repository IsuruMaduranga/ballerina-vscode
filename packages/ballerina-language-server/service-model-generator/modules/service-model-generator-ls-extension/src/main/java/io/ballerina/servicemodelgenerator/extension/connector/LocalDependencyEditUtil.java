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

package io.ballerina.servicemodelgenerator.extension.connector;

import io.ballerina.projects.BallerinaToml;
import io.ballerina.projects.Package;
import io.ballerina.projects.PackageManifest;
import io.ballerina.projects.Project;
import io.ballerina.projects.util.ProjectConstants;
import io.ballerina.toml.syntax.tree.DocumentNode;
import io.ballerina.toml.syntax.tree.SyntaxKind;
import io.ballerina.toml.syntax.tree.TableNode;
import org.ballerinalang.langserver.commons.toml.common.TomlSyntaxTreeUtil;
import org.eclipse.lsp4j.Position;
import org.eclipse.lsp4j.Range;
import org.eclipse.lsp4j.TextEdit;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Bundles a {@code Ballerina.toml} {@code [[dependency]] ... repository = "local"} edit alongside the
 * generated source for a connector picked from a Ballerina local-repository search result. Unlike Central
 * (where an import alone auto-resolves without any {@code Ballerina.toml} entry), a local-repository
 * import does <b>not</b> auto-resolve without an explicit {@code repository = "local"} entry -- confirmed
 * by {@code AddModuleToBallerinaTomlCodeAction} existing specifically as a user-triggered
 * {@code MODULE_NOT_FOUND} quick-fix for exactly this case. Bundling the edit proactively here means the
 * generated code compiles immediately, without ever surfacing that diagnostic to the user.
 *
 * <p>Both edits (source + toml) are returned together in one response for the client to apply
 * atomically, rather than writing {@code Ballerina.toml} directly server-side -- the same pattern
 * {@code AddModuleToBallerinaTomlCodeAction} already uses (a {@code TextEdit} the client applies), which
 * sidesteps any question of whether the LS's in-memory project has noticed the change yet: both land in
 * the same edit set, and the normal recompile-on-save cycle picks up both at once.
 *
 * @since 1.10.0
 */
public final class LocalDependencyEditUtil {

    private LocalDependencyEditUtil() {
    }

    /**
     * Adds a {@code [[dependency]]} edit for {@code org/name} at {@code version} to {@code edits}
     * (keyed by {@code Ballerina.toml}'s path, alongside the caller's source edits), unless the project
     * already declares a {@code [[dependency]]} for that org/name -- re-adding the same local connector
     * must not produce a duplicate stanza. A missing project/Ballerina.toml is a silent no-op: the
     * connector's schema still resolved and source was still generated, this is strictly an
     * additional convenience the caller can proceed without.
     */
    public static void addIfMissing(Map<String, List<TextEdit>> edits, Project project, String org, String name,
                                    String version) {
        if (project == null || org == null || name == null || version == null) {
            return;
        }
        Package currentPackage = project.currentPackage();
        if (alreadyDeclared(currentPackage.manifest(), org, name)) {
            return;
        }
        Optional<BallerinaToml> toml = currentPackage.ballerinaToml();
        if (toml.isEmpty()) {
            return;
        }
        TextEdit tomlEdit = createLocalDependencyEdit(toml.get(), org, name, version);
        String tomlPath = project.sourceRoot().resolve(ProjectConstants.BALLERINA_TOML).toString();
        edits.computeIfAbsent(tomlPath, ignored -> new ArrayList<>()).add(tomlEdit);
    }

    private static boolean alreadyDeclared(PackageManifest manifest, String org, String name) {
        if (manifest == null || manifest.dependencies() == null) {
            return false;
        }
        for (PackageManifest.Dependency dependency : manifest.dependencies()) {
            if (org.equals(dependency.org().value()) && name.equals(dependency.name().value())) {
                return true;
            }
        }
        return false;
    }

    /**
     * A {@link TextEdit} inserting a {@code [[dependency]]} block (with {@code repository = "local"})
     * right after the {@code [package]} table -- the same position and format
     * {@code AddModuleToBallerinaTomlCodeAction} (langserver-core) already uses for its quick-fix, kept as
     * an independent copy here rather than a shared util so this module has no source dependency on that
     * one.
     */
    private static TextEdit createLocalDependencyEdit(BallerinaToml toml, String org, String name, String version) {
        Position dependencyStart = new Position(getDependencyStartLine(toml), 0);
        String dependency = String.format("[[dependency]]%norg = \"%s\"%nname = \"%s\"%nversion = "
                + "\"%s\"%nrepository = \"local\"%n%n", org, name, version);
        return new TextEdit(new Range(dependencyStart, dependencyStart), dependency);
    }

    private static int getDependencyStartLine(BallerinaToml toml) {
        DocumentNode tomlSyntaxTree = toml.tomlDocument().syntaxTree().rootNode();
        return tomlSyntaxTree.members().stream()
                .filter(member -> member.kind().equals(SyntaxKind.TABLE)
                        && TomlSyntaxTreeUtil.toQualifiedName(((TableNode) member).identifier().value())
                                .equals("package"))
                .findFirst()
                .map(member -> member.lineRange().endLine().line() + 2)
                .orElse(0);
    }
}
