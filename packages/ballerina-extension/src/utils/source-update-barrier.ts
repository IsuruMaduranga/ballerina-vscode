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

// A source update is not one atomic write: `updateSourceCode` applies the LS text edits
// verbatim first — they are unindented, the LS relies on the follow-up format — and formats
// the document in a second version. In between, the file holds text whose positions do not
// match the final source.
//
// Readers that turn document positions into durable UI state must not sample that state. The
// flow diagram is the sharp case: it builds its "+" insertion targets from the model's line
// ranges and replays them to the LS later, so a model read mid-write hands back a position that
// points somewhere else once the file is formatted.
//
// Scope: this is a barrier on *when* a read runs, not on which file it reads. It is deliberately
// coarse — matching a reader's path against the write's would silently stop gating on any path
// shape the comparison did not anticipate, which is the failure mode being fixed. Writes are
// short and the wait is capped, so the coarseness costs little.

/** Ceiling on how long a reader waits before giving up and reading anyway. */
export const MAX_SOURCE_UPDATE_WAIT_MS = 5000;

let inFlight = 0;
let settled: Promise<void> = Promise.resolve();
let release: () => void = () => { };

/** A single in-progress update. {@link SourceUpdateHandle.done} is idempotent. */
export interface SourceUpdateHandle {
    /**
     * Declares this update finished. Safe to call more than once — a caller can release early,
     * as soon as the file reaches its final shape, and still keep a `finally` net for the
     * paths that return or throw before that point.
     */
    done(): void;
}

/**
 * Marks the start of a source update. Returns the handle that ends it; because only the handle
 * can end it, an update cannot be released by anyone else or released twice.
 */
export function beginSourceUpdate(): SourceUpdateHandle {
    if (inFlight++ === 0) {
        settled = new Promise<void>((resolve) => {
            release = resolve;
        });
    }
    let finished = false;
    return {
        done(): void {
            if (finished) {
                return;
            }
            finished = true;
            if (--inFlight === 0) {
                release();
            }
        },
    };
}

/**
 * Resolves once no source update is mid-write, so a caller reads a file only in a state that
 * matches what the LS reports from there on.
 *
 * Bounded by `timeoutMs` over the whole wait, not per update: individual updates are bounded
 * (each resolves, rejects, or times out), but they can run back to back, and a read is worth
 * delaying — not withholding. On expiry the read proceeds against whatever is on disk, which
 * is the pre-barrier behaviour.
 */
export async function whenSourceUpdatesSettle(timeoutMs: number = MAX_SOURCE_UPDATE_WAIT_MS): Promise<void> {
    if (inFlight === 0) {
        // Overwhelmingly the common case — take it without allocating a timer.
        return;
    }

    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), timeoutMs);
    });
    try {
        // Loop rather than await once: a waiter released by one update can be resumed after the
        // next one has already started writing, which is the same mid-write state to avoid.
        while (inFlight > 0) {
            const outcome = await Promise.race([settled.then(() => "settled" as const), expired]);
            if (outcome === "expired") {
                console.warn(
                    `>>> source update did not settle within ${timeoutMs}ms; reading anyway ` +
                    `(positions may be mid-write)`
                );
                return;
            }
        }
    } finally {
        clearTimeout(timer);
    }
}

/** True while at least one source update is applying. Exposed for tests and diagnostics. */
export function isSourceUpdateInFlight(): boolean {
    return inFlight > 0;
}
