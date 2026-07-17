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

import styled from "@emotion/styled";

/** Borderless centered wizard column that fills its (now definite-height)
 *  scroll host — see the height-locking effect in the wizard root. A flex
 *  column so the stepper and footer stay pinned while only the step content
 *  between them scrolls. The embedding chrome provides any outer framing. */
export const WizardPage = styled.div`
    height: 100%;
    max-width: 900px;
    margin: 0 auto;
    padding: 0 32px;
    display: flex;
    flex-direction: column;
    min-height: 0;
`;

/** Row above the step content: step-back icon pinned left, stepper centered. */
export const WizardTopBar = styled.div`
    position: relative;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 20px 0 14px;
    margin-bottom: 10px;
`;

export const BackButtonSlot = styled.div`
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
`;

/** Fills the remaining height below the stepper. Its content — the scroll area
 *  plus the pinned footer — is laid out as a flex column so only the scroll
 *  area moves. */
export const StepBody = styled.div`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
`;

/** The single scrolling region: step content (e.g. the artifact grid) scrolls
 *  here while the stepper above and the footer below stay put. */
export const StepScrollArea = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
`;
