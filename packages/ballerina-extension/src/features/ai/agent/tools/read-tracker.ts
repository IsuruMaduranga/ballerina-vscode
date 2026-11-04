// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * Read-before-edit tracking (pure), as Claude Code does it: an edit or overwrite of a file that
 * exists but was never read is refused, and so is one of a file that changed since the agent last
 * saw it, so the agent cannot discard content it has not seen or clobber someone else's change.
 * The project's source is not in the conversation, so a read is the only way the agent sees a file.
 *
 * Tracking is by content: `file_read` and the agent's own writes record what the file held, and an
 * edit compares that with the file on disk. A change through the shell, the review's revert or the
 * user's editor therefore reads as stale. State is per chat thread, in memory and a digest per file;
 * a compaction restart or a deleted thread forgets it, since the agent no longer holds the content.
 */

import { createHash } from "crypto";
import { resolve } from "path";

export type FreshnessStatus = "fresh" | "unread" | "stale";

/** Bounds memory on long chats: the least recently read or written file goes first. */
const MAX_TRACKED_FILES = 300;

/** Equality is all the guard asks of content, so a digest stands in for it. */
function digest(content: string): string {
    return createHash("sha1").update(content).digest("hex");
}

export class ReadTracker {
    /** Each file's digest as the agent last saw it, by resolved path, oldest first. */
    private files = new Map<string, string>();

    /** Record what the file holds after the agent read or wrote it. */
    observe(path: string, content: string): void {
        const key = resolve(path);
        this.files.delete(key);
        this.files.set(key, digest(content));
        if (this.files.size > MAX_TRACKED_FILES) {
            this.files.delete(this.files.keys().next().value as string);
        }
    }

    forget(path: string): void {
        this.files.delete(resolve(path));
    }

    clear(): void {
        this.files.clear();
    }

    /**
     * For an existing file holding `currentContent`: `unread` when the agent has not read it,
     * `stale` when it changed since the agent last saw it, `fresh` when what it saw is on disk.
     */
    status(path: string, currentContent: string): FreshnessStatus {
        const known = this.files.get(resolve(path));
        if (known === undefined) { return "unread"; }
        return known === digest(currentContent) ? "fresh" : "stale";
    }
}

export const UNREAD_REASON = (path: string, tool: string, readTool: string) =>
    `Read ${path} with ${readTool} before using ${tool} on it. The file exists and has not been read in this conversation, so an edit could silently discard content you have not seen. A shell read counts only when it printed the whole file as it is on disk (a plain \`cat\`); after a partial one (head, sed -n, a pipe, or output cut off at the size limit) or another version of it (such as \`git show HEAD:<file>\`), use ${readTool}.`;

export const STALE_REASON = (path: string, readTool: string) =>
    `${path} has changed on disk since you last read it: the user, the review, or a command may have modified it. Read it again with ${readTool} before editing, or your change would overwrite theirs.`;

const trackers = new Map<string, ReadTracker>();

/** The tracker of one chat thread (`buildRunKey(projectRootPath, threadId)`). */
export function readTrackerFor(threadKey: string): ReadTracker {
    let tracker = trackers.get(threadKey);
    if (!tracker) {
        tracker = new ReadTracker();
        trackers.set(threadKey, tracker);
    }
    return tracker;
}

/** Forget what the agent read in a deleted thread. */
export function forgetReads(threadKey: string): void {
    trackers.delete(threadKey);
}
