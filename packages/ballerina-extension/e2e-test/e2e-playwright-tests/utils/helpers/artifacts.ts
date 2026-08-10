/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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

import { Frame, Locator } from "@playwright/test";
import { getWebview } from "./webview";
import { page } from "./setup";
import { BI_INTEGRATOR_LABEL, BI_WEBVIEW_NOT_FOUND_ERROR } from "./constants";

/**
 * Clicks a locator via the DOM `click()` method instead of a coordinate-based
 * mouse click. The floating Copilot orb (AgentStatusOrb) is fixed-position,
 * docks at the webview's bottom-center by default, and sits ABOVE page
 * content (z-index 10000) — the wizard's Configure-step submit button is a
 * full-width, bottom-pinned "footer action button" (see ArtifactForm's
 * `footerActionButton`), so its center point can coincide exactly with the
 * orb's. A coordinate click there — even with `force: true`, which only
 * skips Playwright's actionability checks, not real hit-testing — lands on
 * the orb instead and silently opens its mini chat rather than submitting
 * the form. Dispatching through the DOM node bypasses hit-testing entirely.
 */
export async function domClick(locator: Locator): Promise<void> {
    await locator.waitFor({ state: "attached", timeout: 15000 });
    await locator.evaluate((el: HTMLElement) => el.click());
}

/**
 * Add an artifact to the project.
 *
 * "Add Artifact" is the only way in, from either state of the overview: the Design header
 * once the integration has an artifact, and the empty state before that. Both open the flat
 * artifact-list picker, where a card click goes straight to the artifact's form.
 *
 * Asserts "Add Integration" is absent rather than tolerating it. That button opened the
 * creation wizard's Type step — a restricted card picker needing an explicit "Next" — and
 * accepting either would let this helper pass against the flow it is meant to have replaced.
 */
export async function addArtifact(artifactName: string, testId: string) {
    console.log(`Adding artifact: ${artifactName}`);
    const artifactWebView = await getWebview(BI_INTEGRATOR_LABEL, page);
    if (!artifactWebView) {
        throw new Error(BI_WEBVIEW_NOT_FOUND_ERROR);
    }
    const addArtifactBtn = artifactWebView.getByRole('button', { name: /Add Artifact/i });
    await addArtifactBtn.waitFor({ timeout: 30000 });

    // Checked only once "Add Artifact" is on screen, so this reports a genuine second entry
    // point rather than racing the overview's first paint.
    const addIntegrationCount = await artifactWebView
        .getByRole('button', { name: /Add Integration/i })
        .count();
    if (addIntegrationCount > 0) {
        throw new Error(
            'The overview offered "Add Integration"; the artifact list is the only expected entry point.'
        );
    }
    // Exactly one, so a future change cannot reintroduce a second by rendering both states' buttons.
    const addArtifactCount = await addArtifactBtn.count();
    if (addArtifactCount !== 1) {
        throw new Error(`Expected exactly one "Add Artifact" button, found ${addArtifactCount}.`);
    }

    // `force` throughout — the floating Copilot orb/invite box intermittently overlaps
    // and intercepts pointer events on cards and buttons across these views.
    await addArtifactBtn.click({ force: true });
    const card = artifactWebView.locator(`#${testId}`);
    await card.waitFor();
    await domClick(card);
}

/**
 * Add an artifact and return its just-opened creation webview. Shared by
 * every artifact's create test — `addArtifact` followed by an iframe fetch
 * is identical across artifact types.
 */
export async function createArtifactAndGetWebview(artifactName: string, testId: string) {
    await addArtifact(artifactName, testId);
    return getWebview(BI_INTEGRATOR_LABEL, page);
}

/**
 * Submits the artifact creation form shown after `addArtifact`/
 * `createArtifactAndGetWebview` — always the in-project form's "Create", now that the
 * wizard's Configure step ("Create Integration") is no longer reachable from the overview.
 *
 * Still uses `domClick` rather than a coordinate click: the form's button can be a
 * full-width footer action button (see ArtifactForm's `footerActionButton`) whose center
 * sits exactly where the floating Copilot orb docks by default, so a coordinate click —
 * even with `force: true` — can silently land on the orb instead and open its mini chat
 * rather than submitting the form.
 */
export async function submitArtifactCreation(webview: Frame): Promise<void> {
    const submitBtn = webview.getByRole('button', { name: /^Create$/ });
    await submitBtn.waitFor({ state: 'visible', timeout: 60000 });
    await domClick(submitBtn);
}

/**
 * Enable ICP (Integration Control Plane)
 */
export async function enableICP() {
    console.log('Enabling ICP');
    const webview = await getWebview(BI_INTEGRATOR_LABEL, page);
    if (!webview) {
        throw new Error(BI_WEBVIEW_NOT_FOUND_ERROR);
    }
    const icpToggle = webview.getByRole('checkbox', { name: 'Enable ICP monitoring' });
    await icpToggle.waitFor();
    if (!(await icpToggle.isChecked())) {
        await icpToggle.click();
    }
}
