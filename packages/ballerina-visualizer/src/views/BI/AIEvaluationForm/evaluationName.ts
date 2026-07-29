/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { AvailableNode } from "@wso2/ballerina-core";

/**
 * Names an evaluation after what it evaluates: `evaluate<Subject><Template>`, e.g.
 * `evaluateMathTutorAgentCompleteness`. The shared `evaluate` prefix keeps evaluations together in the
 * Test Explorer and in `bal test` output, and the subject sorting next means one agent's evaluations
 * cluster as a project grows.
 *
 * Generation is deterministic: the same template, agent and project produce the same name every time.
 */

const NAME_PREFIX = 'evaluate';
const CUSTOM_NAME = 'customEvaluation';
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// `evaluateToolTrajectory` reads as `ToolTrajectory` once the verb moves to the front of the name.
const SYMBOL_VERB = /^(evaluate|assert|check|test)(?=[A-Z_])/;

const toPascalCase = (text: string): string =>
    text.replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');

// The label is what the user picked in the catalog, so it names the evaluation; the symbol is a fallback
// for a template whose label is missing or punctuation-only.
const templateToken = (template?: AvailableNode): string => {
    const symbol = String(template?.codedata?.symbol || '');
    return toPascalCase(String(template?.metadata?.label || ''))
        || toPascalCase(symbol.replace(SYMBOL_VERB, ''))
        || toPascalCase(symbol);
};

const evalsetToken = (evalSetFile: string): string =>
    toPascalCase(evalSetFile.split(/[\\/]/).pop()?.replace(/\..*$/, '') || '');

// What is under evaluation. A template that takes an agent is named after it and nothing else: the agent
// is a required argument, so a name derived from the evalset in the meantime would only claim a subject
// the user has not chosen. The agent argument is an expression field, so it names the evaluation only
// when it holds a plain reference rather than an inline expression.
const subjectToken = (hasAgent: boolean, agentValue: string, evalSetFile: string): string => {
    if (!hasAgent) {
        return evalsetToken(evalSetFile);
    }
    return IDENTIFIER.test(agentValue.trim()) ? toPascalCase(agentValue.trim()) : '';
};

const uniqueName = (base: string, takenNames: Iterable<string>): string => {
    const taken = new Set(takenNames);
    if (!taken.has(base)) {
        return base;
    }
    let suffix = 2;
    while (taken.has(`${base}${suffix}`)) {
        suffix++;
    }
    return `${base}${suffix}`;
};

/**
 * Suggests a name for a new evaluation. Without a template there is no intent to name after, so this
 * falls back to a placeholder the user is expected to replace.
 *
 * `takenNames` only holds the project's annotated test functions, so a collision with an unannotated
 * declaration in the same package is still possible; the identifier field's `redeclared symbol`
 * diagnostic remains the authority.
 */
export const suggestEvaluationName = (args: {
    template?: AvailableNode;
    /** Whether the template takes an `ai:Agent` at all, which decides what can name the evaluation. */
    hasAgent?: boolean;
    agentValue?: string;
    evalSetFile?: string;
    takenNames: Iterable<string>;
}): string => {
    const template = templateToken(args.template);
    if (!template) {
        return uniqueName(CUSTOM_NAME, args.takenNames);
    }
    const subject = subjectToken(Boolean(args.hasAgent), args.agentValue || '', args.evalSetFile || '');
    return uniqueName(`${NAME_PREFIX}${subject}${template}`, args.takenNames);
};
