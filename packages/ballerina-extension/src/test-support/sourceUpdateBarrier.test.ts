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

// L1: the barrier that keeps flow-model reads off the unformatted document `updateSourceCode`
// leaves behind between its raw text edit and the follow-up format.

import {
    beginSourceUpdate,
    isSourceUpdateInFlight,
    SourceUpdateHandle,
    whenSourceUpdatesSettle,
} from "../utils/source-update-barrier";

/** Resolves after the pending microtasks and one macrotask, so a settled await can land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("source update barrier", () => {
    let open: SourceUpdateHandle[] = [];

    /** Starts an update and remembers it, so afterEach can drain a case that failed midway. */
    const start = (): SourceUpdateHandle => {
        const handle = beginSourceUpdate();
        open.push(handle);
        return handle;
    };

    afterEach(() => {
        open.forEach((handle) => handle.done());
        open = [];
        expect(isSourceUpdateInFlight()).toBe(false);
    });

    it("resolves immediately when nothing is in flight", async () => {
        let settled = false;
        void whenSourceUpdatesSettle().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(true);
    });

    it("holds a waiter for the whole update and releases it at the end", async () => {
        const update = start();

        let settled = false;
        void whenSourceUpdatesSettle().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);

        update.done();
        await flush();
        expect(settled).toBe(true);
    });

    it("waits for the last of several overlapping updates", async () => {
        const first = start();
        const second = start();

        let settled = false;
        void whenSourceUpdatesSettle().then(() => { settled = true; });

        first.done();
        await flush();
        expect(settled).toBe(false);

        second.done();
        await flush();
        expect(settled).toBe(true);
    });

    it("does not release a waiter into a mid-write state when updates are back to back", async () => {
        const first = start();

        let settled = false;
        void whenSourceUpdatesSettle().then(() => { settled = true; });

        // The next save starts in the same tick the previous one ends — the sequence a diagram
        // refresh lands in when a form is submitted right after the last one finished.
        first.done();
        const second = start();
        await flush();
        expect(settled).toBe(false);

        second.done();
        await flush();
        expect(settled).toBe(true);
    });

    it("treats a repeated done() as a no-op, so an early release plus a finally net is safe", async () => {
        const update = start();
        const concurrent = start();

        update.done();
        update.done(); // the `finally` net after the write already released itself
        expect(isSourceUpdateInFlight()).toBe(true); // `concurrent` must still hold it

        let settled = false;
        void whenSourceUpdatesSettle().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);

        concurrent.done();
        await flush();
        expect(settled).toBe(true);
    });

    it("gives up after the timeout so a stuck write delays a read instead of withholding it", async () => {
        start(); // never released within the test's window

        const warn = jest.spyOn(console, "warn").mockImplementation(() => { });
        try {
            let settled = false;
            void whenSourceUpdatesSettle(20).then(() => { settled = true; });

            await flush();
            expect(settled).toBe(false);

            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(settled).toBe(true);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("bounds the whole wait, not each update, when writes run back to back", async () => {
        let current = start();
        // Hand off to a new update every 10ms: each one alone is short, but the chain outlives
        // the 30ms budget, which a per-update timeout would never notice.
        const chain = setInterval(() => {
            const next = start();
            current.done();
            current = next;
        }, 10);

        const warn = jest.spyOn(console, "warn").mockImplementation(() => { });
        try {
            let settled = false;
            void whenSourceUpdatesSettle(30).then(() => { settled = true; });

            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(settled).toBe(true);
            expect(warn).toHaveBeenCalled();
        } finally {
            clearInterval(chain);
            warn.mockRestore();
        }
    });
});
