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

import io.ballerina.projects.DependencyManifest;
import io.ballerina.projects.Package;
import io.ballerina.projects.PackageManifest;
import io.ballerina.projects.PackageName;
import io.ballerina.projects.PackageOrg;
import io.ballerina.projects.PackageResolution;
import io.ballerina.projects.Project;
import io.ballerina.projects.ResolvedPackageDependency;

import java.util.Optional;

/**
 * Resolves which version of a connector a schema-driven flow should be modelled against, so a
 * version-gated {@link ConnectorModelReader} variant can be selected.
 *
 * <p>Needed only on the <b>add</b> path. Reading an existing service already knows the exact version
 * from the source's {@code ModuleID}; adding one does not, and the version the client requested (from
 * the trigger picker, typically the newest on Central) is not necessarily the version that will
 * compile: if the project already depends on the connector, its resolved version wins regardless of
 * what was requested. Modelling the newest there would emit source against types the project's version
 * does not have.
 *
 * @since 1.9.0
 */
public final class ConnectorVersionResolver {

    private ConnectorVersionResolver() {
    }

    /**
     * The version to model {@code orgName/packageName} against: the version the project already
     * resolves for it, else {@code requestedVersion}, else {@code null} (leaving the caller on the
     * newest variant).
     */
    public static String resolve(Project project, String orgName, String packageName, String requestedVersion) {
        String resolved = resolvedProjectVersion(project, orgName, packageName);
        return resolved != null ? resolved : requestedVersion;
    }

    /**
     * The version of {@code orgName/packageName} this project resolves, or {@code null} when it does
     * not depend on it at all. Any failure degrades to {@code null} rather than propagating: the caller
     * then falls back to the requested version.
     *
     * <p>Three sources, in descending authority:
     * <ol>
     *   <li><b>{@code Dependencies.toml}</b> — the locked result of a previous resolution, and what the
     *       compiler will reuse: the language server turns {@code sticky} on whenever this file exists.
     *       A keyed lookup, and reading it costs nothing but a parsed manifest.</li>
     *   <li><b>{@code Ballerina.toml}'s {@code [[dependency]]}</b> — the user's explicit pin. This has
     *       to be consulted before the graph, because the graph cannot be trusted to reflect it: the
     *       language server resolves <b>offline</b> by default
     *       ({@code CommonUtil.COMPILE_OFFLINE} defaults to {@code true}), so when the pinned version
     *       is not in the local bala cache, resolution silently substitutes the newest version that
     *       <i>is</i> cached and the graph reports that instead — the exact case of a project pinned to
     *       an older release that has never been built.</li>
     *   <li><b>The resolved dependency graph</b> — the in-memory truth when nothing is pinned or
     *       locked (there, a substitution genuinely is what the compiler will use). Its API exposes
     *       nodes as a plain collection, so it has to be scanned, and reaching it forces resolution.
     *       Hence last.</li>
     * </ol>
     */
    private static String resolvedProjectVersion(Project project, String orgName, String packageName) {
        if (project == null || orgName == null || packageName == null) {
            return null;
        }
        try {
            Package currentPackage = project.currentPackage();
            DependencyManifest dependencyManifest = currentPackage.dependencyManifest();
            if (dependencyManifest != null) {
                Optional<String> locked = dependencyManifest
                        .dependency(PackageOrg.from(orgName), PackageName.from(packageName))
                        .map(dependency -> dependency.version().value().toString());
                if (locked.isPresent()) {
                    return locked.get();
                }
            }
            String pinned = fromPackageManifest(currentPackage, orgName, packageName);
            return pinned != null ? pinned : fromDependencyGraph(currentPackage, orgName, packageName);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The version declared for the package by a {@code Ballerina.toml} {@code [[dependency]]} entry. */
    private static String fromPackageManifest(Package currentPackage, String orgName, String packageName) {
        PackageManifest manifest = currentPackage.manifest();
        if (manifest == null || manifest.dependencies() == null) {
            return null;
        }
        for (PackageManifest.Dependency dependency : manifest.dependencies()) {
            if (orgName.equals(dependency.org().value()) && packageName.equals(dependency.name().value())
                    && dependency.version() != null) {
                return dependency.version().value().toString();
            }
        }
        return null;
    }

    private static String fromDependencyGraph(Package currentPackage, String orgName, String packageName) {
        PackageResolution resolution = currentPackage.getResolution();
        if (resolution == null || resolution.dependencyGraph() == null) {
            return null;
        }
        for (ResolvedPackageDependency dependency : resolution.dependencyGraph().getNodes()) {
            Package dependencyPackage = dependency.packageInstance();
            if (dependencyPackage == null) {
                continue;
            }
            if (orgName.equals(dependencyPackage.packageOrg().value())
                    && packageName.equals(dependencyPackage.packageName().value())) {
                return dependencyPackage.packageVersion().value().toString();
            }
        }
        return null;
    }
}
