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

import { ReactNode } from "react";
import { Icon } from "@wso2/ui-toolkit";
import { DIRECTORY_MAP } from "@wso2/ballerina-core";

/**
 * Single source of truth for the STATIC artifact cards and the category copy
 * shared by the two artifact-picking surfaces:
 *
 * - the in-project Add-Artifact screen — `ComponentListView`'s panels, which
 *   navigate to a creation view on click; and
 * - the pre-project Create Integration wizard's type step — `IntegrationTypeStep`
 *   via `CreateIntegrationWizard/artifactCatalog.tsx`, which selects and advances.
 *
 * Both surfaces show the same cards but do different things with them, so only
 * the DATA lives here — each keeps its own layout and click behaviour. Card
 * titles are also the search keys on both surfaces, so defining them once is
 * what stops a card from being rendered but unsearchable.
 *
 * Dynamically discovered cards (event/file/MCP triggers from `getTriggerModels`)
 * are deliberately absent: they come from the language server at runtime, so both
 * surfaces already pick them up automatically and they cannot drift.
 *
 * Keep this module free of panel/step imports (data + ui-toolkit icons only) so
 * both the main and federation bundles can import it without an import cycle.
 */

/** The artifact kinds the Create Integration wizard can create. */
export type ArtifactKind = "automation" | "workflow" | "ai-agent" | "service";

/** A selectable artifact card, rendered as a `ButtonCard` on both surfaces. */
export interface ArtifactCard {
    id: string;
    kind: ArtifactKind;
    /** Card title. Doubles as the search key — see `cardMatchesSearch`. */
    displayName: string;
    description?: string;
    icon: ReactNode | string;
    isBeta?: boolean;
    /** The Ballerina module the card creates a service from, if any. */
    artifactInfo?: {
        org: string;
        packageName: string;
        moduleName: string;
        version?: string;
    };
}

export type ArtifactCategoryKey =
    | "automation"
    | "workflow"
    | "ai-integration"
    | "integration-as-api"
    | "event-integration"
    | "file-integration";

/** Heading and blurb for a category section, shown on both surfaces. */
export interface ArtifactCategoryMeta {
    key: ArtifactCategoryKey;
    title: string;
    description: string;
    /** Short label for the wizard's category rail/chips. */
    shortTitle: string;
    /** Codicon name shown beside the short label. */
    icon: string;
}

export const ARTIFACT_CATEGORY_META: Record<ArtifactCategoryKey, ArtifactCategoryMeta> = {
    automation: {
        key: "automation",
        title: "Automation",
        shortTitle: "Automation",
        icon: "sync",
        description: "Create an automation that can be invoked periodically or manually.",
    },
    workflow: {
        key: "workflow",
        title: "Workflow",
        shortTitle: "Workflow",
        icon: "type-hierarchy",
        description: "Create a workflow integration.",
    },
    "ai-integration": {
        key: "ai-integration",
        title: "AI Integration",
        shortTitle: "AI",
        icon: "hubot",
        description: "Create an integration that connects your system with AI capabilities.",
    },
    "integration-as-api": {
        key: "integration-as-api",
        title: "Integration as API",
        shortTitle: "API",
        icon: "globe",
        description: "Create an integration that can be exposed as an API in the specified protocol.",
    },
    "event-integration": {
        key: "event-integration",
        title: "Event Integration",
        shortTitle: "Event",
        icon: "broadcast",
        description: "Create an integration that can be triggered by an event.",
    },
    "file-integration": {
        key: "file-integration",
        title: "File Integration",
        shortTitle: "File",
        icon: "files",
        description: "Create an integration that can be triggered by the availability of files in a location.",
    },
};

export const AUTOMATION_CARD: ArtifactCard = {
    id: "automation",
    kind: "automation",
    displayName: "Automation",
    icon: <Icon name="bi-task" />,
};

export const WORKFLOW_CARD: ArtifactCard = {
    id: "workflow",
    kind: "workflow",
    displayName: "Workflow",
    icon: <Icon name="bi-flowchart" />,
};

export const AI_CHAT_AGENT_CARD: ArtifactCard = {
    id: "ai-agent-card",
    kind: "ai-agent",
    displayName: "AI Chat Agent",
    icon: <Icon name="bi-ai-agent" />,
};

/** TODO: Add the gRPC service card once gRPC support is working. */
export const INTEGRATION_API_CARDS: ArtifactCard[] = [
    {
        id: "http-service-card",
        kind: "service",
        displayName: "HTTP Service",
        icon: <Icon name="bi-globe" />,
        artifactInfo: {
            org: "ballerina",
            packageName: "http",
            moduleName: "http",
        },
    },
    {
        id: "graphql-service-card",
        kind: "service",
        displayName: "GraphQL Service",
        icon: <Icon name="bi-graphql" sx={{ color: "#e535ab" }} />,
        isBeta: true,
        artifactInfo: {
            org: "ballerina",
            packageName: "graphql",
            moduleName: "graphql",
        },
    },
    {
        id: "tcp-service-card",
        kind: "service",
        displayName: "TCP Service",
        icon: <Icon name="bi-tcp" />,
        isBeta: true,
        artifactInfo: {
            org: "ballerina",
            packageName: "tcp",
            moduleName: "tcp",
        },
    },
];

/**
 * A supporting artifact (function, type, connection, …). These exist only inside
 * an already-open package, so the pre-project wizard cannot offer them — they are
 * rendered by `OtherArtifactsPanel` alone, and live here so all card data
 * (and every search key) has one home.
 */
export interface OtherArtifactCard {
    id: string;
    /** Card title. Doubles as the search key. */
    displayName: string;
    icon: ReactNode;
    /** Selects the creation view to open — see `OtherArtifactsPanel`. */
    directoryKey: DIRECTORY_MAP;
    isBeta?: boolean;
    /** Shown only when natural-programming support and experimental mode are on. */
    requiresNaturalFunctions?: boolean;
}

export const OTHER_ARTIFACT_CARDS: OtherArtifactCard[] = [
    {
        id: "bi-function",
        displayName: "Function",
        icon: <Icon name="bi-function" />,
        directoryKey: DIRECTORY_MAP.FUNCTION,
    },
    {
        id: "bi-ai-function",
        displayName: "Natural Function",
        icon: <Icon name="bi-ai-function" />,
        directoryKey: DIRECTORY_MAP.NP_FUNCTION,
        isBeta: true,
        requiresNaturalFunctions: true,
    },
    {
        id: "data-mapper",
        displayName: "Data Mapper",
        icon: <Icon name="dataMapper" />,
        directoryKey: DIRECTORY_MAP.DATA_MAPPER,
    },
    {
        id: "type",
        displayName: "Type",
        icon: <Icon name="bi-type" />,
        directoryKey: DIRECTORY_MAP.TYPE,
    },
    {
        id: "connection",
        displayName: "Connection",
        icon: <Icon name="bi-connection" />,
        directoryKey: DIRECTORY_MAP.CONNECTION,
    },
    {
        id: "configurable",
        displayName: "Configuration",
        icon: <Icon name="bi-config" />,
        directoryKey: DIRECTORY_MAP.CONFIGURABLE,
    },
];
