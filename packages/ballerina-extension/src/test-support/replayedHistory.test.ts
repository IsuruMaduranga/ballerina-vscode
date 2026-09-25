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

for (const m of [
    '@wso2/ballerina-core', '../features/ai/utils/ai-client', '../RPCLayer', '../views/ai-panel/webview',
    '../views/migration-panel/webview', '../views/visualizer/webview', '../features/ai/utils/libs/libraries',
    '../features/ai/utils/run-event-store', '../features/ai/state/AgentStatusManager',
]) { jest.mock(m, () => ({})); }

import { populateHistoryForAgent } from '../features/ai/utils/ai-utils';

const compactionPart = (text: string) => ({ type: 'text', text, providerOptions: { anthropic: { type: 'compaction' } } });

describe('populateHistoryForAgent', () => {
    it('strips analysis from compaction blocks so the replay matches the live request', () => {
        const history = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [compactionPart('<analysis>draft</analysis>\n<summary>kept</summary>')] },
        ];
        const [, assistant] = populateHistoryForAgent(history);
        expect((assistant.content as any[])[0].text).toBe('<summary>kept</summary>');
    });

    it('leaves ordinary assistant text that mentions analysis untouched', () => {
        const text = 'Wrap it in <analysis>x</analysis> tags.';
        const [assistant] = populateHistoryForAgent([{ role: 'assistant', content: [{ type: 'text', text }] }]);
        expect((assistant.content as any[])[0].text).toBe(text);
    });
});
