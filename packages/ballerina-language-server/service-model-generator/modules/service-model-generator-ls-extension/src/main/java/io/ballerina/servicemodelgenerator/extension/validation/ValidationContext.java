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

package io.ballerina.servicemodelgenerator.extension.validation;

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.syntax.tree.NonTerminalNode;
import io.ballerina.projects.Document;
import io.ballerina.projects.Project;
import io.ballerina.tools.text.LineRange;

/**
 * An immutable snapshot of the project context a validation run may consult.
 *
 * <p>{@code common.*} validators are pure and ignore it entirely; {@code ls.*} validators resolve
 * what they need lazily (module symbols, the type system, the enclosing service). Every field is
 * nullable — the engine still runs the pure rules when no project is available, which is what makes
 * the {@code common.*} re-check usable from contexts that have only a model.
 *
 * @param semanticModel the semantic model of the file being edited, or {@code null}
 * @param project       the loaded project, or {@code null}
 * @param document      the document being edited, or {@code null}
 * @param moduleName    the connector module the model belongs to, or {@code null}
 * @param serviceNode   the service declaration the edited node belongs to, or {@code null} — needed
 *                      by the rules that scope uniqueness to a single service
 * @param editedRange   where in the source the construct being edited currently lives, or
 *                      {@code null} when it does not exist yet (an add). This is what lets the
 *                      uniqueness rules tell "collides with something else" from "is itself" —
 *                      without it, editing and re-saving an unrenamed construct reports a collision
 *                      against its own declaration and the save is blocked with no way out.
 * @since 1.8.0
 */
public record ValidationContext(SemanticModel semanticModel, Project project, Document document, String moduleName,
                                NonTerminalNode serviceNode, LineRange editedRange) {

    public ValidationContext(SemanticModel semanticModel, Project project, Document document, String moduleName) {
        this(semanticModel, project, document, moduleName, null, null);
    }

    public ValidationContext(SemanticModel semanticModel, Project project, Document document, String moduleName,
                             NonTerminalNode serviceNode) {
        this(semanticModel, project, document, moduleName, serviceNode, null);
    }

    /** A context with no project information — enough to run every {@code common.*} rule. */
    public static ValidationContext empty() {
        return new ValidationContext(null, null, null, null, null, null);
    }

    public boolean hasSemanticModel() {
        return semanticModel != null;
    }
}
