/*
 *  Copyright (c) 2024, WSO2 LLC. (http://www.wso2.com)
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

package io.ballerina.flowmodelgenerator.extension;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonIOException;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.api.symbols.TypeDescKind;
import io.ballerina.compiler.api.symbols.TypeSymbol;
import io.ballerina.compiler.syntax.tree.MappingConstructorExpressionNode;
import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.compiler.syntax.tree.NonTerminalNode;
import io.ballerina.compiler.syntax.tree.SpecificFieldNode;
import io.ballerina.flowmodelgenerator.core.DeleteNodeHandler;
import io.ballerina.flowmodelgenerator.core.TypesManager;
import io.ballerina.flowmodelgenerator.core.converters.JsonToTypeMapper;
import io.ballerina.flowmodelgenerator.core.model.Codedata;
import io.ballerina.flowmodelgenerator.core.model.PropertyTypeMemberInfo;
import io.ballerina.flowmodelgenerator.core.model.TypeData;
import io.ballerina.flowmodelgenerator.core.type.RecordValueGenerator;
import io.ballerina.flowmodelgenerator.core.type.TypeSymbolAnalyzerFromTypeModel;
import io.ballerina.flowmodelgenerator.core.utils.FileSystemUtils;
import io.ballerina.flowmodelgenerator.extension.request.DeleteTypeRequest;
import io.ballerina.flowmodelgenerator.extension.request.FilePathRequest;
import io.ballerina.flowmodelgenerator.extension.request.FindTypeRequest;
import io.ballerina.flowmodelgenerator.extension.request.GetTypeRequest;
import io.ballerina.flowmodelgenerator.extension.request.JsonToTypeRequest;
import io.ballerina.flowmodelgenerator.extension.request.MultipleTypeUpdateRequest;
import io.ballerina.flowmodelgenerator.extension.request.RecordConfigRequest;
import io.ballerina.flowmodelgenerator.extension.request.RecordValueGenerateRequest;
import io.ballerina.flowmodelgenerator.extension.request.TypeOfExpressionRequest;
import io.ballerina.flowmodelgenerator.extension.request.TypeUpdateRequest;
import io.ballerina.flowmodelgenerator.extension.request.UpdatedRecordConfigRequest;
import io.ballerina.flowmodelgenerator.extension.request.VerifyTypeDeleteRequest;
import io.ballerina.flowmodelgenerator.extension.response.DeleteTypeResponse;
import io.ballerina.flowmodelgenerator.extension.response.MultipleTypeUpdateResponse;
import io.ballerina.flowmodelgenerator.extension.response.RecordConfigResponse;
import io.ballerina.flowmodelgenerator.extension.response.RecordValueGenerateResponse;
import io.ballerina.flowmodelgenerator.extension.response.TypeListResponse;
import io.ballerina.flowmodelgenerator.extension.response.TypeOfExpressionResponse;
import io.ballerina.flowmodelgenerator.extension.response.TypeResponse;
import io.ballerina.flowmodelgenerator.extension.response.TypeUpdateResponse;
import io.ballerina.flowmodelgenerator.extension.response.VerifyTypeDeleteResponse;
import io.ballerina.modelgenerator.commons.CommonUtils;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.projects.Document;
import io.ballerina.projects.ModuleDescriptor;
import io.ballerina.projects.Project;
import io.ballerina.tools.diagnostics.DiagnosticSeverity;
import io.ballerina.tools.diagnostics.Location;
import io.ballerina.tools.text.TextDocument;
import io.ballerina.tools.text.TextRange;
import org.ballerinalang.annotation.JavaSPIService;
import org.ballerinalang.diagramutil.connector.models.connector.Type;
import org.ballerinalang.langserver.common.utils.NameUtil;
import org.ballerinalang.langserver.common.utils.PathUtil;
import org.ballerinalang.langserver.commons.LanguageServerContext;
import org.ballerinalang.langserver.commons.eventsync.exceptions.EventSyncException;
import org.ballerinalang.langserver.commons.service.spi.ExtendedLanguageServerService;
import org.ballerinalang.langserver.commons.workspace.WorkspaceDocumentException;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManager;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManagerProxy;
import org.ballerinalang.util.diagnostic.DiagnosticErrorCode;
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest;
import org.eclipse.lsp4j.jsonrpc.services.JsonSegment;
import org.eclipse.lsp4j.services.LanguageServer;

import java.io.IOException;
import java.io.Writer;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

@JavaSPIService("org.ballerinalang.langserver.commons.service.spi.ExtendedLanguageServerService")
@JsonSegment("typesManager")
public class TypesManagerService implements ExtendedLanguageServerService {

    // A type can be deleted if it has at most one reference (the definition itself).
    public static final int MAX_REFERENCE_FOR_DELETE = 1;
    private static final long MAX_RECORD_CONFIG_JSON_CHARS = 10L * 1024 * 1024;
    private static final String RECORD_CONFIG_ERROR_MESSAGE = "Record config is too large to send. " +
            "The record type has too many nested fields.";
    private WorkspaceManagerProxy workspaceManagerProxy;

    // Cache key for SemanticModel
    private record CacheKey(String org, String packageName, String moduleName, String version) {
    }

    // Cache for SemanticModel instances
    private static final ConcurrentHashMap<CacheKey, SemanticModel> semanticModelCache = new ConcurrentHashMap<>();

    @Override
    public void init(LanguageServer langServer, WorkspaceManagerProxy workspaceManagerProxy,
                     LanguageServerContext serverContext) {
        this.workspaceManagerProxy = workspaceManagerProxy;
    }

    @Override
    public Class<?> getRemoteInterface() {
        return null;
    }

    /**
     * Get all the types in the project with references.
     *
     * @param request {@link FindTypeRequest}
     * @return {@link TypeListResponse} all the types found in the project with references
     */
    @JsonRequest
    public CompletableFuture<TypeListResponse> getTypes(FilePathRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeListResponse response = new TypeListResponse();
            try {
                Path filePath = PathUtil.convertUriStringToPath(request.filePath());
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get(request.filePath());
                workspaceManager.loadProject(filePath);
                Optional<Document> document = workspaceManager.document(filePath);
                Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                if (document.isEmpty() || semanticModel.isEmpty()) {
                    return response;
                }
                TypesManager typesManager = new TypesManager(document.get());
                JsonElement allTypes = typesManager.getAllTypes(semanticModel.get());
                response.setTypes(allTypes);
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Get the type information for a specific line position in a file.
     *
     * @param request {@link GetTypeRequest}
     * @return {@link TypeResponse} the type information for the given line position
     */
    @JsonRequest
    public CompletableFuture<TypeResponse> getType(GetTypeRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeResponse response = new TypeResponse();
            try {
                Path filePath = PathUtil.convertUriStringToPath(request.filePath());
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get(request.filePath());
                workspaceManager.loadProject(filePath);
                Optional<Document> document = workspaceManager.document(filePath);
                Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                if (document.isEmpty() || semanticModel.isEmpty()) {
                    return response;
                }
                TypesManager typesManager = new TypesManager(document.get());
                JsonElement result = typesManager.getType(semanticModel.get(), document.get(), request.linePosition());
                if (result == null) {
                    return response;
                }
                response.setType(result.getAsJsonObject().get("type").getAsJsonObject());
                response.setRefs(result.getAsJsonObject().get("refs").getAsJsonArray());
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    @JsonRequest
    public CompletableFuture<TypeOfExpressionResponse> getTypeOfExpression(TypeOfExpressionRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeOfExpressionResponse response = new TypeOfExpressionResponse();
            try {
                Path filePath = PathUtil.convertUriStringToPath(request.filePath());
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get(request.filePath());
                Project project = workspaceManager.loadProject(filePath);
                Optional<Document> document = workspaceManager.document(filePath);
                Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                if (document.isEmpty() || semanticModel.isEmpty()) {
                    return response;
                }
                Path fileName = filePath.getFileName();
                TypesManager typesManager = new TypesManager(document.get());
                JsonElement result = typesManager.getTypeOfExpression(project,
                        fileName == null ? filePath.toString() : fileName.toString(), document.get(),
                        request.position(), request.expression());
                if (result == null) {
                    return response;
                }
                response.setType(result);
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Get the GraphQL type information for a specific line position in a file.
     *
     * @param request {@link GetTypeRequest}
     * @return {@link TypeResponse} the GraphQL type information for the given line position
     */
    @JsonRequest
    public CompletableFuture<TypeResponse> getGraphqlType(GetTypeRequest request) {
        // TODO: Different implementation may be needed with future requirements
        return CompletableFuture.supplyAsync(() -> {
            TypeResponse response = new TypeResponse();
            try {
                Path filePath = PathUtil.convertUriStringToPath(request.filePath());
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get(request.filePath());
                workspaceManager.loadProject(filePath);
                Optional<Document> document = workspaceManager.document(filePath);
                Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                if (document.isEmpty() || semanticModel.isEmpty()) {
                    return response;
                }
                TypesManager typesManager = new TypesManager(document.get());
                JsonElement result =
                        typesManager.getGraphqlType(semanticModel.get(), document.get(), request.linePosition());
                if (result == null) {
                    return response;
                }
                response.setType(result.getAsJsonObject().get("type").getAsJsonObject());
                response.setRefs(result.getAsJsonObject().get("refs").getAsJsonArray());
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Create a GraphQL class type in the specified file.
     *
     * @param request {@link TypeUpdateRequest}
     * @return {@link TypeUpdateResponse} the response containing the text edits for creating the type
     */
    @JsonRequest
    public CompletableFuture<TypeUpdateResponse> createGraphqlClassType(TypeUpdateRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeUpdateResponse response = new TypeUpdateResponse();
            try {
                Path filePath = Path.of(request.filePath());
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                workspaceManager.loadProject(filePath);
                TypeData typeData = (new Gson()).fromJson(request.type(), TypeData.class);
                Optional<Document> document = workspaceManager.document(filePath);
                if (document.isEmpty()) {
                    return response;
                }
                TypesManager typesManager = new TypesManager(document.get());
                response.setName(typeData.name());
                response.setTextEdits(typesManager.createGraphqlClassType(filePath, typeData));
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Delete a type from the specified file.
     *
     * @param request {@link DeleteTypeRequest}
     * @return {@link DeleteTypeResponse} the response containing the text edits for deleting the type
     */
    @JsonRequest
    public CompletableFuture<DeleteTypeResponse> deleteType(DeleteTypeRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            DeleteTypeResponse response = new DeleteTypeResponse();

            try {
                Path filePath = Path.of(request.filePath());

                // Load project and document
                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                Project project = workspaceManager.loadProject(filePath);
                Optional<SemanticModel> semanticModelOpt = workspaceManager.semanticModel(filePath);
                Optional<Document> documentOpt = workspaceManager.document(filePath);

                if (semanticModelOpt.isEmpty() || documentOpt.isEmpty()) {
                    return response;
                }

                Document document = documentOpt.get();
                TextDocument textDocument = document.textDocument();

                // Compute positions
                int startPos = textDocument.textPositionFrom(request.lineRange().startLine());
                int endPos = textDocument.textPositionFrom(request.lineRange().endLine());

                // Locate node
                NonTerminalNode targetNode = ((ModulePartNode) document.syntaxTree().rootNode())
                        .findNode(TextRange.from(startPos, endPos - startPos));

                // Build JSON in one step by combining maps
                Map<String, Object> component = Map.of(
                        "filePath", filePath.toString(),
                        "startLine", targetNode.lineRange().startLine().line(),
                        "startColumn", targetNode.lineRange().startLine().offset(),
                        "endLine", targetNode.lineRange().endLine().line(),
                        "endColumn", targetNode.lineRange().endLine().offset()
                );

                JsonObject componentJson = new Gson()
                        .toJsonTree(component)
                        .getAsJsonObject();

                response.setTextEdits(DeleteNodeHandler.getTextEditsToDeletedNode(
                        componentJson, filePath, document, project
                ));

            } catch (Throwable e) {
                response.setError(e);
            }
            return response;
        });
    }

    /**
     * Verify if a type can be safely deleted by checking for any references.
     *
     * @param request {@link VerifyTypeDeleteRequest}
     * @return {@link VerifyTypeDeleteResponse} the response indicating whether the type can be deleted
     */
    @JsonRequest
    public CompletableFuture<VerifyTypeDeleteResponse> verifyTypeDelete(VerifyTypeDeleteRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            VerifyTypeDeleteResponse response = new VerifyTypeDeleteResponse();
            try {
                Path filePath = Path.of(request.filePath());

                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                Optional<Document> document = workspaceManager.document(filePath);

                if (semanticModel.isEmpty() || document.isEmpty()) {
                    response.setCanDelete(false);
                    response.setError(new IllegalArgumentException("Semantic model or document not found"));
                    return response;
                }

                List<Location> locations = semanticModel.get()
                        .references(document.get(), request.startPosition());

                boolean canDelete = locations.size() <= MAX_REFERENCE_FOR_DELETE;
                response.setCanDelete(canDelete);
            } catch (Throwable e) {
                response.setError(e);
            }
            return response;
        });
    }

    /**
     * Update an existing type in the specified file.
     *
     * @param request {@link TypeUpdateRequest}
     * @return {@link TypeUpdateResponse} the response containing the text edits for updating the type
     */
    @JsonRequest
    public CompletableFuture<TypeUpdateResponse> updateType(TypeUpdateRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeUpdateResponse response = new TypeUpdateResponse();
            try {
                Path filePath = Path.of(request.filePath());

                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                FileSystemUtils.createFileIfNotExists(workspaceManager, filePath);
                TypeData typeData = (new Gson()).fromJson(request.type(), TypeData.class);
                Document document = FileSystemUtils.getDocument(workspaceManager, filePath);
                TypesManager typesManager = new TypesManager(document);
                response.setName(typeData.name());
                response.setTextEdits(typesManager.updateType(filePath, typeData));
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Create multiple types in the specified file.
     *
     * @param request {@link MultipleTypeUpdateRequest}
     * @return {@link MultipleTypeUpdateResponse} the response containing the text edits for creating multiple types
     */
    @JsonRequest
    public CompletableFuture<MultipleTypeUpdateResponse> updateTypes(MultipleTypeUpdateRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            MultipleTypeUpdateResponse response = new MultipleTypeUpdateResponse();
            try {
                Path filePath = Path.of(request.filePath());

                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                FileSystemUtils.createFileIfNotExists(workspaceManager, filePath);
                Document document = FileSystemUtils.getDocument(workspaceManager, filePath);
                List<TypeData> typeDataList = new ArrayList<>();
                for (JsonElement element : request.types()) {
                    typeDataList.add((new Gson()).fromJson(element, TypeData.class));
                }
                TypesManager typesManager = new TypesManager(document);
                response.setTextEdits(typesManager.createMultipleTypes(filePath, typeDataList));
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    /**
     * Get the record configuration for a specific type.
     *
     * @param request {@link RecordConfigRequest}
     * @return {@link RecordConfigResponse} the record configuration for the specified type
     */
    @JsonRequest
    public CompletableFuture<RecordConfigResponse> recordConfig(RecordConfigRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            RecordConfigResponse response = new RecordConfigResponse();
            try {
                Codedata codedata = request.codedata();
                String orgName = codedata.org();
                String packageName = Objects.isNull(codedata.packageName()) ?
                        codedata.module() : codedata.packageName();
                String moduleName = codedata.module();
                String versionName = codedata.version();
                Path filePath = Path.of(request.filePath());

                Optional<SemanticModel> semanticModel = getCachedSemanticModel(orgName, packageName, moduleName,
                        versionName, filePath);

                if (semanticModel.isEmpty()) {
                    throw new IllegalArgumentException(
                            String.format("Package '%s/%s:%s' not found", orgName, packageName, versionName));
                }
                String[] parts = request.typeConstraint().split(":");
                String typeStr = parts.length > 1 ? parts[1] : parts[0];

                // Get the type symbol
                Optional<Symbol> typeSymbol = semanticModel.get().moduleSymbols().parallelStream()
                        .filter(symbol -> symbol.kind() == SymbolKind.TYPE_DEFINITION &&
                                symbol.nameEquals(typeStr))
                        .findFirst();
                if (typeSymbol.isEmpty()) {
                    throw new IllegalArgumentException(String.format("Type '%s' not found in package '%s/%s:%s'",
                            request.typeConstraint(),
                            orgName,
                            packageName,
                            versionName));
                }
                if (typeSymbol.get() instanceof TypeSymbol tSymbol && tSymbol.typeKind() != TypeDescKind.RECORD) {
                    throw new IllegalArgumentException(
                            String.format("Type '%s' is not a record", request.typeConstraint()));
                }
                Type type = Type.fromSemanticSymbol(typeSymbol.get(), semanticModel.get(), packageName);
                serializeRecordConfig(type, response);
            } catch (OutOfMemoryError oom) {
                response.setError(new RuntimeException(RECORD_CONFIG_ERROR_MESSAGE, oom));
            } catch (Throwable e) {
                response.setError(e);
            }
            return response;
        });
    }

    @JsonRequest
    public CompletableFuture<RecordValueGenerateResponse> generateValue(RecordValueGenerateRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            RecordValueGenerateResponse response = new RecordValueGenerateResponse();
            try {
                JsonObject typeJson = request.type().getAsJsonObject();

                // Need type constraint and codeData to handle the ambiguous type errors
                String typeConstraint = request.typeConstraint();
                if (typeConstraint != null && !typeConstraint.isBlank()) {
                    // Probing is best-effort: an invalid typeConstraint/codedata/filePath must never fail the
                    // request — fall back to the bare value the endpoint would have produced before.
                    try {
                        Path filePath = PathUtil.convertUriStringToPath(request.filePath());
                        WorkspaceManager workspaceManager = this.workspaceManagerProxy.get(request.filePath());
                        Project project = workspaceManager.loadProject(filePath);
                        Optional<Document> document = workspaceManager.document(filePath);
                        Optional<SemanticModel> semanticModel = workspaceManager.semanticModel(filePath);
                        if (document.isPresent() && semanticModel.isPresent()) {
                            applyAmbiguityCasts(project, workspaceManager, filePath, document.get(),
                                    semanticModel.get(), typeConstraint, request.codedata(), typeJson);
                        }
                    } catch (Throwable ignored) {
                        // Best-effort cast probing failed; return the bare value below.
                    }
                }

                response.setRecordValue(RecordValueGenerator.generate(typeJson));
            } catch (Throwable e) {
                response.setError(e);
            }
            return response;
        });
    }

    /**
     * Compile-probes the generated value against {@code typeConstraint} and, if the compiler reports an
     * ambiguous-type error, sets {@code explicitTypeCast} on the exact JSON node the error points at — the
     * top-level value (when {@code typeConstraint} is itself the union) or the selected member of a nested
     * union field. {@code typeJson} is mutated in place (the caller regenerates the value afterwards).
     *
     * <p>This handles a single ambiguous site, which may be at the top level or nested. Multiple coexisting
     * ambiguities are out of scope: when more than one is present the compiler does not surface a usable
     * {@code AMBIGUOUS_TYPES} error, and that case is unlikely for a configuration value.
     *
     * <p>The probe statement {@code <typeConstraint> <name> = <value>;} is appended in memory and reverted
     * afterwards, so the user's project is left untouched.
     *
     * @param project          the loaded project for the file
     * @param workspaceManager the workspace manager owning the document (used to revert the probe edit)
     * @param filePath         the path of the document being probed
     * @param document         the document the value belongs to
     * @param semanticModel    the current semantic model (used to derive a collision-free probe variable name)
     * @param typeConstraint   the type the value is assigned to
     * @param codedata         the node codedata supplying the target type's {@code org}/{@code module} import
     * @param typeJson         the type model whose node receives the {@code explicitTypeCast} property
     */
    private void applyAmbiguityCasts(Project project, WorkspaceManager workspaceManager, Path filePath,
                                     Document document, SemanticModel semanticModel, String typeConstraint,
                                     Codedata codedata, JsonObject typeJson) {
        TextDocument textDocument = document.textDocument();
        String originalContent = String.join(System.lineSeparator(), textDocument.textLines());
        String separator = System.lineSeparator();
        try {
            Set<String> visibleNames = new HashSet<>();
            for (Symbol symbol : semanticModel.moduleSymbols()) {
                symbol.getName().ifPresent(visibleNames::add);
            }
            String varName = NameUtil.generateVariableName(typeConstraint, visibleNames);

            // The probe references the target type's module (e.g. jco:...). If that import is missing the
            // compiler reports an "undefined module" error instead of the ambiguity, so prepend it when needed.
            String importStmt = resolveImportStatement(document, codedata);
            // Everything before the value; the value starts at this offset in the probed document.
            String lhs = importStmt + originalContent + separator + typeConstraint + " " + varName + " = ";
            int valueStartOffset = lhs.length();

            String value = RecordValueGenerator.generate(typeJson);
            String newContent = lhs + value + ";" + separator;
            Document updated = document.modify().withContent(newContent).apply();
            SemanticModel compiled = project.currentPackage().getCompilation()
                    .getSemanticModel(project.currentPackage().getDefaultModule().moduleId());
            ModulePartNode rootNode = updated.syntaxTree().rootNode();

            // Only an ambiguous-type error on the appended value matters; ignore pre-existing file errors.
            // A single such error is expected (outer or nested); cast the node it points at.
            compiled.diagnostics().stream()
                    .filter(d -> d.diagnosticInfo().severity() == DiagnosticSeverity.ERROR)
                    .filter(d -> DiagnosticErrorCode.AMBIGUOUS_TYPES.diagnosticId()
                            .equals(d.diagnosticInfo().code()))
                    .filter(d -> d.location().textRange().startOffset() >= valueStartOffset)
                    .findFirst()
                    .ifPresent(d -> applyCastForDiagnostic(rootNode, d, typeJson, typeConstraint, codedata));
        } finally {
            // Revert the in-memory edit so the user's project is unchanged.
            workspaceManager.document(filePath)
                    .ifPresent(doc -> doc.modify().withContent(originalContent).apply());
        }
    }

    /**
     * Locates the ambiguous mapping for {@code diagnostic} and sets {@code explicitTypeCast} on the
     * corresponding JSON node: the top-level value when the mapping is the variable initializer, or the
     * selected member of the nested union the field path resolves to.
     *
     * @return {@code true} if a (new) cast was applied
     */
    private boolean applyCastForDiagnostic(ModulePartNode rootNode,
                                           io.ballerina.tools.diagnostics.Diagnostic diagnostic,
                                           JsonObject typeJson, String typeConstraint, Codedata codedata) {
        NonTerminalNode node = rootNode.findNode(diagnostic.location().textRange(), true);
        while (node != null && !(node instanceof MappingConstructorExpressionNode)) {
            node = node.parent();
        }
        if (node == null) {
            return false;
        }

        // Build the field path from the ambiguous mapping up to the variable initializer.
        List<String> path = new ArrayList<>();
        NonTerminalNode cur = node.parent();
        while (cur != null) {
            if (cur instanceof SpecificFieldNode specificField) {
                path.add(0, specificField.fieldName().toSourceCode().trim());
            }
            cur = cur.parent();
        }

        if (path.isEmpty()) {
            // The top-level value is ambiguous (typeConstraint is itself the union).
            String cast = resolveCastType(typeConstraint, typeJson, codedata);
            return applyCast(typeJson, cast);
        }

        JsonObject target = navigateToNode(typeJson, path);
        if (target == null || !target.has("typeName") || !"union".equals(target.get("typeName").getAsString())) {
            return false;
        }
        JsonObject member = selectedMember(target);
        if (member == null) {
            return false;
        }
        return applyCast(member, castFromTypeInfo(member, codedata));
    }

    /**
     * Navigates the type model along a field path, stepping through the selected member of any union node
     * encountered, and returns the node the last field name resolves to (or {@code null} if not found).
     */
    private JsonObject navigateToNode(JsonObject root, List<String> path) {
        JsonObject node = root;
        for (String fieldName : path) {
            if (node.has("typeName") && "union".equals(node.get("typeName").getAsString())) {
                node = selectedMember(node);
                if (node == null) {
                    return null;
                }
            }
            JsonObject field = findField(node, fieldName);
            if (field == null) {
                return null;
            }
            node = field;
        }
        return node;
    }

    private JsonObject findField(JsonObject recordNode, String fieldName) {
        if (!recordNode.has("fields") || !recordNode.get("fields").isJsonArray()) {
            return null;
        }
        for (JsonElement field : recordNode.getAsJsonArray("fields")) {
            JsonObject fieldObj = field.getAsJsonObject();
            if (fieldObj.has("name") && fieldName.equals(fieldObj.get("name").getAsString())) {
                return fieldObj;
            }
        }
        return null;
    }

    private JsonObject selectedMember(JsonObject unionNode) {
        if (!unionNode.has("members") || !unionNode.get("members").isJsonArray()) {
            return null;
        }
        for (JsonElement member : unionNode.getAsJsonArray("members")) {
            JsonObject memberObj = member.getAsJsonObject();
            if (memberObj.has("selected") && memberObj.get("selected").getAsBoolean()) {
                return memberObj;
            }
        }
        return null;
    }

    /**
     * Sets {@code explicitTypeCast} on the node. Returns {@code false} if the cast is empty or already set to
     * the same value (so the caller can detect "nothing changed" and stop looping).
     */
    private boolean applyCast(JsonObject node, String cast) {
        if (cast == null || cast.isEmpty()) {
            return false;
        }
        if (node.has("explicitTypeCast") && cast.equals(node.get("explicitTypeCast").getAsString())) {
            return false;
        }
        node.addProperty("explicitTypeCast", cast);
        return true;
    }

    /**
     * Derives a cast type for a nested union member from its {@code typeInfo}: {@code <prefix>:<name>} where
     * the prefix is the last segment of the module name, dropped when the member is in the file's own module
     * (the {@code codedata} module).
     */
    private String castFromTypeInfo(JsonObject member, Codedata codedata) {
        String name = member.has("name") ? member.get("name").getAsString() : null;
        if (member.has("typeInfo") && member.get("typeInfo").isJsonObject()) {
            JsonObject typeInfo = member.getAsJsonObject("typeInfo");
            String typeName = typeInfo.has("name") && !typeInfo.get("name").isJsonNull()
                    ? typeInfo.get("name").getAsString() : name;
            String moduleName = typeInfo.has("moduleName") && !typeInfo.get("moduleName").isJsonNull()
                    ? typeInfo.get("moduleName").getAsString() : null;
            if (typeName != null && moduleName != null && !moduleName.isEmpty()) {
                if (codedata != null && moduleName.equals(codedata.module())) {
                    return typeName;
                }
                String prefix = moduleName.contains(".")
                        ? moduleName.substring(moduleName.lastIndexOf('.') + 1) : moduleName;
                return prefix + ":" + typeName;
            }
            return typeName == null ? "" : typeName;
        }
        return name == null ? "" : name;
    }

    /**
     * Builds the {@code import org/module;} statement required for the probe to resolve the target type's
     * module, using the node codedata as the {@code getSourceCode} flow does ({@code SourceBuilder.acceptImport}).
     * Returns an empty string when the module info is unavailable or the import already exists.
     *
     * @param document the document being probed
     * @param codedata the node codedata carrying {@code org}/{@code module}
     * @return the import statement (terminated with a line separator) or an empty string
     */
    private String resolveImportStatement(Document document, Codedata codedata) {
        if (codedata == null) {
            return "";
        }
        String org = codedata.org();
        String module = codedata.module();
        if (org == null || org.isEmpty() || module == null || module.isEmpty()) {
            return "";
        }
        // Skip when the type lives in the file's own package
        ModuleDescriptor ownDescriptor = document.module().descriptor();
        String ownOrg = ownDescriptor.org().value();
        String ownPackage = ownDescriptor.packageName().value();
        if (org.equals(ownOrg) && (module.equals(ownPackage) || module.startsWith(ownPackage + "."))) {
            return "";
        }
        ModulePartNode rootNode = document.syntaxTree().rootNode();
        if (CommonUtils.importExists(rootNode, org, module)) {
            return "";
        }
        return "import " + CommonUtils.getImportStatement(org, module, module) + ";" + System.lineSeparator();
    }

    /**
     * Resolves the cast type for an ambiguous value by matching the selected record against a member of the
     * target union, preserving the module prefix as written in {@code typeConstraint}. Falls back to the
     * codedata module prefix + record name, and finally to the bare record name.
     *
     * @param typeConstraint the union type the value is assigned to
     * @param typeJson       the selected record type
     * @param codedata       the node codedata supplying the module prefix fallback
     * @return the cast type (e.g. {@code jco:DestinationConfig})
     */
    private String resolveCastType(String typeConstraint, JsonObject typeJson, Codedata codedata) {
        String recordName = typeJson.has("name") ? typeJson.get("name").getAsString() : null;
        if (recordName == null || recordName.isEmpty()) {
            return recordName == null ? "" : recordName;
        }
        for (String member : typeConstraint.split("\\|")) {
            String trimmed = member.trim();
            String simpleName = trimmed.contains(":")
                    ? trimmed.substring(trimmed.lastIndexOf(':') + 1) : trimmed;
            if (simpleName.equals(recordName)) {
                return trimmed;
            }
        }
        if (codedata != null && codedata.module() != null && !codedata.module().isEmpty()) {
            String module = codedata.module();
            String prefix = module.contains(".") ? module.substring(module.lastIndexOf('.') + 1) : module;
            return prefix + ":" + recordName;
        }
        return recordName;
    }

    @JsonRequest
    public CompletableFuture<RecordConfigResponse> updateRecordConfig(UpdatedRecordConfigRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            RecordConfigResponse response = new RecordConfigResponse();
            try {
                FindTypeRequest.TypePackageInfo info = FindTypeRequest.TypePackageInfo.from(request.codedata());
                SemanticModel semanticModel = findSemanticModel(info, request.filePath());
                Optional<Symbol> typeSymbol = findTypeSymbolFromSemanticModel(semanticModel, request.typeConstraint());
                if (typeSymbol.isEmpty()) {
                    throw new IllegalArgumentException(String.format("Type '%s' not found in package '%s/%s:%s'",
                            request.typeConstraint(), info.org(), info.moduleName(), info.version()));
                }
                Type type = TypeSymbolAnalyzerFromTypeModel.analyze(typeSymbol.get(), request.expr(), semanticModel);
                serializeRecordConfig(type, response);
            } catch (Throwable e) {
                response.setError(e);
            }
            semanticModelCache.clear();
            return response;
        });
    }

    /**
     * Find the matching type for the given expression from a list of {@link PropertyTypeMemberInfo}.
     * If found a matching type for the expression, update the matching types value information.
     *
     * @param request {@link FindTypeRequest}
     * @return {@link RecordConfigResponse}
     */
    @JsonRequest
    public CompletableFuture<RecordConfigResponse> findMatchingType(FindTypeRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            RecordConfigResponse response = new RecordConfigResponse();
            try {
                String expression = request.expr();
                for (PropertyTypeMemberInfo memberInfo : request.typeMembers()) {
                    try {
                        FindTypeRequest.TypePackageInfo info = FindTypeRequest.TypePackageInfo
                                .from(memberInfo.packageInfo(), memberInfo.packageName());
                        SemanticModel semanticModel = findSemanticModel(info, request.filePath());
                        Optional<Symbol> typeSymbol = findTypeSymbolFromSemanticModel(semanticModel,
                                memberInfo.type());
                        if (typeSymbol.isEmpty()) {
                            continue;
                        }
                        Type type = TypeSymbolAnalyzerFromTypeModel.analyze(typeSymbol.get(), expression,
                                semanticModel);
                        if (type != null && type.selected) {
                            type.name = memberInfo.type();
                            serializeRecordConfig(type, response);
                            response.setTypeName(memberInfo.type());
                            break;
                        }
                    } catch (OutOfMemoryError oom) {
                        response.setError(new RuntimeException(RECORD_CONFIG_ERROR_MESSAGE, oom));
                        return response;
                    } catch (Throwable ignored) {
                    }
                }
            } catch (Throwable e) {
                response.setError(e);
            }
            semanticModelCache.clear();
            return response;
        });
    }

    /**
     * Convert a JSON string to a Ballerina type.
     *
     * @param request {@link JsonToTypeRequest}
     * @return {@link TypeListResponse} the response containing the converted types
     */
    @JsonRequest
    public CompletableFuture<TypeListResponse> jsonToType(JsonToTypeRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            TypeListResponse response = new TypeListResponse();

            String jsonString = request.jsonString();
            String typeName = request.typeName();
            String prefix = request.prefix();
            boolean asInline = request.asInline();
            boolean allowAdditionalFields = request.allowAdditionalFields();
            boolean isNullAsOptional = request.nullAsOptional();

            try {
                Path filePath = Path.of(request.filePath());

                WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
                FileSystemUtils.createFileIfNotExists(workspaceManager, filePath);

                JsonToTypeMapper jsonToTypeMapper = new JsonToTypeMapper(
                        allowAdditionalFields,
                        asInline,
                        isNullAsOptional,
                        prefix,
                        workspaceManager,
                        filePath
                );
                JsonElement converted = jsonToTypeMapper.convert(jsonString, typeName);
                response.setTypes(converted);
            } catch (Throwable e) {
                throw new RuntimeException(e);
            }
            return response;
        });
    }

    // Utility methods

    private Optional<SemanticModel> getCachedSemanticModel(String org, String packageName, String moduleName,
                                                           String version, Path filePath) {
        String normalizedModuleName = moduleName == null || moduleName.isBlank() ? packageName : moduleName;
        // Check cache with filePath
        CacheKey keyWithPath = new CacheKey(org, packageName, normalizedModuleName, version);
        // Try to load via filePath-specific method

        WorkspaceManager workspaceManager = this.workspaceManagerProxy.get();
        Optional<SemanticModel> model = PackageUtil.getSemanticModelIfMatched(workspaceManager, filePath, org,
                packageName, normalizedModuleName, version);
        if (model.isPresent()) {
            semanticModelCache.put(keyWithPath, model.get());
            return model;
        }

        SemanticModel cachedModel = semanticModelCache.get(keyWithPath);
        if (cachedModel != null) {
            return Optional.of(cachedModel);
        }

        // Fallback to general package lookup
        CacheKey keyWithoutPath = new CacheKey(org, packageName, normalizedModuleName, version);
        cachedModel = semanticModelCache.get(keyWithoutPath);
        if (cachedModel != null) {
            return Optional.of(cachedModel);
        }

        // Check workspace sibling projects (same workspace, different integration)
        try {
            Project project = workspaceManager.loadProject(filePath);
            Optional<SemanticModel> workspaceModel = PackageUtil.getSemanticModelFromWorkspace(
                            project, org, packageName, normalizedModuleName, version)
                    .map(PackageUtil.WorkspacePackageResolution::semanticModel);
            if (workspaceModel.isPresent()) {
                semanticModelCache.put(keyWithoutPath, workspaceModel.get());
                return workspaceModel;
            }
        } catch (WorkspaceDocumentException | EventSyncException e) {
            // Fall through to general package lookup
        }

        ModuleInfo moduleInfo = new ModuleInfo(org, packageName, normalizedModuleName, version);
        model = PackageUtil.getSemanticModel(moduleInfo);
        model.ifPresent(m -> semanticModelCache.put(keyWithoutPath, m));
        return model;
    }

    private SemanticModel findSemanticModel(FindTypeRequest.TypePackageInfo packageInfo, String path) {
        String orgName = packageInfo.org();
        String packageName = packageInfo.packageName();
        String moduleName = packageInfo.moduleName();
        String versionName = packageInfo.version();
        Path filePath = Path.of(path);

        // Retrieve cached or load new semantic model
        Optional<SemanticModel> semanticModel = getCachedSemanticModel(orgName, packageName, moduleName, versionName,
                filePath);
        if (semanticModel.isEmpty()) {
            throw new IllegalArgumentException(
                    String.format("Package '%s/%s:%s' not found", orgName, packageName, versionName)
            );
        }

        return semanticModel.get();
    }

    private Optional<Symbol> findTypeSymbolFromSemanticModel(SemanticModel semanticModel, String typeConstraint) {
        String[] parts = typeConstraint.split(":");
        String type = parts.length > 1 ? parts[1] : parts[0];

        return semanticModel.moduleSymbols().parallelStream()
                .filter(symbol -> symbol.kind() == SymbolKind.TYPE_DEFINITION && symbol.nameEquals(type))
                .findFirst();
    }

    private record PackageNameModulePartName(String packageName, String modulePartName) {

        public static PackageNameModulePartName from(String packageNameStr) {
            String[] parts = packageNameStr.split("\\.");
            if (parts.length > 1) {
                return new PackageNameModulePartName(parts[0], parts[1]);
            } else if (parts.length == 1) {
                return new PackageNameModulePartName(parts[0], null);
            }
            return new PackageNameModulePartName(null, null);
        }
    }

    private void serializeRecordConfig(Type type, RecordConfigResponse response) {
        SizeLimitedWriter writer = new SizeLimitedWriter(MAX_RECORD_CONFIG_JSON_CHARS);
        try {
            new Gson().toJson(type, writer);
            response.setRecordConfig(JsonParser.parseString(writer.getContent()));
        } catch (JsonIOException e) {
            response.setError(new RuntimeException(RECORD_CONFIG_ERROR_MESSAGE));
        }
    }

    /**
     * A Writer that stops Gson serialization as soon as the output would exceed a character limit.
     * Overriding both write methods prevents the default Writer from allocating an intermediate
     * char[] when Gson passes a String segment, so the limit is enforced before any extra allocation.
     * Gson wraps the resulting IOException in JsonIOException, which callers catch to detect the limit.
     */
    private static final class SizeLimitedWriter extends Writer {

        private final StringBuilder sb;
        private final long limit;

        SizeLimitedWriter(long limit) {
            this.sb = new StringBuilder();
            this.limit = limit;
        }

        @Override
        public void write(char[] cbuf, int off, int len) throws IOException {
            if (sb.length() + len > limit) {
                throw new IOException("Record config payload exceeds the size limit");
            }
            sb.append(cbuf, off, len);
        }

        @Override
        public void write(String str, int off, int len) throws IOException {
            if (sb.length() + len > limit) {
                throw new IOException("Record config payload exceeds the size limit");
            }
            sb.append(str, off, off + len);
        }

        @Override
        public void flush() {
        }

        @Override
        public void close() {
        }

        String getContent() {
            return sb.toString();
        }
    }
}
