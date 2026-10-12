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

import { onModulePullProgress, trackModulePullProgress } from '../utils/module-pull-state';

const PULL = 'pull-module-19cef91b';

describe('module pull tracking', () => {
    it('notifies listeners of module-pull updates until they stop listening', () => {
        const kinds: string[] = [];
        const stop = onModulePullProgress(kind => kinds.push(kind));
        trackModulePullProgress(PULL, 'begin');
        trackModulePullProgress(PULL, 'report');
        stop();
        trackModulePullProgress(PULL, 'end');
        expect(kinds).toEqual(['begin', 'report']);
    });

    it('ignores progress that is not a module pull', () => {
        const kinds: string[] = [];
        const stop = onModulePullProgress(kind => kinds.push(kind));
        trackModulePullProgress('rename-1', 'begin');
        trackModulePullProgress(42, 'begin');
        stop();
        expect(kinds).toEqual([]);
    });
});
