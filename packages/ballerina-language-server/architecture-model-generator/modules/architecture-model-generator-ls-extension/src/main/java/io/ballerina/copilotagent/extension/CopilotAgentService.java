/*
 *  Copyright (c) 2025, WSO2 LLC. (http://www.wso2.com)
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

package io.ballerina.copilotagent.extension;

import io.ballerina.copilotagent.core.SemanticDiffComputer;
import io.ballerina.copilotagent.core.models.Result;
import io.ballerina.copilotagent.extension.request.EnsureAiBaselineRequest;
import io.ballerina.copilotagent.extension.request.SemanticDiffRequest;
import io.ballerina.copilotagent.extension.response.EnsureAiBaselineResponse;
import io.ballerina.copilotagent.extension.response.SemanticDiffResponse;
import io.ballerina.projects.Project;
import org.ballerinalang.annotation.JavaSPIService;
import org.ballerinalang.langserver.common.utils.PathUtil;
import org.ballerinalang.langserver.commons.LanguageServerContext;
import org.ballerinalang.langserver.commons.service.spi.ExtendedLanguageServerService;
import org.ballerinalang.langserver.commons.workspace.WorkspaceDocumentException;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManager;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManagerProxy;
import org.eclipse.lsp4j.DidChangeTextDocumentParams;
import org.eclipse.lsp4j.DidCloseTextDocumentParams;
import org.eclipse.lsp4j.TextDocumentContentChangeEvent;
import org.eclipse.lsp4j.TextDocumentIdentifier;
import org.eclipse.lsp4j.VersionedTextDocumentIdentifier;
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest;
import org.eclipse.lsp4j.jsonrpc.services.JsonSegment;
import org.eclipse.lsp4j.services.LanguageServer;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

@JavaSPIService("org.ballerinalang.langserver.commons.service.spi.ExtendedLanguageServerService")
@JsonSegment("copilotAgentService")
public class CopilotAgentService implements ExtendedLanguageServerService {

    private WorkspaceManager workspaceManager;
    private WorkspaceManager aiWorkspaceManager;

    @Override
    public void init(LanguageServer langServer,
                     WorkspaceManagerProxy workspaceManagerProxy,
                     LanguageServerContext serverContext) {
        this.workspaceManager = workspaceManagerProxy.get();
        this.aiWorkspaceManager = workspaceManagerProxy.get("ai://file.bal");
    }

    @Override
    public Class<?> getRemoteInterface() {
        return null;
    }

    /**
     * (Re)establishes the ai:// frozen baseline of a package from explicit file contents,
     * atomically from the caller's perspective: any cached ai:// project is evicted, the
     * package is reloaded, and the provided contents are applied before the response
     * resolves. This replaces the fire-and-forget didClose/didOpen notification protocol,
     * whose disk-read timing raced against the caller's first workspace edit.
     */
    @JsonRequest
    public CompletableFuture<EnsureAiBaselineResponse> ensureAiBaseline(EnsureAiBaselineRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            EnsureAiBaselineResponse response = new EnsureAiBaselineResponse();
            try {
                Path projectRoot = PathUtil.convertUriStringToPath(request.projectPath());
                // Evict via the package's Ballerina.toml — a concrete file the project
                // lookup always resolves. Drops the whole cached ai:// project (no-op when
                // absent), so the next document update rebuilds the package from disk
                // before applying content.
                Path evictionAnchor = projectRoot.resolve("Ballerina.toml");
                this.aiWorkspaceManager.didClose(evictionAnchor,
                        new DidCloseTextDocumentParams(new TextDocumentIdentifier(toAiUri(evictionAnchor))));

                List<String> failedFiles = new ArrayList<>();
                int seeded = 0;
                List<EnsureAiBaselineRequest.BaselineFile> files =
                        request.files() == null ? List.of() : request.files();
                for (EnsureAiBaselineRequest.BaselineFile file : files) {
                    Path filePath = projectRoot.resolve(file.filePath());
                    try {
                        // The first change rebuilds the package from disk and the rest update
                        // documents in place — the same batch technique the extension's
                        // restore path uses, minus the cross-process timing dependency.
                        DidChangeTextDocumentParams params = new DidChangeTextDocumentParams(
                                new VersionedTextDocumentIdentifier(toAiUri(filePath), 1),
                                List.of(new TextDocumentContentChangeEvent(
                                        file.content() == null ? "" : file.content())));
                        this.aiWorkspaceManager.didChange(filePath, params);
                        seeded++;
                    } catch (WorkspaceDocumentException | RuntimeException e) {
                        failedFiles.add(file.filePath());
                    }
                }
                if (files.isEmpty()) {
                    // No explicit contents: snapshot the package from disk as it stands now.
                    this.aiWorkspaceManager.loadProject(projectRoot);
                }
                response.setSeededFileCount(seeded);
                response.setFailedFiles(failedFiles);
            } catch (Exception e) {
                response.setError(e);
            }
            return response;
        });
    }

    private static String toAiUri(Path path) {
        return "ai" + path.toUri().toString().substring(4);
    }

    @JsonRequest
    public CompletableFuture<SemanticDiffResponse> getSemanticDiff(SemanticDiffRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            SemanticDiffResponse response = new SemanticDiffResponse();
            Path path = PathUtil.convertUriStringToPath(request.projectPath());
            Project originalProject;
            Project shadowProject;
            try {
                // ai:// holds the frozen pre-generation baseline; file:// is the live, directly-edited project.
                originalProject = this.aiWorkspaceManager.loadProject(path);
                shadowProject = this.workspaceManager.loadProject(path);

                SemanticDiffComputer diffComputer = new SemanticDiffComputer(originalProject, shadowProject);
                Result result = diffComputer.computeSemanticDiffs();
                response.setLoadDesignDiagrams(result.loadDesignDiagrams());
                response.setSemanticDiffs(result.semanticDiffs());
                response.setCompilationError(result.compilationError());
            } catch (Exception e) {
                response.setError(e);
            }
            return response;
        });
    }
}
