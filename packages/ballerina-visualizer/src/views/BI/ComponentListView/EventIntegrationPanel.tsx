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
import React from 'react';
import { Icon, ImageWithFallback } from '@wso2/ui-toolkit';
import { useRpcContext } from '@wso2/ballerina-rpc-client';
import { DIRECTORY_MAP, EVENT_TYPE, MACHINE_VIEW, TriggerModelsResponse, ServiceModel, SCOPE, resolveBrandIcon, resolveKindDefaultIcon } from '@wso2/ballerina-core';

import { CardGrid, PanelViewMore, Title, TitleWrapper } from './styles';
import { BodyText } from '../../styles';
import ButtonCard from '../../../components/ButtonCard';
import { isBetaModule, matchesArtifactQuery, OutOfScopeComponentTooltip } from './componentListUtils';
import { RelativeLoader } from '../../../components/RelativeLoader';

interface EventIntegrationPanelProps {
    scope: SCOPE;
    triggers: TriggerModelsResponse;
    /** Page-level gallery search; when set, only matching cards show (Central search is a separate panel). */
    searchQuery?: string;
};

export function EventIntegrationPanel(props: EventIntegrationPanelProps) {
    const { rpcClient } = useRpcContext();
    const isDisabled = props.scope && (props.scope !== SCOPE.EVENT_INTEGRATION && props.scope !== SCOPE.ANY);
    const searchQuery = props.searchQuery ?? "";

    const handleClick = async (key: DIRECTORY_MAP, model: ServiceModel) => {
        await rpcClient.getVisualizerRpcClient().openView({
            type: EVENT_TYPE.OPEN_VIEW,
            location: {
                view: MACHINE_VIEW.BIServiceWizard,
                artifactInfo: {
                    org: model.orgName,
                    packageName: model.packageName,
                    moduleName: model.moduleName,
                    version: model.version
                }
            },
        });
    };

    const visibleTriggers = props.triggers.local
        .filter((t) => t.type === "event")
        .filter((t) => matchesArtifactQuery(searchQuery, t.name, t.moduleName));

    // While the user is searching, a section with no matches disappears entirely.
    if (searchQuery.trim() && visibleTriggers.length === 0) {
        return null;
    }

    return (
        <PanelViewMore disabled={isDisabled}>
            <TitleWrapper>
                <Title variant="h2">Event Integration</Title>
                <BodyText>
                    Create an integration that can be triggered by an event.
                </BodyText>
            </TitleWrapper>
            <CardGrid>
                {props.triggers.local.length === 0 && <RelativeLoader />}
                {
                    visibleTriggers.map((item, index) => {
                        return (
                            <ButtonCard
                                id={`trigger-${item.moduleName.replace(/\./g, '-')}`}
                                key={item.id}
                                title={item.name}
                                icon={getEntryNodeIcon(item)}
                                onClick={() => {
                                    handleClick(DIRECTORY_MAP.SERVICE, item);
                                }}
                                disabled={isDisabled}
                                tooltip={isDisabled ? OutOfScopeComponentTooltip : ""}
                                isBeta={isBetaModule(item.moduleName)}
                            />
                        );
                    }
                    )
                }
            </CardGrid>
        </PanelViewMore>
    );
};

// TODO: This should be removed once the new icons are added to the BE API.
export function getEntryNodeIcon(item: ServiceModel) {
    const brandIcon = getCustomEntryNodeIcon(item.moduleName);
    if (brandIcon) {
        return brandIcon;
    }
    const kindDefault = resolveKindDefaultIcon(item.type);
    return (
        <ImageWithFallback
            imageUrl={item.icon}
            fallbackEl={<Icon name={kindDefault.glyph} />}
            size={38}
        />
    );
}

// INFO: This is a temporary function to get the custom icon for the entry points.
// TODO: This should be removed once the new icons are added to the BE API.
export function getCustomEntryNodeIcon(type: string) {
    const brand = resolveBrandIcon(type);
    if (!brand) {
        return null;
    }
    return <Icon name={brand.glyph} sx={brand.color ? { color: brand.color } : undefined} />;
}
