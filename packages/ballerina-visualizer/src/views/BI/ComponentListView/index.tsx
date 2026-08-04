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
import { AddPanel, Container } from "./styles";
import { AutomationPanel } from "./AutomationPanel";
import { CentralSearchPanel } from "./CentralSearchPanel";
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

export function ComponentListView(props: ComponentListViewProps) {
    const { projectPath, scope } = props;
    const { rpcClient } = useRpcContext();
    const [triggers, setTriggers] = useState<TriggerModelsResponse>({ local: [] });
    const { cacheTriggers, setCacheTriggers } = useVisualizerContext();
    const [isNPSupported, setIsNPSupported] = useState<boolean>(false);
    const [isLibrary, setIsLibrary] = useState<boolean>(false);
    // Page-level gallery search: filters every section's cards in place and, while active, adds a
    // "More on Ballerina Central" section — results there can belong to any category, which is why
    // search lives here rather than inside one section.
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

    return (
        <View>
            <TopNavigationBar projectPath={projectPath} />
            <TitleBar title={title} subtitle={subtitle} />
            <ViewContent padding>
                <Container>
                    <AddPanel>
                        {!isLibrary && (
                            <SearchBox
                                placeholder="Search artifacts (e.g. Kafka, Salesforce, FTP)"
                                value={searchQuery}
                                onChange={setSearchQuery}
                                iconPosition="start"
                                aria-label="search-artifacts"
                                data-testid="artifact-search-input"
                                sx={{ width: '100%' }}
                            />
                        )}
                        {!isLibrary && (
                            <>
                                <AutomationPanel scope={scope} searchQuery={searchQuery} />
                                <WorkflowPanel />
                                <AIAgentPanel scope={scope} triggers={triggers} searchQuery={searchQuery} />
                                <IntegrationAPIPanel scope={scope} searchQuery={searchQuery} />
                                <EventIntegrationPanel triggers={triggers} scope={scope} searchQuery={searchQuery} />
                                <FileIntegrationPanel triggers={triggers} scope={scope} searchQuery={searchQuery} />
                                {searchQuery.trim() && <CentralSearchPanel query={searchQuery} triggers={triggers} />}
                            </>
                        )}
                        <OtherArtifactsPanel
                            isNPSupported={isNPSupported}
                            isLibrary={isLibrary}
                            searchQuery={isLibrary ? "" : searchQuery}
                        />
                    </AddPanel>
                </Container>
            </ViewContent>
        </View>
    );
}
