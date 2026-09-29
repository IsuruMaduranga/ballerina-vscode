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

import { LoginMethodValue, resolveProviderModelOptions } from '../features/ai/utils/provider-model-options';

const ANTHROPIC_NAMESPACE_METHODS: LoginMethodValue[] = ['biIntel', 'anthropic_key', 'vertex_ai', 'anthropic_aws', 'aws_unified'];

describe('resolveProviderModelOptions', () => {
    it.each(ANTHROPIC_NAMESPACE_METHODS)('%s gets adaptive thinking with the effort in the anthropic namespace', (method) => {
        expect(resolveProviderModelOptions(method, 'medium', 'summarized')).toEqual({
            anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'medium' },
        });
    });

    it('Bedrock gets the same settings through reasoningConfig, which its Converse provider reads', () => {
        expect(resolveProviderModelOptions('aws_bedrock', 'low', 'summarized')).toEqual({
            bedrock: { reasoningConfig: { type: 'adaptive', display: 'summarized', maxReasoningEffort: 'low' } },
        });
    });

    it('leaves display out when none is asked for, so the API default applies', () => {
        expect(resolveProviderModelOptions('anthropic_key', 'low')).toEqual({
            anthropic: { thinking: { type: 'adaptive' }, effort: 'low' },
        });
        expect(resolveProviderModelOptions('aws_bedrock', 'high')).toEqual({
            bedrock: { reasoningConfig: { type: 'adaptive', maxReasoningEffort: 'high' } },
        });
    });

    it.each([...ANTHROPIC_NAMESPACE_METHODS, 'aws_bedrock' as const])('%s never sends disabled thinking, which Sonnet 5.5 rejects', (method) => {
        expect(JSON.stringify(resolveProviderModelOptions(method, 'low'))).not.toContain('disabled');
    });
});
