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

package io.ballerina.servicemodelgenerator.extension.validation.rules;

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.ModuleSymbol;
import io.ballerina.compiler.api.symbols.Qualifier;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.TypeDefinitionSymbol;
import io.ballerina.compiler.api.symbols.TypeSymbol;
import io.ballerina.compiler.api.symbols.VariableSymbol;
import io.ballerina.compiler.syntax.tree.FunctionDefinitionNode;
import io.ballerina.compiler.syntax.tree.Node;
import io.ballerina.compiler.syntax.tree.ServiceDeclarationNode;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.validation.ValidationContext;
import io.ballerina.tools.text.LineRange;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Project-context validators — the {@code ls.*} namespace. Unlike {@code common.*} these consult the
 * semantic model, so they only run on the language server.
 *
 * <p>Every validator here <b>fails closed toward passing</b>: when the context it needs is absent
 * (no semantic model, no enclosing service) or the value is a shape it cannot judge confidently, it
 * returns empty rather than guessing. A validator that wrongly blocks generation is worse than one
 * that is silent — the user cannot work around a false error, and the {@code common.*} pass plus the
 * compiler still cover the value.
 *
 * @since 1.8.0
 */
public final class LsRuleValidators {

    private LsRuleValidators() {
    }

    /**
     * A type expression this module is willing to resolve by name: an optionally module-qualified
     * identifier with an optional array suffix (`Order`, `kafka:Error`, `Order[]`). Anything richer
     * — generics, unions, records, tuples — needs a real compile to resolve, so those are skipped
     * rather than reported as invalid.
     */
    /**
     * Resolved once: {@link CommonRuleValidators#validators()} builds a fresh map of every validator
     * on each call, and this runs per node on a per-keystroke path.
     */
    private static final RuleValidator COMMON_IDENTIFIER =
            CommonRuleValidators.validators().get("common.validate.identifier");

    private static final Pattern SIMPLE_TYPE_PATTERN =
            Pattern.compile("^([a-zA-Z_][a-zA-Z0-9_]*:)?[a-zA-Z_][a-zA-Z0-9_]*(\\[])?$");

    /** Every {@code ls.*} rule this server implements, keyed by id. */
    public static Map<String, RuleValidator> validators() {
        Map<String, RuleValidator> validators = new LinkedHashMap<>();
        validators.put("ls.validate.unique.listener.name", LsRuleValidators::uniqueListenerName);
        validators.put("ls.validate.unique.function.name", LsRuleValidators::uniqueFunctionName);
        validators.put("ls.validate.listener.compatible", LsRuleValidators::listenerCompatible);
        validators.put("ls.validate.identifier", (node, args, ctx) -> identifier(node));
        validators.put("ls.validate.valid.type", LsRuleValidators::validType);
        validators.put("ls.validate.subtype", LsRuleValidators::subtype);
        // Deliberately absent: `ls.validate.unique.service.name` and `ls.validate.expression`.
        // Both need machinery this package does not have yet (service-attachment comparison and a
        // synthetic-snippet compile). An unregistered id is skipped by the engine, which is the
        // documented degradation — better than a half-right check that blocks valid models.
        return validators;
    }

    /**
     * The name must not collide with an existing module-level listener. A symbol declared at the
     * node's own source location is the node itself, not a collision — that is what keeps the rule
     * quiet when the user re-saves a listener they are editing.
     */
    private static Optional<String> uniqueListenerName(Value node, Map<String, Object> args, ValidationContext ctx) {
        String name = CommonRuleValidators.text(node);
        if (name.isEmpty() || !ctx.hasSemanticModel()) {
            return Optional.empty();
        }
        for (Symbol symbol : ctx.semanticModel().moduleSymbols()) {
            if (!(symbol instanceof VariableSymbol variableSymbol)
                    || !variableSymbol.qualifiers().contains(Qualifier.LISTENER)) {
                continue;
            }
            Optional<String> symbolName = variableSymbol.getName();
            if (symbolName.isEmpty() || !symbolName.get().equals(name) || declaresNode(variableSymbol, node, ctx)) {
                continue;
            }
            return Optional.of("A listener with this name already exists in the project");
        }
        return Optional.empty();
    }

