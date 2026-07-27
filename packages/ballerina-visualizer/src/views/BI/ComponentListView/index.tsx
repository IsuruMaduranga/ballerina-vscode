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

import React, { useEffect, useState } from "react";
import { SearchBox, View, ViewContent } from "@wso2/ui-toolkit";
import { isSamePath, SCOPE, TriggerModelsResponse } from "@wso2/ballerina-core";

import { TitleBar } from "../../../components/TitleBar";
import { TopNavigationBar } from "../../../components/TopNavigationBar";
import { AddPanel, Chip, ChipRow, Container, FilterBar, SearchSlot } from "./styles";
import { AutomationPanel } from "./AutomationPanel";
import { WorkflowPanel } from "./WorkflowPanel";
import { EventIntegrationPanel } from "./EventIntegrationPanel";
import { FileIntegrationPanel } from "./FileIntegrationPanel";
import { IntegrationAPIPanel } from "./IntegrationApiPanel";
import { OtherArtifactsPanel } from "./OtherArtifactsPanel";
import { AIAgentPanel } from "./AIAgentPanel";
import { useVisualizerContext } from "../../../Context";
import { useRpcContext } from "@wso2/ballerina-rpc-client";

interface ComponentListViewProps {
    projectPath: string;
    scope: SCOPE;
};

const ALL_CATEGORY = "all";

/** Category chips shown above the artifact panels — labels + accent colors kept
 *  in sync with the Project Overview type labels and the Create wizard chips. */
const CATEGORY_CHIPS: { key: string; label: string; color: string }[] = [
    { key: ALL_CATEGORY, label: "All", color: "var(--vscode-foreground)" },
    { key: "automation", label: "Automation", color: "var(--vscode-charts-blue)" },
    { key: "workflow", label: "Workflow", color: "var(--vscode-charts-yellow)" },
    { key: "ai", label: "AI", color: "var(--vscode-terminal-ansiBlue)" },
    { key: "api", label: "API", color: "var(--vscode-charts-green)" },
    { key: "event", label: "Event", color: "var(--vscode-charts-orange)" },
    { key: "file", label: "File", color: "var(--vscode-charts-purple)" },
    { key: "other", label: "Other", color: "var(--vscode-foreground)" },
];

export function ComponentListView(props: ComponentListViewProps) {
    const { projectPath, scope } = props;
    const { rpcClient } = useRpcContext();
    const [triggers, setTriggers] = useState<TriggerModelsResponse>({ local: [] });
    const { cacheTriggers, setCacheTriggers } = useVisualizerContext();
    const [isNPSupported, setIsNPSupported] = useState<boolean>(false);
    const [isLibrary, setIsLibrary] = useState<boolean>(false);
    const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY);
    const [searchQuery, setSearchQuery] = useState<string>("");

    useEffect(() => {
        getTriggers();

        rpcClient.getCommonRpcClient().isNPSupported().then((supported) => {
            setIsNPSupported(supported);
        });

        rpcClient.getBIDiagramRpcClient().getProjectStructure().then((res) => {
            const project = res.projects.find(project => isSamePath(project.projectPath, projectPath));
            if (project) {
                setIsLibrary(project.isLibrary ?? false);
            }
        });
    }, [rpcClient, projectPath]);

    const getTriggers = () => {
        if (cacheTriggers.local.length > 0) {
            setTriggers(cacheTriggers);
        } else {
            rpcClient
                .getServiceDesignerRpcClient()
                .getTriggerModels({ query: "" })
                .then((model) => {
                    console.log(">>> bi triggers", model);
                    setTriggers(model);
                    setCacheTriggers(model);
                });
        }
    };

    const title = isLibrary ? "Library Artifacts" : "Artifacts";
    const subtitle = isLibrary
        ? "Add reusable artifacts to your library"
        : "Add a new artifact to your integration";

    // Chips filter which category shows; search filters the cards within (each
    // panel self-hides when nothing in it matches). Library scope has only the
    // "Other" panel, so its chips are hidden — just the search remains.
    const showCategory = (key: string) => activeCategory === ALL_CATEGORY || activeCategory === key;
    const q = searchQuery;

    return (
        <View>
            <TopNavigationBar projectPath={projectPath} />
            <TitleBar title={title} subtitle={subtitle} />
            <ViewContent padding>
                <Container>
                    <FilterBar>
                        <ChipRow role="tablist" aria-label="Artifact categories">
                            {!isLibrary && CATEGORY_CHIPS.map((chip) => (
                                <Chip
                                    key={chip.key}
                                    role="tab"
                                    aria-selected={activeCategory === chip.key}
                                    active={activeCategory === chip.key}
                                    accent={chip.color}
                                    onClick={() => setActiveCategory(chip.key)}
                                >
                                    {chip.label}
                                </Chip>
                            ))}
                        </ChipRow>
                        <SearchSlot>
                            <SearchBox
                                value={searchQuery}
                                placeholder="Search artifacts"
                                iconPosition="end"
                                onChange={setSearchQuery}
                                sx={{ width: "100%" }}
                            />
                        </SearchSlot>
                    </FilterBar>
                    <AddPanel>
                        {!isLibrary && (
                            <>
                                {showCategory("automation") && <AutomationPanel scope={scope} searchQuery={q} />}
                                {showCategory("workflow") && <WorkflowPanel searchQuery={q} />}
                                {showCategory("ai") && <AIAgentPanel scope={scope} triggers={triggers} searchQuery={q} />}
                                {showCategory("api") && <IntegrationAPIPanel scope={scope} searchQuery={q} />}
                                {showCategory("event") && <EventIntegrationPanel triggers={triggers} scope={scope} searchQuery={q} />}
                                {showCategory("file") && <FileIntegrationPanel triggers={triggers} scope={scope} searchQuery={q} />}
                            </>
                        )}
                        {showCategory("other") && (
                            <OtherArtifactsPanel isNPSupported={isNPSupported} isLibrary={isLibrary} searchQuery={q} />
                        )}
                    </AddPanel>
                </Container>
            </ViewContent>
        </View>
    );
}
