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
import { ProgressRing, ThemeColors } from "@wso2/ui-toolkit";

const Wrapper = styled.div`
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
`;

const Content = styled.div`
    max-width: 500px;
    padding: 2rem;
    animation: creatingFadeIn 0.4s ease-in-out;
    @keyframes creatingFadeIn {
        0% { opacity: 0; }
        100% { opacity: 1; }
    }
`;

const RingSlot = styled.div`
    display: flex;
    justify-content: center;
`;

const Title = styled.h1`
    color: var(--vscode-foreground);
    font-size: 1.5em;
    font-weight: 400;
    margin: 1.5rem 0 0 0;
    letter-spacing: -0.02em;
    line-height: normal;
    /* Long integration names must not stretch the panel or clip. */
    overflow-wrap: anywhere;
`;

const Subtitle = styled.p`
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
    margin: 0.5rem 0 2rem 0;
    opacity: 0.8;
`;

const StatusLine = styled.div`
    color: ${ThemeColors.PRIMARY};
    font-size: 13px;
    font-weight: 500;
    .creating-dots::after {
        content: '';
        animation: creatingDots 1.5s infinite;
    }
    @keyframes creatingDots {
        0%, 20% { content: ''; }
        40% { content: '.'; }
        60% { content: '..'; }
        80%, 100% { content: '...'; }
    }
`;

const ReloadHint = styled.p`
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin: 1.5rem 0 0 0;
    opacity: 0.7;
`;

/**
 * `create` covers the paths that create a package (and may reload the window);
 * `add` covers generating an artifact into a package that already exists and is
 * already open, where there is no name being created and nothing to open.
 */
type CreatingIntegrationViewProps =
    | {
        variant: "create";
        /** Integration being created — the same name the post-reload screen shows. */
        integrationName: string;
        /** e.g. "service"; omit for an empty integration. */
        artifactLabel?: string;
    }
    | {
        variant: "add";
        /** e.g. "service" — the artifact being generated. */
        artifactLabel?: string;
    };

/**
 * Replaces the wizard while the final submit is in flight.
 *
 * This is the first half of one continuous progress screen: on the reload paths
 * the extension's startup screen (static HTML, then `LanguageServerLoadingView`)
 * comes up with the same layout, title and wording on the other side of the
 * window reload, so what is really "wizard → blank workbench → visualizer" reads
 * as a single screen that stays put until the integration is ready.
 *
 * The status line is deliberately vague about *which* step is running: the submit
 * is a single RPC with no progress signal, and inventing per-step checkmarks would
 * be narrating work we cannot observe. The footnote likewise avoids promising a
 * window reload — whether one happens is the extension's call (it is skipped when
 * the target project is already open), and the wizard cannot tell in advance.
 */
export function CreatingIntegrationView(props: CreatingIntegrationViewProps) {
    const isCreate = props.variant === "create";
    // Only a create can legitimately have no artifact (an empty integration); the
    // add path always carries one, so its fallback is just defensive.
    const artifact = props.artifactLabel ?? (isCreate ? "integration" : "artifact");
    return (
        <Wrapper>
            <Content>
                <RingSlot>
                    <ProgressRing sx={{ height: 36, width: 36 }} />
                </RingSlot>
                <Title>{props.variant === "create" ? `Creating ${props.integrationName}` : `Adding your ${artifact}`}</Title>
                <Subtitle>
                    {isCreate ? `Setting up your ${artifact}.` : "Generating it in your integration."}
                </Subtitle>
                <StatusLine>
                    <span className="creating-dots">{isCreate ? "Creating project" : "Generating"}</span>
                </StatusLine>
                {isCreate && <ReloadHint>Opening your integration — this takes a few seconds.</ReloadHint>}
            </Content>
        </Wrapper>
    );
}