    /** The handler name must not collide with another member function of the same service. */
    private static Optional<String> uniqueFunctionName(Value node, Map<String, Object> args, ValidationContext ctx) {
        String name = CommonRuleValidators.text(node);
        if (name.isEmpty() || !(ctx.serviceNode() instanceof ServiceDeclarationNode serviceNode)) {
            return Optional.empty();
        }
        for (Node member : serviceNode.members()) {
            if (!(member instanceof FunctionDefinitionNode functionNode)) {
                continue;
            }
            if (!functionNode.functionName().text().trim().equals(name)) {
                continue;
            }
            // The handler being edited is itself a member, so a name match against its own
            // declaration is not a collision. `editedRange` is the whole function definition on an
            // edit and null on an add, which is exactly the distinction needed; the node passed here
            // is only the name Value and cannot supply it.
            if (isEditedConstruct(functionNode.lineRange(), ctx)) {
                continue;
            }
            return Optional.of("A function with this name already exists in this service");
        }
        return Optional.empty();
    }

    /** The selected existing listener must belong to the connector's module. */
    private static Optional<String> listenerCompatible(Value node, Map<String, Object> args, ValidationContext ctx) {
        String name = CommonRuleValidators.text(node);
        if (name.isEmpty() || !ctx.hasSemanticModel() || ctx.moduleName() == null) {
            return Optional.empty();
        }
        for (Symbol symbol : ctx.semanticModel().moduleSymbols()) {
            if (!(symbol instanceof VariableSymbol variableSymbol)
                    || !variableSymbol.qualifiers().contains(Qualifier.LISTENER)) {
                continue;
            }
            Optional<String> symbolName = variableSymbol.getName();
            if (symbolName.isEmpty() || !symbolName.get().equals(name)) {
                continue;
            }
            Optional<ModuleSymbol> module = variableSymbol.typeDescriptor().getModule();
            if (module.isEmpty()) {
                // Unresolvable listener type — not evidence of incompatibility.
                return Optional.empty();
            }
            return module.get().id().moduleName().equals(ctx.moduleName())
                    ? Optional.empty()
                    : Optional.of("{value} is not a {module} listener");
        }
        // The name does not resolve to a listener here; the dropdown may simply be ahead of the
        // semantic model. Not this rule's call to make.
        return Optional.empty();
    }

    /**
     * Authoritative identifier re-check. The lexical rules are the same ones the client applies, so
     * this exists to catch a value that reached the server without passing through the webview.
     */
    private static Optional<String> identifier(Value node) {
        return COMMON_IDENTIFIER.validate(node, Map.of(), ValidationContext.empty())
                .map(message -> "{label} is not a valid Ballerina identifier");
    }

    private static Optional<String> validType(Value node, Map<String, Object> args, ValidationContext ctx) {
        String type = CommonRuleValidators.text(node);
        if (type.isEmpty() || !ctx.hasSemanticModel() || !SIMPLE_TYPE_PATTERN.matcher(type).matches()) {
            return Optional.empty();
        }
        return resolveType(type, ctx).isPresent()
                ? Optional.empty()
                : Optional.of("{value} is not a valid type in this project");
    }

    private static Optional<String> subtype(Value node, Map<String, Object> args, ValidationContext ctx) {
        // The catalog also allows falling back to `codedata.typeConstraint`, but the wire Codedata
        // does not carry that field today (it lives only on the TriggerUISchemaModel records, and
        // PropertyValueAdapter does not map it across), so the arg is the only source. Wiring the
        // fallback means extending Codedata + the adapter first.
        String constraint = CommonRuleValidators.argToString(args.get("typeConstraint"));
        String type = CommonRuleValidators.text(node);
        if (type.isEmpty() || constraint == null || constraint.isBlank() || !ctx.hasSemanticModel()) {
            return Optional.empty();
        }
        if (!SIMPLE_TYPE_PATTERN.matcher(type).matches()) {
            return Optional.empty();
        }
        Optional<TypeSymbol> actual = resolveType(type, ctx);
        Optional<TypeSymbol> expected = resolveConstraint(constraint, ctx);
        if (actual.isEmpty() || expected.isEmpty()) {
            // Either side unresolvable -> no verdict. `valid.type` covers a genuinely bad type.
            return Optional.empty();
        }
        return actual.get().subtypeOf(expected.get())
                ? Optional.empty()
                : Optional.of("{value} is not a subtype of " + constraint);
    }

