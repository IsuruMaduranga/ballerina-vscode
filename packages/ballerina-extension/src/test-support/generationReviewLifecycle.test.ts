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

// Persistence is mocked so these never reach the real on-disk chat store.
jest.mock('@wso2/copilot-utilities/chat-persistence', () => ({
    CopilotPersistenceStore: class {
        saveThread() { return true; }
        getWorkspaceMetadata() { return undefined; }
        saveWorkspaceMetadata() { return true; }
        listThreadIds() { return []; }
        loadThread() { return undefined; }
        deleteThread() { return true; }
        saveCheckpoint() { return true; }
        loadCheckpoints() { return []; }
        deleteCheckpoints() { return true; }
    },
}));

// Cuts an import chain that reaches ballerina-core's index and an ESM-only LS dependency.
jest.mock('../features/ai/state/ApprovalManager', () => ({
    approvalManager: { cancelAllPending: jest.fn() },
}));

jest.mock('../features/ai/utils/project/temp-project', () => ({
    cleanupTempProject: jest.fn(),
    getReviewBaselinePath: (p: string) => `${p}-review-baseline`,
}));

import { ChatStateStorage } from '../views/ai-panel/chatStateStorage';

const ROOT = '/workspace';

function seedDoneGeneration(store: ChatStateStorage, threadId: string, prompt = 'do a thing') {
    const generationId = `gen-${threadId}`;
    store.getOrCreateThread(ROOT, threadId);
    store.addGeneration(ROOT, threadId, prompt, { generationType: 'agent' } as never, generationId);
    store.updateReviewState(ROOT, threadId, generationId, {
        status: 'done',
        tempProjectPath: ROOT,
        modifiedFiles: ['main.bal'],
        affectedPackagePaths: [ROOT],
        reviewView: { semanticDiffs: [{ any: 'diff' }], loadDesignDiagrams: true, isWorkspace: false },
    });
    return generationId;
}

describe('generation review lifecycle', () => {
    let store: ChatStateStorage;

    beforeEach(() => {
        store = new ChatStateStorage();
    });

    it('drops reviewView when the generation is implicitly accepted', () => {
        const generationId = seedDoneGeneration(store, 'thread-a');
        expect(store.getDoneGeneration(ROOT, 'thread-a')?.reviewState.reviewView).toBeDefined();

        const finalized = store.finalizeLastGenerationIfDone(ROOT, 'thread-a');

        expect(finalized?.id).toBe(generationId);
        expect(finalized?.reviewState.status).toBe('accepted');
        expect(finalized?.reviewState.reviewView).toBeUndefined();
    });

    it('drops reviewView when the generation is reverted', () => {
        seedDoneGeneration(store, 'thread-a');

        const reverted = store.revertLastGeneration(ROOT, 'thread-a');

        expect(reverted?.reviewState.status).toBe('reverted');
        expect(reverted?.reviewState.reviewView).toBeUndefined();
    });

    it('EDGE: is a no-op when no generation is done', () => {
        store.getOrCreateThread(ROOT, 'empty-thread');

        expect(store.finalizeLastGenerationIfDone(ROOT, 'empty-thread')).toBeUndefined();
        expect(store.revertLastGeneration(ROOT, 'empty-thread')).toBeUndefined();
    });

    it('EDGE: finalizing twice does not re-report the same generation', () => {
        seedDoneGeneration(store, 'thread-a');

        expect(store.finalizeLastGenerationIfDone(ROOT, 'thread-a')).toBeDefined();
        // Second call must find nothing — otherwise the next-turn path would double-report.
        expect(store.finalizeLastGenerationIfDone(ROOT, 'thread-a')).toBeUndefined();
    });

    it('EDGE: a reverted generation cannot then be accepted', () => {
        seedDoneGeneration(store, 'thread-a');

        expect(store.revertLastGeneration(ROOT, 'thread-a')).toBeDefined();
        expect(store.finalizeLastGenerationIfDone(ROOT, 'thread-a')).toBeUndefined();
    });

    it('EDGE: finalizing one thread leaves another thread revertible', () => {
        seedDoneGeneration(store, 'thread-a');
        seedDoneGeneration(store, 'thread-b');

        store.finalizeLastGenerationIfDone(ROOT, 'thread-a');

        expect(store.getDoneGeneration(ROOT, 'thread-a')).toBeUndefined();
        const other = store.getDoneGeneration(ROOT, 'thread-b');
        expect(other?.reviewState.status).toBe('done');
        expect(other?.reviewState.reviewView).toBeDefined();
    });

    it('EDGE: at most one generation is done per thread', () => {
        seedDoneGeneration(store, 'thread-a');
        // A second turn in the same thread: the first must stop being revertible.
        store.finalizeLastGenerationIfDone(ROOT, 'thread-a');
        const secondId = 'gen-second';
        store.addGeneration(ROOT, 'thread-a', 'another thing', { generationType: 'agent' } as never, secondId);
        store.updateReviewState(ROOT, 'thread-a', secondId, { status: 'done', modifiedFiles: [] });

        expect(store.getDoneGeneration(ROOT, 'thread-a')?.id).toBe(secondId);
    });
});
