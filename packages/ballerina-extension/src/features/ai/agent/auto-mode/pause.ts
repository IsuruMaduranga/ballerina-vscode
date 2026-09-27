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
 * Auto-mode pause tracking and the denial log (pure).
 *
 * Claude Code pauses auto mode after 3 consecutive or 20 total classifier
 * blocks in a session and falls back to prompting; approving a prompted action
 * resumes it. The point is that a model stuck in a loop the classifier keeps
 * refusing should reach the user rather than grinding through refusals, and
 * that a session where the classifier has fired 20 times is a session whose
 * premise the user should re-examine.
 */

export const CONSECUTIVE_BLOCK_LIMIT = 3;
export const TOTAL_BLOCK_LIMIT = 20;
/** The first resume prompt in an uninterrupted block streak must not stall an unattended run. */
export const UNATTENDED_PROMPT_TIMEOUT_MS = 120_000;

export interface Denial {
    toolName: string;
    /** The command or path the call targeted, for the /permissions listing. */
    subject: string;
    /** The cited rule's own text — checked, not paraphrased. */
    reason: string;
    tier?: string;
    /** Validated rule id, so a false positive can be traced to the rule to edit. */
    ruleId?: string;
    /**
     * The classifier's own wording. Kept so this class of failure is diagnosable
     * rather than anecdotal: a reason that reads oddly is visible next to the rule
     * it claimed, instead of being the only thing on record.
     */
    raw?: string;
}

export class PauseTracker {
    private consecutive = 0;
    private total = 0;
    private paused = false;
    private trippedBy: "consecutive" | "total" | undefined;
    private timedShown = false;
    private readonly denials: Denial[] = [];

    /** Record a classifier block. Returns true if this one tripped the pause. */
    recordBlock(denial: Denial): boolean {
        this.consecutive++;
        this.total++;
        this.denials.push(denial);
        if (this.paused) { return false; }

        if (this.consecutive >= CONSECUTIVE_BLOCK_LIMIT) {
            this.paused = true;
            this.trippedBy = "consecutive";
            return true;
        }
        if (this.total >= TOTAL_BLOCK_LIMIT) {
            this.paused = true;
            this.trippedBy = "total";
            // The total counter resets when it is what triggered the fallback.
            // Without this, resuming leaves it at the limit and the very next block
            // re-pauses immediately, making the resume single-use.
            this.total = 0;
            return true;
        }
        return false;
    }

    /** Any allowed call breaks the streak and its pause; a total-limit pause still needs the user. */
    recordAllow(): boolean {
        this.consecutive = 0;
        this.timedShown = false;
        if (!this.paused || this.trippedBy !== "consecutive") { return false; }
        this.paused = false;
        this.trippedBy = undefined;
        return true;
    }

    /** Time only the first resume prompt in a consecutive-block streak. */
    takeTimedPrompt(): boolean {
        if (!this.paused || this.trippedBy !== "consecutive" || this.timedShown) { return false; }
        this.timedShown = true;
        return true;
    }

    /**
     * The user approved a prompted call, so auto mode picks back up. The
     * consecutive counter resets with it — otherwise the very next block would
     * re-pause immediately and the resume would be meaningless.
     */
    resume(): void {
        this.paused = false;
        this.consecutive = 0;
        this.trippedBy = undefined;
        this.timedShown = false;
    }

    isPaused(): boolean {
        return this.paused;
    }

    /** Forget everything — a new session (`/clear`, `/resume`) starts with a clean record. */
    reset(): void {
        this.consecutive = 0;
        this.total = 0;
        this.paused = false;
        this.trippedBy = undefined;
        this.timedShown = false;
        this.denials.length = 0;
    }

    /** Most recent first, for the `/permissions` "recently denied" listing. */
    recentDenials(limit = 10): Denial[] {
        return this.denials.slice(-limit).reverse();
    }

    /**
     * `total` is the counter that drives the fallback and resets when it fires;
     * `lifetime` is every block this session, which is what to show a user.
     */
    stats(): { consecutive: number; total: number; lifetime: number; paused: boolean } {
        return {
            consecutive: this.consecutive,
            total: this.total,
            lifetime: this.denials.length,
            paused: this.paused,
        };
    }
}
