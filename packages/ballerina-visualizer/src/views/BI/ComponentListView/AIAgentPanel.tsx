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

import { Icon } from "@wso2/ui-toolkit";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import {
    DIRECTORY_MAP,
    EVENT_TYPE,
    MACHINE_VIEW,
    SCOPE,
    ServiceModel,
    TriggerModelsResponse,
} from "@wso2/ballerina-core";

import { CardGrid, PanelViewMore, Title, TitleWrapper } from "./styles";
import { BodyText } from "../../styles";
import ButtonCard from "../../../components/ButtonCard";
import { cardMatchesSearch, isBetaModule, OutOfScopeComponentTooltip } from "./componentListUtils";
import { RelativeLoader } from "../../../components/RelativeLoader";
import { getEntryNodeIcon } from "./EventIntegrationPanel";

interface AIAgentPanelProps {
    scope: SCOPE;
    triggers: TriggerModelsResponse;
    searchQuery?: string;
}

export function AIAgentPanel(props: AIAgentPanelProps) {
    const { rpcClient } = useRpcContext();
    const isDisabled = props.scope && props.scope !== SCOPE.AI_AGENT && props.scope !== SCOPE.ANY;
    const q = props.searchQuery;
    const mcpTriggers = props.triggers.local.filter((t) => t.type === "mcp" && cardMatchesSearch(t.name, q));
    const agentMatches = cardMatchesSearch("AI Chat Agent", q);

    const handleMcpClick = async (key: DIRECTORY_MAP, model: ServiceModel) => {
        console.log(">>>>> Model: ", model);
        await rpcClient.getVisualizerRpcClient().openView({
            type: EVENT_TYPE.OPEN_VIEW,
            location: {
                view: MACHINE_VIEW.BIServiceWizard,
                artifactInfo: {
                    org: model.orgName,
                    packageName: model.packageName,
                    moduleName: model.moduleName,
                    version: model.version,
                },
            },
        });
    };

    const handleClick = async () => {
        await rpcClient.getVisualizerRpcClient().openView({
            type: EVENT_TYPE.OPEN_VIEW,
            location: {
                view: MACHINE_VIEW.AIChatAgentWizard,
            },
        });
    };

    // While searching, hide the whole panel when nothing here matches.
    if (q?.trim() && !agentMatches && mcpTriggers.length === 0) {
        return null;
    }

    return (
        <PanelViewMore disabled={isDisabled}>
            <TitleWrapper>
                <Title variant="h2">AI Integration</Title>
                <BodyText>Create an integration that connects your system with AI capabilities.</BodyText>
            </TitleWrapper>
            <CardGrid>
                {agentMatches && <ButtonCard
                    id="ai-agent-card"
                    icon={<Icon name="bi-ai-agent" />}
                    title="AI Chat Agent"
                    onClick={handleClick}
                    disabled={isDisabled}
                    tooltip={isDisabled ? OutOfScopeComponentTooltip : ""}
                />}
                {!q?.trim() && props.triggers.local.length === 0 && <RelativeLoader />}
                {mcpTriggers
                    .map((item, index) => {
                        return (
                            <ButtonCard
                                id={`trigger-${item.moduleName.replace(/\./g, "-")}`}
                                key={item.id}
                                title={item.name}
                                icon={getEntryNodeIcon(item)}
                                onClick={() => {
                                    handleMcpClick(DIRECTORY_MAP.SERVICE, item);
                                }}
                                disabled={isDisabled}
                                tooltip={isDisabled ? OutOfScopeComponentTooltip : ""}
                                isBeta={isBetaModule(item.moduleName)}
                            />
                        );
                    })}
            </CardGrid>
        </PanelViewMore>
    );
}
