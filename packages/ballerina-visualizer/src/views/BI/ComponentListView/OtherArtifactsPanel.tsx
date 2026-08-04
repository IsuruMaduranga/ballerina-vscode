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
import React, { useEffect, useState } from 'react';
import { Icon } from '@wso2/ui-toolkit';
import { useRpcContext } from '@wso2/ballerina-rpc-client';
import { DIRECTORY_MAP, EVENT_TYPE, MACHINE_VIEW } from '@wso2/ballerina-core';

import { CardGrid, PanelViewMore, Title, TitleWrapper } from './styles';
import { BodyText } from '../../styles';
import ButtonCard from '../../../components/ButtonCard';
import { useVisualizerContext } from '../../../Context';
import { matchesArtifactQuery } from './componentListUtils';

interface OtherArtifactsPanelProps {
    isNPSupported: boolean;
    isLibrary?: boolean;
    /** Page-level gallery search; when set, only matching cards show. */
    searchQuery?: string;
}

export function OtherArtifactsPanel(props: OtherArtifactsPanelProps) {
    const { isNPSupported, isLibrary = false, searchQuery = "" } = props;
    const { rpcClient } = useRpcContext();
    const { setPopupMessage } = useVisualizerContext();
    const [experimentalEnabled, setExperimentalEnabled] = useState(false);

    useEffect(() => {
        rpcClient.getCommonRpcClient().experimentalEnabled().then(setExperimentalEnabled);
    }, [rpcClient]);

    const showNaturalFunctions = isNPSupported && experimentalEnabled;

    const panelTitle = isLibrary ? "Library Artifacts" : "Other Artifacts";
    const panelDescription = isLibrary
        ? "Create reusable artifacts for your library."
        : "Create supportive artifacts for your integration.";

    const handleClick = async (key: DIRECTORY_MAP) => {
        if (key === DIRECTORY_MAP.CONNECTION) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.AddConnectionWizard,
                },
                isPopup: true,
            });
        } else if (key === DIRECTORY_MAP.DATA_MAPPER) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.BIDataMapperForm,
                },
            });
        } else if (key === DIRECTORY_MAP.TYPE) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.TypeDiagram,
                    addType: true
                },
            });
        } else if (key === DIRECTORY_MAP.CONFIGURABLE) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.AddConfigVariables,
                },
            });
        } else if (key === DIRECTORY_MAP.FUNCTION) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.BIFunctionForm,
                },
            });
        } else if (key === DIRECTORY_MAP.NP_FUNCTION) {
            await rpcClient.getVisualizerRpcClient().openView({
                type: EVENT_TYPE.OPEN_VIEW,
                location: {
                    view: MACHINE_VIEW.BINPFunctionForm,
                },
            });
        } else {
            setPopupMessage(true);
        }
    };

    const cards = [
        { id: "bi-function", testId: "function", icon: "bi-function", title: "Function", key: DIRECTORY_MAP.FUNCTION, isBeta: false, show: true },
        { id: "bi-ai-function", icon: "bi-ai-function", title: "Natural Function", key: DIRECTORY_MAP.NP_FUNCTION, isBeta: true, show: showNaturalFunctions },
        { id: "data-mapper", icon: "dataMapper", title: "Data Mapper", key: DIRECTORY_MAP.DATA_MAPPER, isBeta: false, show: true },
        { id: "type", icon: "bi-type", title: "Type", key: DIRECTORY_MAP.TYPE, isBeta: false, show: true },
        { id: "connection", icon: "bi-connection", title: "Connection", key: DIRECTORY_MAP.CONNECTION, isBeta: false, show: true },
        { id: "configurable", icon: "bi-config", title: "Configuration", key: DIRECTORY_MAP.CONFIGURABLE, isBeta: false, show: true },
    ].filter((card) => card.show && matchesArtifactQuery(searchQuery, card.title));

    // While the user is searching, a section with no matches disappears entirely.
    if (searchQuery.trim() && cards.length === 0) {
        return null;
    }

    return (
        <PanelViewMore>
            <TitleWrapper>
                <Title variant="h2">{panelTitle}</Title>
                <BodyText>
                    {panelDescription}
                </BodyText>
            </TitleWrapper>
            <CardGrid>
                {cards.map((card) => (
                    <ButtonCard
                        key={card.id}
                        id={card.id}
                        data-testid={card.testId}
                        icon={<Icon name={card.icon} />}
                        title={card.title}
                        onClick={() => handleClick(card.key)}
                        isBeta={card.isBeta}
                    />
                ))}
            </CardGrid>
        </PanelViewMore>
    );
};
