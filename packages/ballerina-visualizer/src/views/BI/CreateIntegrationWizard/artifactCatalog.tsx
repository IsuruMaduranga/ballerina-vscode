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
import { ServiceModel, TriggerModelsResponse } from "@wso2/ballerina-core";

import { isBetaModule } from "../ComponentListView/componentListUtils";
import { getEntryNodeIcon } from "../ComponentListView/EventIntegrationPanel";
import { getFileIntegrationIcon } from "../ComponentListView/FileIntegrationPanel";

/** The artifact kinds the wizard can create. */
export type ArtifactKind = "automation" | "workflow" | "ai-agent" | "service";

/** Trigger types resolved dynamically via `getTriggerModels`. */
export type DynamicTriggerType = "event" | "file" | "mcp";

/**
 * A selectable artifact card in the wizard's Integration Type step.
 * Card ids, titles, icons, and artifactInfo literals mirror the in-project
 * ComponentListView panels so both surfaces stay consistent.
 */
export interface ArtifactCard {
    id: string;
    kind: ArtifactKind;
    displayName: string;
    description?: string;
    icon: ReactNode | string;
    isBeta?: boolean;
    artifactInfo?: {
        org: string;
        packageName: string;
        moduleName: string;
        version?: string;
    };
}

/** Marker expanded at render time into `triggersToCards(triggers, <type>)`. */
export type DynamicCardSource = `dynamic:${DynamicTriggerType}`;

/** An ordered category section of the Integration Type step. */
export interface ArtifactCategory {
    key: string;
    title: string;
    description: string;
    /** Short label shown in the category rail (falls back to `title`). */
    shortTitle?: string;
    /** Codicon name shown beside the rail label. */
    icon?: string;
    /** Accent color (a VS Code theme CSS var) used to tint the category chip. */
    color?: string;
    /** Static cards and/or dynamic trigger markers, in display order. */
    cards: (ArtifactCard | DynamicCardSource)[];
}

/** Mirrors AutomationPanel. */
export const AUTOMATION_CARD: ArtifactCard = {
    id: "automation",
    kind: "automation",
    displayName: "Automation",
    icon: <Icon name="bi-task" />,
};

/** Mirrors WorkflowPanel. */
export const WORKFLOW_CARD: ArtifactCard = {
    id: "workflow",
    kind: "workflow",
    displayName: "Workflow",
    icon: <Icon name="bi-flowchart" />,
};

/** Mirrors the static AI Chat Agent card in AIAgentPanel. */
export const AI_CHAT_AGENT_CARD: ArtifactCard = {
    id: "ai-agent-card",
    kind: "ai-agent",
    displayName: "AI Chat Agent",
    icon: <Icon name="bi-ai-agent" />,
};

/** Mirrors IntegrationApiPanel (gRPC intentionally excluded — disabled there too). */
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
 * Converts trigger models into artifact cards, replicating the per-panel
 * filtering, icon resolution, and beta badging:
 * - `event` mirrors EventIntegrationPanel, `mcp` mirrors the trigger cards in AIAgentPanel
 *   (dotted module names dashed in ids, `getEntryNodeIcon`, `isBetaModule` badges).
 * - `file` mirrors FileIntegrationPanel (raw module name in ids,
 *   `getFileIntegrationIcon`, no beta badge).
 *
 * @param triggers The trigger models fetched via `getTriggerModels`.
 * @param type The trigger type to include.
 * @returns The matching triggers as artifact cards, in response order.
 */
export function triggersToCards(triggers: TriggerModelsResponse, type: DynamicTriggerType): ArtifactCard[] {
    return triggers.local
        .filter((trigger) => trigger.type === type)
        .map((trigger) => triggerToCard(trigger, type));
}

function triggerToCard(item: ServiceModel, type: DynamicTriggerType): ArtifactCard {
    const artifactInfo = {
        org: item.orgName,
        packageName: item.packageName,
        moduleName: item.moduleName,
        version: item.version,
    };

    if (type === "file") {
        return {
            id: `trigger-${item.moduleName}`,
            kind: "service",
            displayName: item.name,
            icon: getFileIntegrationIcon(item),
            artifactInfo,
        };
    }

    return {
        id: `trigger-${item.moduleName.replace(/\./g, "-")}`,
        kind: "service",
        displayName: item.name,
        icon: getEntryNodeIcon(item),
        isBeta: isBetaModule(item.moduleName),
        artifactInfo,
    };
}

/**
 * The wizard's category sections, in the same order and with the same
 * titles/descriptions as the in-project ComponentListView panels.
 */
export const ARTIFACT_CATEGORIES: ArtifactCategory[] = [
    {
        key: "automation",
        title: "Automation",
        shortTitle: "Automation",
        icon: "sync",
        color: "var(--vscode-charts-blue)",
        description: "Create an automation that can be invoked periodically or manually.",
        cards: [AUTOMATION_CARD],
    },
    {
        key: "workflow",
        title: "Workflow",
        shortTitle: "Workflow",
        icon: "type-hierarchy",
        color: "var(--vscode-charts-yellow)",
        description: "Create a workflow integration.",
        cards: [WORKFLOW_CARD],
    },
    {
        key: "ai-integration",
        title: "AI Integration",
        shortTitle: "AI",
        icon: "hubot",
        color: "var(--vscode-terminal-ansiBlue)",
        description: "Create an integration that connects your system with AI capabilities.",
        cards: [AI_CHAT_AGENT_CARD, "dynamic:mcp"],
    },
    {
        key: "integration-as-api",
        title: "Integration as API",
        shortTitle: "API",
        icon: "globe",
        color: "var(--vscode-charts-green)",
        description: "Create an integration that can be exposed as an API in the specified protocol.",
        cards: [...INTEGRATION_API_CARDS],
    },
    {
        key: "event-integration",
        title: "Event Integration",
        shortTitle: "Event",
        icon: "broadcast",
        color: "var(--vscode-charts-orange)",
        description: "Create an integration that can be triggered by an event.",
        cards: ["dynamic:event"],
    },
    {
        key: "file-integration",
        title: "File Integration",
        shortTitle: "File",
        icon: "files",
        color: "var(--vscode-charts-purple)",
        description: "Create an integration that can be triggered by the availability of files in a location.",
        cards: ["dynamic:file"],
    },
];
