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

package io.ballerina.flowmodelgenerator.core.model.node;

import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.Constants;
import io.ballerina.flowmodelgenerator.core.model.Codedata;
import io.ballerina.flowmodelgenerator.core.model.FlowNode;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.utils.FlowNodeUtil;
import io.ballerina.modelgenerator.commons.FunctionData;
import io.ballerina.modelgenerator.commons.FunctionDataBuilder;
import io.ballerina.modelgenerator.commons.ModuleInfo;
import io.ballerina.modelgenerator.commons.PackageUtil;
import io.ballerina.projects.Package;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Represents a function call node.
 *
 * @since 1.0.0
 */
public class FunctionCall extends CallBuilder {

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        FlowNode flowNode = sourceBuilder.flowNode;
        Codedata codedata = flowNode.codedata();
        if (isGetDefaultModelCall(codedata)) {
            sourceBuilder.token().keyword(SyntaxKind.FINAL_KEYWORD);
        }

        String resolvedReturnType = resolveLangLibReturnType(sourceBuilder.workspaceManager,
                sourceBuilder.filePath, flowNode);
        if (resolvedReturnType != null) {
            sourceBuilder.newVariableWithType(resolvedReturnType);
        } else {
            sourceBuilder.newVariableWithInferredType();
        }
        if (FlowNodeUtil.hasCheckKeyFlagSet(flowNode)) {
            sourceBuilder.token().keyword(SyntaxKind.CHECK_KEYWORD);
        }

        if (PackageUtil.isLocalFunction(sourceBuilder.workspaceManager, sourceBuilder.filePath,
                codedata.org(), codedata.module())) {
            return sourceBuilder.token()
                    .name(codedata.symbol())
                    .stepOut()
                    .functionParameters(flowNode,
                            Set.of(Property.VARIABLE_KEY, Property.TYPE_KEY, Property.CHECK_ERROR_KEY, "view"))
                    .textEdit()
                    .acceptImport()
                    .build();
        }

        String module = flowNode.codedata().module();
        String methodCallPrefix = (module != null) ? module.substring(module.lastIndexOf('.') + 1) + ":" : "";
        String methodCall = methodCallPrefix + flowNode.metadata().label();

        return sourceBuilder.token()
                .name(methodCall)
                .stepOut()
                .functionParameters(flowNode, Set.of("variable", "type", "view", "checkError"))
                .textEdit()
                .acceptImportWithVariableType()
                .build();
    }

    private boolean isGetDefaultModelCall(Codedata codedata) {
        return codedata != null && Constants.BALLERINA.equals(codedata.org())
                && Constants.AI.equals(codedata.module()) && Constants.DEFAULT_MODEL_PROVIDER.equals(codedata.symbol());
    }

    @Override
    protected FunctionDataBuilder createFunctionDataBuilder(TemplateContext context, ModuleInfo targetModuleInfo) {
        FunctionDataBuilder functionDataBuilder = super.createFunctionDataBuilder(context, targetModuleInfo);
        Codedata codedata = context.codedata();
        if (codedata == null || !Constants.Ai.BALLERINA_ORG.equals(codedata.org())
                || !Constants.Ai.EVALS_PACKAGE.equals(codedata.packageName())
                || !Constants.Ai.EVALS_VERSION.equals(codedata.version())) {
            return functionDataBuilder;
        }
        // Temporary: ai_evals is distributed only as a locally installed demo Bala. Supply that package directly so
        // the shared function builder does not invoke its normal Central-backed external-module resolver. Remove
        // this along with the other local-repository workarounds once ai_evals is published to Central.
        Package templatePackage = PackageUtil.getModulePackage(PackageUtil.getSampleProject(), codedata.org(),
                        codedata.packageName(), codedata.version(), Constants.Ai.EVALS_REPOSITORY)
                .orElseThrow(() -> new IllegalStateException("Unable to resolve " + codedata.org() + "/"
                        + codedata.packageName() + ":" + codedata.version()
                        + " from the local Ballerina repository. Install the demo bala and retry."));
        return functionDataBuilder.resolvedPackage(templatePackage);
    }

    @Override
    protected NodeKind getFunctionNodeKind() {
        return NodeKind.FUNCTION_CALL;
    }

    @Override
    protected FunctionData.Kind getFunctionResultKind() {
        return FunctionData.Kind.FUNCTION;
    }
}
