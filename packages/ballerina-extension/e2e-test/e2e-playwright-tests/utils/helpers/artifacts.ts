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

import { getWebview } from "./webview";
import { page } from "./setup";
import { BI_INTEGRATOR_LABEL, BI_WEBVIEW_NOT_FOUND_ERROR } from "./constants";

/**
 * Add an artifact to the project. The overview header shows "Add Artifact" (opening the
 * flat artifact-list picker) once the integration has at least one artifact; on a still-empty
 * integration it shows "Add Integration" instead, which reopens the creation wizard's Type
 * step — a card picker restricted to the subset of kinds the wizard supports, but sharing the
 * same card ids as the flat picker. That step requires an explicit "Next" after selecting the
 * card, unlike the flat picker's direct card-click.
 */
export async function addArtifact(artifactName: string, testId: string) {
    console.log(`Adding artifact: ${artifactName}`);
    const artifactWebView = await getWebview(BI_INTEGRATOR_LABEL, page);
    if (!artifactWebView) {
        throw new Error(BI_WEBVIEW_NOT_FOUND_ERROR);
    }
    const addArtifactBtn = artifactWebView.getByRole('button', { name: /Add Artifact/i });
    const addIntegrationBtn = artifactWebView.getByRole('button', { name: /Add Integration/i });
    await Promise.race([
        addArtifactBtn.waitFor({ timeout: 30000 }),
        addIntegrationBtn.waitFor({ timeout: 30000 }),
    ]);

    if (await addIntegrationBtn.isVisible().catch(() => false)) {
        await addIntegrationBtn.click();
        const card = artifactWebView.locator(`#${testId}`);
        await card.waitFor();
        await card.click();
        await artifactWebView.getByRole('button', { name: 'Next' }).click();
        return;
    }

    await addArtifactBtn.click();
    const card = artifactWebView.locator(`#${testId}`);
    await card.waitFor();
    await card.click();
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
