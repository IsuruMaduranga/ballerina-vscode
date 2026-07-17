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

/** The wizard's three steps: Basic Info, Artifact Type, Configure. */
export type WizardStep = 0 | 1 | 2;

/** Step-1 form state. */
export interface BasicInfo {
    /** The integration display name; "Untitled" is applied only on skip. */
    integrationName: string;
    /** Parent directory the package is created under. Seeded from the default creation path. */
    path: string;
    /** True once the user edited the path — gates realtime path validation. */
    pathTouched: boolean;
}

/** Silent-scaffold lifecycle for step 3 (project created on disk, not opened). */
export interface ScaffoldState {
    status: "idle" | "creating" | "ready" | "error";
    /** The scaffolded package root, present when status is "ready". */
    projectRoot?: string;
    /** Fingerprint of the basic info the scaffold was created with. */
    paramsKey?: string;
    error?: string;
}