    /** Resolves a simple (optionally qualified, optionally array) type name to its symbol. */
    private static Optional<TypeSymbol> resolveType(String type, ValidationContext ctx) {
        String bare = type.endsWith("[]") ? type.substring(0, type.length() - 2) : type;
        String name = bare.contains(":") ? bare.substring(bare.indexOf(':') + 1) : bare;
        // A qualified name resolves through its module prefix, which this lookup does not track;
        // matching on the type's own name across module symbols is enough to tell "exists" from
        // "typo", which is all this rule claims.
        for (Symbol symbol : ctx.semanticModel().moduleSymbols()) {
            if (symbol instanceof TypeDefinitionSymbol typeDefinition
                    && typeDefinition.getName().filter(name::equals).isPresent()) {
                return Optional.of(typeDefinition.typeDescriptor());
            }
        }
        return builtinType(name, ctx.semanticModel());
    }

    private static Optional<TypeSymbol> resolveConstraint(String constraint, ValidationContext ctx) {
        return builtinType(constraint, ctx.semanticModel())
                .or(() -> SIMPLE_TYPE_PATTERN.matcher(constraint).matches()
                        ? resolveType(constraint, ctx)
                        : Optional.empty());
    }

    /** The builtin types a `typeConstraint` realistically names. */
    private static Optional<TypeSymbol> builtinType(String name, SemanticModel semanticModel) {
        return switch (name) {
            case "anydata" -> Optional.of(semanticModel.types().ANYDATA);
            case "json" -> Optional.of(semanticModel.types().JSON);
            case "string" -> Optional.of(semanticModel.types().STRING);
            case "int" -> Optional.of(semanticModel.types().INT);
            case "float" -> Optional.of(semanticModel.types().FLOAT);
            case "decimal" -> Optional.of(semanticModel.types().DECIMAL);
            case "boolean" -> Optional.of(semanticModel.types().BOOLEAN);
            case "error" -> Optional.of(semanticModel.types().ERROR);
            case "byte" -> Optional.of(semanticModel.types().BYTE);
            case "xml" -> Optional.of(semanticModel.types().XML);
            default -> Optional.empty();
        };
    }

    /**
     * Whether the symbol is the very construct being edited — either it sits at the node's own
     * recorded position, or at the range the request identified as the edit target.
     */
    private static boolean declaresNode(Symbol symbol, Value node, ValidationContext ctx) {
        if (symbol.getLocation().isEmpty()) {
            return false;
        }
        LineRange symbolRange = symbol.getLocation().get().lineRange();
        return sameLineRange(symbolRange, nodeLineRange(node)) || isEditedConstruct(symbolRange, ctx);
    }

    /** Whether a source range belongs to the construct this request is editing (never true on an add). */
    private static boolean isEditedConstruct(LineRange range, ValidationContext ctx) {
        LineRange edited = ctx.editedRange();
        if (edited == null) {
            return false;
        }
        // The edited range spans the whole construct, so containment — not equality — is the test:
        // the symbol's own location is the name inside it.
        return range.fileName().equals(edited.fileName())
                && range.startLine().line() >= edited.startLine().line()
                && range.endLine().line() <= edited.endLine().line();
    }

    private static LineRange nodeLineRange(Value node) {
        Codedata codedata = node.getCodedata();
        return codedata == null ? null : codedata.getLineRange();
    }

    private static boolean sameLineRange(LineRange left, LineRange right) {
        if (left == null || right == null) {
            return false;
        }
        return left.startLine().line() == right.startLine().line()
                && left.startLine().offset() == right.startLine().offset();
    }
}
