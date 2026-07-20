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

import { useMemo, type KeyboardEvent } from "react";
import styled from "@emotion/styled";
import { ThemeColors, Typography } from "@wso2/ui-toolkit";
import { TriggerModelsResponse } from "@wso2/ballerina-core";
import ButtonCard from "../../../../components/ButtonCard";
import { RelativeLoader } from "../../../../components/RelativeLoader";
import {
    ARTIFACT_CATEGORIES,
    ArtifactCard,
    DynamicCardSource,
    DynamicTriggerType,
    triggersToCards,
} from "../artifactCatalog";

const CategorySection = styled.div`
    margin-bottom: 16px;
`;

const CategoryTitle = styled(Typography)`
    margin: 0;
    font-size: 13px;
    font-weight: 600;
`;

const CategoryDescription = styled(Typography)`
    margin: 0 0 8px 0;
    font-size: 11px;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
`;

const CardGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;

    /* Compact the ButtonCards (the card root carries the function-card testid). */
    div[data-testid^="function-card-"] {
        padding: 6px 12px;
    }
`;

const LoaderRow = styled.div`
    display: flex;
    align-items: center;
    padding: 8px 0;
`;

interface ArtifactTypeStepProps {
    /** Trigger models fetched once by the wizard root; null while loading. */
    triggers: TriggerModelsResponse | null;
    selection: ArtifactCard | null;
    onSelect: (card: ArtifactCard) => void;
}

/**
 * Step 2 — the artifact category grid. Mirrors the in-project artifacts panel
 * (ComponentListView) but SELECTS a card instead of navigating; the highlight
 * uses ButtonCard's built-in `active` state.
 */
const ARROW_KEY_DELTAS: Record<string, number> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
};

export function ArtifactTypeStep({ triggers, selection, onSelect }: ArtifactTypeStepProps) {
    const resolveCards = (cards: (ArtifactCard | DynamicCardSource)[]): { cards: ArtifactCard[]; loading: boolean } => {
        const resolved: ArtifactCard[] = [];
        let loading = false;
        for (const entry of cards) {
            if (typeof entry === "string") {
                if (!triggers) {
                    loading = true;
                    continue;
                }
                const type = entry.split(":")[1] as DynamicTriggerType;
                resolved.push(...triggersToCards(triggers, type));
            } else {
                resolved.push(entry);
            }
        }
        return { cards: resolved, loading };
    };

    const categories = ARTIFACT_CATEGORIES.map((category) => ({
        category,
        ...resolveCards(category.cards),
    }));

    // Flat, category-ordered list of every card actually rendered, used to move
    // focus between cards (including across category boundaries) with arrow keys.
    const allCards = useMemo(
        () => categories.flatMap(({ cards }) => cards),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [triggers]
    );

    /** Moves focus to the previous/next card in display order on arrow keys;
     *  Tab/Shift+Tab and Enter/Space (card selection) are left to the browser
     *  and ButtonCard respectively. */
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const delta = ARROW_KEY_DELTAS[event.key];
        if (delta === undefined || allCards.length === 0) {
            return;
        }
        const currentId = (event.target as HTMLElement)?.id;
        const currentIndex = allCards.findIndex((card) => card.id === currentId);
        if (currentIndex === -1) {
            return;
        }
        event.preventDefault();
        const nextIndex = (currentIndex + delta + allCards.length) % allCards.length;
        document.getElementById(allCards[nextIndex].id)?.focus();
    };

    return (
        <div onKeyDown={handleKeyDown}>
            {categories.map(({ category, cards, loading }) => (
                <CategorySection key={category.key}>
                    <CategoryTitle variant="h4">{category.title}</CategoryTitle>
                    <CategoryDescription variant="body3">{category.description}</CategoryDescription>
                    {cards.length > 0 && (
                        <CardGrid>
                            {cards.map((card) => (
                                <ButtonCard
                                    key={card.id}
                                    id={card.id}
                                    title={card.displayName}
                                    icon={card.icon}
                                    isBeta={card.isBeta}
                                    active={selection?.id === card.id}
                                    truncate={true}
                                    onClick={() => onSelect(card)}
                                />
                            ))}
                        </CardGrid>
                    )}
                    {loading && (
                        <LoaderRow>
                            <RelativeLoader />
                        </LoaderRow>
                    )}
                </CategorySection>
            ))}
        </div>
    );
}
