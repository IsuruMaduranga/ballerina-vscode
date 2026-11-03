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
 * Where the classifier's user message carries its cache breakpoints (pure).
 * It never changes the text sent, only how it is split into blocks.
 *
 * The transcript is the whole active context, so a single user block would
 * write all of it to the cache on every call and never read it back: the
 * block ends with the command under review and the stage instruction, which
 * change on every call. Instead the message is one text block per transcript
 * entry, with the same text, and a breakpoint on the last history entry, so
 * stage 2 and the next gated command read the history stage 1 wrote. A second
 * breakpoint goes on the previous call's history end while it is still in
 * range: Anthropic looks back only 20 blocks from a breakpoint for an earlier
 * entry, and more than 20 entries can arrive between two shell commands. The
 * index is only a hint: after a compaction restart the blocks differ and the
 * lookup misses; it can never reuse stale text.
 *
 * A request may carry at most four breakpoints. The classifier has no tools
 * and one system prompt; the history marks use only the slots the system
 * prompt leaves, dropping the previous-call mark first.
 */

/** Anthropic's limit on cache breakpoints in one request. */
export const MAX_CACHE_MARKERS = 4;

/** The classifier's user message as the stable blocks it is made of. */
export interface ClassifierUserText {
    /** The blocks in order; joined, they are the user message's text. */
    parts: readonly string[];
    /** Index in `parts` of the last history entry, the block the cache breakpoint follows. */
    historyEnd: number;
    /** The previous classifier call's `historyEnd` in this thread, if any. */
    previousHistoryEnd?: number;
}

/** What one thread remembers between classifier calls: a cache lookup hint only. */
export interface ClassifierCacheState {
    historyEnd?: number;
}

/** One text part of an AI SDK user message, with the provider's cache marker on a breakpoint. */
export type CachedTextPart<M> = { type: "text"; text: string; providerOptions?: M };

/**
 * The user message's content: one text part per block, a marker after the
 * last history entry and, when a slot is free and it is earlier, after the
 * previous call's history end. `markersElsewhere` counts the breakpoints the
 * rest of the request carries (the system prompt's). A block that is empty or
 * only whitespace would be rejected by the provider, so then the text goes as
 * one unmarked part: caching is optional, the payload is not.
 */
export function classifierUserContent<M>(user: ClassifierUserText, marker: M, markersElsewhere: number): CachedTextPart<M>[] {
    const { parts, historyEnd, previousHistoryEnd } = user;
    const free = MAX_CACHE_MARKERS - markersElsewhere;
    const valid = historyEnd >= 0 && historyEnd < parts.length && parts.every((part) => part.trim() !== "");
    if (free < 1 || !valid) { return [{ type: "text", text: parts.join("") }]; }
    const markPrevious = free >= 2 && previousHistoryEnd !== undefined && previousHistoryEnd >= 0 && previousHistoryEnd < historyEnd;
    return parts.map((text, i) =>
        i === historyEnd || (markPrevious && i === previousHistoryEnd) ? { type: "text", text, providerOptions: marker } : { type: "text", text },
    );
}

/** Breakpoints the classifier request carries outside its user message: the system prompt's one. */
export const SYSTEM_CACHE_MARKERS = 1;

/**
 * The classifier request's messages: the system prompt with its breakpoint,
 * then the user message as its stable blocks. `marker` is the provider's
 * cache option (`getProviderCacheControl`), used for every breakpoint.
 */
export function classifierMessages<M>(system: string, user: ClassifierUserText, marker: M): [
    { role: "system"; content: string; providerOptions: M },
    { role: "user"; content: CachedTextPart<M>[] },
] {
    return [
        { role: "system", content: system, providerOptions: marker },
        { role: "user", content: classifierUserContent(user, marker, SYSTEM_CACHE_MARKERS) },
    ];
}
