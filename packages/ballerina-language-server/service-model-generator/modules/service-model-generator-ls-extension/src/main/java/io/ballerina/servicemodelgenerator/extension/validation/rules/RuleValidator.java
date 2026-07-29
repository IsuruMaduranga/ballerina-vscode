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

import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.validation.ValidationContext;

import java.util.Map;
import java.util.Optional;

/**
 * One named validation rule.
 *
 * <p>A validator returns {@link Optional#empty()} to pass — which also covers <i>skipping</i>, for
 * a rule that cannot meaningfully judge the value (a port rule against a listener expression, an
 * arg-less rule missing its required arg). On failure it returns its <b>default message template</b>,
 * uninterpolated; the engine substitutes the placeholders and lets a model-supplied {@code message}
 * override the text.
 *
 * @since 1.8.0
 */
@FunctionalInterface
public interface RuleValidator {

    /**
     * @param node    the form node being validated
     * @param args    the rule's arguments, never {@code null} (empty when the model supplied none)
     * @param context project context; {@code common.*} validators ignore it
     * @return the default message template on failure, empty to pass or skip
     */
    Optional<String> validate(Value node, Map<String, Object> args, ValidationContext context);
}
