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

import { useEffect, useMemo, useState } from "react";
import { Codicon, Icon, RadioButtonGroup, SearchBox, ThemeColors, View, ViewContent } from "@wso2/ui-toolkit";
import styled from "@emotion/styled";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { FormField, FormImports, FormValues, Parameter } from "@wso2/ballerina-side-panel";
import { LineRange, FunctionParameter, TestFunction, ValueProperty, Annotation, getPrimaryInputType, EvalsetItem, AvailableNode, FlowNode, Property as FlowProperty } from "@wso2/ballerina-core";
import { EVENT_TYPE } from "@wso2/ballerina-core";
import { TitleBar } from "../../../components/TitleBar";
import { TopNavigationBar } from "../../../components/TopNavigationBar";
import { FormHeader } from "../../../components/FormHeader";
import ArtifactForm from "../Forms/ArtifactForm";
import { convertNodePropertyToFormField, getImportsForProperty } from "../../../utils/bi";
import { CardSelector } from "./CardSelector";

const FormContainer = styled.div`
    display: flex;
    flex-direction: column;
    max-width: 600px;
    margin-bottom: 20px;

    .side-panel-body {
        overflow: visible;
    }

    .radio-button-group {
        margin-top: 8px;
        margin-bottom: -12px;
    }

    .dropdown-container {
        margin-top: 12px;
    }
`;

const Container = styled.div`
    display: "flex";
    flex-direction: "column";
    gap: 10px;
`;

const FullHeightView = styled(View)`
    display: flex;
    flex-direction: column;
    height: 100vh;
`;

const FullHeightViewContent = styled(ViewContent)`
    display: flex;
    flex: 1;
`;

const UpgradeMessageContainer = styled.div`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    width: 100%;
    padding: 40px;
    text-align: center;
`;

const UpgradeTitle = styled.h2`
    color: var(--vscode-foreground);
    font-size: 18px;
    font-weight: 500;
    margin: 0 0 12px 0;
    line-height: 1.4;
`;

const UpgradeMessage = styled.p`
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
    margin: 0;
    max-width: 500px;
    line-height: 1.6;
`;

const EmptyEvalsetContainer = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    margin-top: 12px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
`;

const EmptyEvalsetTitle = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-foreground);
    font-size: 13px;
    font-weight: 500;
`;

const EmptyEvalsetMessage = styled.div`
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.5;
`;

const TemplatePicker = styled.div`
    align-self: stretch;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
`;

const TemplatePickerButton = styled.button<{ selected: boolean }>`
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px;
    text-align: left;
    font-family: inherit;
    color: var(--vscode-foreground);
    border: 1px solid ${(props: { selected: boolean }) => props.selected ? 'var(--vscode-button-background)' : 'var(--vscode-panel-border)'};
    border-radius: 8px;
    background-color: ${(props: { selected: boolean }) => props.selected ? 'color-mix(in srgb, var(--vscode-button-background) 5%, transparent)' : 'transparent'};
    cursor: pointer;
    transition: all 0.2s ease;

    &:hover, &:focus-visible {
        border-color: var(--vscode-button-background);
        background-color: ${(props: { selected: boolean }) => props.selected ? 'color-mix(in srgb, var(--vscode-button-background) 7%, transparent)' : 'color-mix(in srgb, var(--vscode-button-background) 5%, transparent)'};
        outline: none;
    }
`;

const TemplatePickerIcon = styled.div<{ selected: boolean }>`
    display: grid;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 8px;
    color: ${(props: { selected: boolean }) => props.selected ? ThemeColors.ON_PRIMARY : ThemeColors.ON_SURFACE_VARIANT};
    background: ${(props: { selected: boolean }) => props.selected ? ThemeColors.PRIMARY : ThemeColors.SURFACE_CONTAINER};
`;

const TemplatePickerCopy = styled.span`
    min-width: 0;
    flex: 1;
`;

const TemplatePickerTitle = styled.span`
    display: block;
    font-size: 13px;
    font-weight: 600;
`;

const TemplatePickerDescription = styled.span`
    display: block;
    margin-top: 2px;
    overflow: hidden;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const EvalsetModeSelector = styled.div`
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin-top: 16px;
`;

const TestInputSection = styled.div`
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin-top: 16px;
`;

const TestInputLabel = styled.div`
    color: var(--vscode-foreground);
    font-size: 13px;
    font-weight: 600;
`;

const TestInputHint = styled.div`
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
`;

const TemplatePickerAction = styled.span`
    color: var(--vscode-button-background);
    font-size: 13px;
    font-weight: 500;
`;

const TemplatePickerTitleRow = styled.span`
    display: flex;
    align-items: center;
    gap: 8px;
`;

const Badge = styled.span`
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
    border-radius: 4px;
    background: ${ThemeColors.SURFACE_CONTAINER};
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
`;

const TemplateConfigDivider = styled.div`
    width: 100%;
    height: 1px;
    margin-top: 16px;
    background: var(--vscode-input-border, var(--vscode-panel-border));
`;

const TemplateModalBackdrop = styled.div`
    position: fixed;
    z-index: 30000;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background-color: color-mix(in srgb, ${ThemeColors.SECONDARY_CONTAINER} 80%, transparent);
`;

const TemplateModal = styled.div`
    display: flex;
    width: 80%;
    max-width: 900px;
    height: min(80vh, 680px);
    min-height: 460px;
    flex-direction: column;
    overflow: hidden;
    border-radius: 10px;
    background: ${ThemeColors.SURFACE_BRIGHT};
    box-shadow: 0 4px 20px rgb(0 0 0 / 0.3);
    font-family: var(--vscode-font-family);
    z-index: 30001;
`;

const TemplateModalHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid ${ThemeColors.OUTLINE_VARIANT};
`;

const TemplateModalTitle = styled.h3`
    margin: 0;
    color: ${ThemeColors.ON_SURFACE};
    font-size: 20px;
    font-weight: 600;
`;

const TemplateModalCount = styled.p`
    margin: 2px 0 0;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
    font-size: 12px;
`;

const ModalIconButton = styled.button`
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    font-family: inherit;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
    border: 0;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;

    &:hover, &:focus-visible {
        color: ${ThemeColors.ON_SURFACE};
        background: ${ThemeColors.SURFACE_CONTAINER};
        outline: none;
    }
`;

const TemplateModalControls = styled.div`
    padding: 16px 20px;
    border-bottom: 1px solid ${ThemeColors.OUTLINE_VARIANT};
`;

const TemplateSearch = styled(SearchBox)`
    width: 100%;
`;

const TemplateFilters = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 12px;
`;

const TemplateFilter = styled.button<{ active: boolean }>`
    height: 28px;
    padding: 0 12px;
    color: ${(props: { active: boolean }) => props.active ? ThemeColors.ON_PRIMARY : ThemeColors.ON_SURFACE_VARIANT};
    border: 1px solid ${(props: { active: boolean }) => props.active ? ThemeColors.PRIMARY : ThemeColors.OUTLINE_VARIANT};
    border-radius: 4px;
    background: ${(props: { active: boolean }) => props.active ? ThemeColors.PRIMARY : 'transparent'};
    font-family: inherit;
    font-size: 12px;
    font-weight: ${(props: { active: boolean }) => props.active ? 600 : 400};
    cursor: pointer;

    &:hover {
        color: ${(props: { active: boolean }) => props.active ? ThemeColors.ON_PRIMARY : ThemeColors.ON_SURFACE};
        border-color: ${(props: { active: boolean }) => props.active ? ThemeColors.PRIMARY : ThemeColors.OUTLINE};
        background: ${(props: { active: boolean }) => props.active ? ThemeColors.PRIMARY : ThemeColors.SURFACE_CONTAINER};
    }
`;

const TemplateResults = styled.div`
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 20px;
`;

const TemplateResultsGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    @media (max-width: 700px) {
        grid-template-columns: 1fr;
    }
`;

const TemplateOption = styled.button<{ selected: boolean }>`
    display: flex;
    align-items: flex-start;
    gap: 12px;
    text-align: left;
    font-family: inherit;
    background: ${(props: { selected: boolean }) => props.selected
        ? ThemeColors.PRIMARY_CONTAINER
        : ThemeColors.SURFACE_DIM};
    color: ${ThemeColors.ON_SURFACE};
    border: 1px solid ${(props: { selected: boolean }) => props.selected ? ThemeColors.PRIMARY : ThemeColors.OUTLINE_VARIANT};
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;

    &:hover, &:focus-visible {
        border-color: ${ThemeColors.PRIMARY};
        background: ${ThemeColors.PRIMARY_CONTAINER};
        outline: none;
    }
`;

const TemplateOptionIcon = styled.div<{ selected: boolean }>`
    display: grid;
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 8px;
    color: ${(props: { selected: boolean }) => props.selected ? ThemeColors.ON_PRIMARY : ThemeColors.ON_SURFACE_VARIANT};
    background: ${(props: { selected: boolean }) => props.selected ? ThemeColors.PRIMARY : ThemeColors.SURFACE_CONTAINER};
`;

const TemplateOptionBody = styled.div`
    min-width: 0;
    flex: 1;
`;

const TemplateOptionHeading = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 14px;
    font-weight: 600;
`;

const TemplateTags = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
`;

const TemplateOptionDescription = styled.p`
    margin: 10px 0 0;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
    font-size: 12px;
    line-height: 1.45;
`;

const EmptyTemplates = styled.div`
    display: grid;
    min-height: 240px;
    place-items: center;
    color: ${ThemeColors.ON_SURFACE_VARIANT};
    text-align: center;
`;

type TemplateFilterKind = 'all' | 'rule-based' | 'llm-as-judge' | 'uses-evalset' | 'no-evalset';

const getTemplateKind = (template: AvailableNode): string => {
    const kind = String(template.codedata.data?.kind || 'RULE_BASED').toUpperCase();
    if (kind.includes('LLM')) {
        return 'LLM-as-Judge';
    }
    if (kind.includes('RULE')) {
        return 'Rule-based';
    }
    return kind.replace(/_/g, '-');
};

const templateNeedsEvalset = (template?: AvailableNode): boolean =>
    String(template?.codedata.data?.needsEvalset) === 'true';

const AI_AGENT_TYPE = 'ai:Agent';

// Stamp the built-in ai:Agent coordinates that the shared enrichAgentField helper reads, so an agent
// parameter renders as the connection-select editor (dropdown of existing agents + expression fallback).
const withAgentConnectionData = (property: FlowProperty): FlowProperty => {
    const isAgent = property.types?.some(type => type.ballerinaType?.includes(AI_AGENT_TYPE));
    if (!isAgent || (property.codedata?.data as any)?.agent) {
        return property;
    }
    return {
        ...property,
        codedata: {
            ...(property.codedata || {}),
            data: {
                ...((property.codedata?.data as any) || {}),
                agent: { node: 'AGENT', org: 'ballerina', packageName: 'ai', module: 'ai', object: 'Agent' }
            }
        }
    } as FlowProperty;
};

const findDataSourceParam = (node: FlowNode): { paramName: string; kind: 'union' | 'strict' } | undefined => {
    for (const [key, property] of Object.entries(node.properties || {})) {
        const data = (property as FlowProperty).codedata?.data as { dataSourceParam?: boolean; dataSourceKind?: string } | undefined;
        if (data?.dataSourceParam) {
            return {
                paramName: (property as FlowProperty).codedata?.originalName || key,
                kind: data.dataSourceKind === 'union' ? 'union' : 'strict'
            };
        }
    }
    return undefined;
};

const isBaseField = (field: FormField): boolean =>
    !field.key.startsWith('template_') && field.key !== 'evalQueries';

const buildQueriesField = (): FormField => ({
    key: 'evalQueries',
    label: 'Queries',
    type: 'TEXT_SET',
    optional: false,
    editable: true,
    enabled: true,
    advanced: false,
    hidden: true,
    documentation: 'Each query runs as a separate test case; Minimum Pass Rate applies across them.',
    value: [],
    types: [{ fieldType: 'TEXT_SET', selected: false }]
} as FormField);

const TEMPLATE_ICON_RULES: Array<[RegExp, string]> = [
    [/safe|safety|moderat|prohibit|harm/, 'shield'],
    [/latency|perform|speed|duration|time/, 'watch'],
    [/token|budget|cost/, 'dashboard'],
    [/iteration|step|path|efficien/, 'milestone'],
    [/tool|trajector/, 'tools'],
    [/exact|contains|match|semantic|similar/, 'target'],
    [/coheren|reason|logic|flow/, 'graph'],
    [/ground|context|relevan|accura|factual|correct/, 'verified'],
    [/clarity|concise|tone|helpful|readab/, 'sparkle'],
    [/complete|coverage|instruction|follow|checklist/, 'checklist'],
];

const getTemplateIcon = (template?: AvailableNode): string => {
    const text = `${template?.metadata.label || ''} ${String(template?.codedata.data?.kind || '')}`.toLowerCase();
    for (const [pattern, icon] of TEMPLATE_ICON_RULES) {
        if (pattern.test(text)) {
            return icon;
        }
    }
    return 'beaker';
};

const matchesTemplateFilter = (template: AvailableNode, filter: TemplateFilterKind): boolean => {
    if (filter === 'all') {
        return true;
    }
    if (filter === 'uses-evalset') {
        return templateNeedsEvalset(template);
    }
    if (filter === 'no-evalset') {
        return !templateNeedsEvalset(template);
    }
    return getTemplateKind(template).toLowerCase() === filter;
};

interface TestFunctionDefProps {
    projectPath: string;
    functionName?: string;
    filePath?: string;
    serviceType?: string;
    isVersionSupported?: boolean;
}

export function AIEvaluationForm(props: TestFunctionDefProps) {
    const { projectPath, functionName, filePath, serviceType, isVersionSupported = true } = props;
    const { rpcClient } = useRpcContext();
    const [formFields, setFormFields] = useState<FormField[]>([]);
    const [testFunction, setTestFunction] = useState<TestFunction>();
    const [formTitle, setFormTitle] = useState<string>('Create New AI Evaluation');
    const [formSubtitle, setFormSubtitle] = useState<string>('Create a new AI evaluation for your integration');
    const [targetLineRange, setTargetLineRange] = useState<LineRange>();
    const [dataProviderMode, setDataProviderMode] = useState<string>('template');
    const [customUsesEvalset, setCustomUsesEvalset] = useState(false);
    const [evalsetOptions, setEvalsetOptions] = useState<Array<{ value: string; content: string }>>([]);
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [selectedEvalsetFile, setSelectedEvalsetFile] = useState<string>('');
    const [evalsetsLoaded, setEvalsetsLoaded] = useState<boolean>(false);
    const [evalsetsLoadError, setEvalsetsLoadError] = useState<boolean>(false);
    const [evalTemplates, setEvalTemplates] = useState<AvailableNode[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<AvailableNode>();
    const [templateNode, setTemplateNode] = useState<FlowNode>();
    const [showTemplatePicker, setShowTemplatePicker] = useState(false);
    const [templateQuery, setTemplateQuery] = useState('');
    const [templateFilter, setTemplateFilter] = useState<TemplateFilterKind>('all');
    const [templateLoadError, setTemplateLoadError] = useState<string>();
    const [dataSourceMode, setDataSourceMode] = useState<'evalset' | 'queries'>('evalset');
    const dataSourceParam = useMemo(
        () => (templateNode ? findDataSourceParam(templateNode) : undefined),
        [templateNode]);

    const applyFieldVisibility = (fields: FormField[], mode: string,
        dsParam = dataSourceParam, dsMode = dataSourceMode): FormField[] => {
        return fields.map(field => {
            if (field.key.startsWith('template_')) {
                return { ...field, hidden: mode !== 'template' };
            }
            if (field.key === 'dataProvider') {
                return { ...field, hidden: mode !== 'function' };
            }
            if (field.key === 'evalSetFile') {
                const hasValue = !!field.value;
                const templateEvalset = mode === 'template' && !!dsParam && dsMode === 'evalset';
                const hidden = (mode !== 'evalSet' && !templateEvalset)
                    || (evalsetOptions.length === 0 && !hasValue);
                return { ...field, hidden };
            }
            if (field.key === 'evalQueries') {
                return { ...field, hidden: !(mode === 'template' && dsParam?.kind === 'union' && dsMode === 'queries') };
            }
            if (field.key === 'runs') {
                return { ...field };
            }
            return field;
        });
    };

    const handleFieldChange = (fieldKey: string, value: any) => {
        if (fieldKey === 'dataProviderMode') {
            setDataProviderMode(value);
            setCustomUsesEvalset(value === 'evalSet');
            updateFieldVisibility(value);
        }
        if (fieldKey === 'evalSetFile') {
            setSelectedEvalsetFile(value || '');
        }
    };

    const handleDataSourceModeChange = (mode: 'evalset' | 'queries') => {
        setDataSourceMode(mode);
        setFormFields(prev => applyFieldVisibility(prev, 'template', dataSourceParam, mode));
    };

    const updateFieldVisibility = (mode: string) => {
        setFormFields(prevFields => applyFieldVisibility(prevFields, mode));
    };

    const updateTargetLineRange = () => {
        rpcClient
            .getBIDiagramRpcClient()
            .getEndOfFile({ filePath })
            .then((linePosition) => {
                setTargetLineRange({
                    startLine: linePosition,
                    endLine: linePosition
                });
            });
    }

    useEffect(() => {
        loadEvalsets();
        loadEvalTemplates();
    }, []);

    useEffect(() => {
        if (!showTemplatePicker) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowTemplatePicker(false);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [showTemplatePicker]);

    const loadEvalTemplates = async () => {
        try {
            const res = await rpcClient.getBIDiagramRpcClient().search({ filePath, searchKind: 'EVAL_TEMPLATE' });
            const templates = res.categories.flatMap(category => category.items)
                .filter((item): item is AvailableNode => 'codedata' in item);
            setEvalTemplates(templates);
            setTemplateLoadError(undefined);
        } catch (error) {
            console.error('Failed to load evaluation templates:', error);
            setEvalTemplates([]);
            setTemplateLoadError('Unable to load evaluation templates. Check that the local ai_evals package is installed.');
        }
    };

    const selectEvalTemplate = async (template: AvailableNode) => {
        try {
            const res = await rpcClient.getBIDiagramRpcClient().getNodeTemplate({
                filePath,
                position: { line: 0, offset: 0 },
                id: template.codedata
            });
            const node = res.flowNode;
            const dsParam = findDataSourceParam(node);
            const mode: 'evalset' | 'queries' =
                dsParam?.kind === 'union' ? (evalsetOptions.length > 0 ? 'evalset' : 'queries') : 'evalset';
            setSelectedTemplate(template);
            setTemplateNode(node);
            setDataSourceMode(mode);
            setShowTemplatePicker(false);
            setTemplateLoadError(undefined);
            setDataProviderMode('template');
            setFormFields(current => {
                const base = current.filter(isBaseField);
                let withDataSource = base;
                if (dsParam) {
                    const idx = base.findIndex(field => field.key === 'evalSetFile');
                    withDataSource = idx >= 0
                        ? [...base.slice(0, idx + 1), buildQueriesField(), ...base.slice(idx + 1)]
                        : [...base, buildQueriesField()];
                }
                const next = [...withDataSource, ...generateTemplateFields(node)];
                return applyFieldVisibility(next, 'template', dsParam, mode);
            });
        } catch (error) {
            console.error('Failed to load evaluation template form:', error);
            setTemplateLoadError('Unable to load the selected template. Please try again.');
        }
    };

    const filteredTemplates = useMemo(() => {
        const query = templateQuery.trim().toLowerCase();
        return evalTemplates.filter(template => {
            const text = [template.metadata.label, template.metadata.description, getTemplateKind(template)]
                .join(' ').toLowerCase();
            return matchesTemplateFilter(template, templateFilter) && (!query || text.includes(query));
        });
    }, [evalTemplates, templateFilter, templateQuery]);

    useEffect(() => {
        if (serviceType === 'UPDATE_TEST') {
            setFormTitle('Update AI Evaluation');
            setFormSubtitle('Update an existing AI evaluation');
            loadFunction();
        } else {
            setFormTitle('Create New AI Evaluation');
            setFormSubtitle('Create a new AI evaluation for your integration');
            loadEmptyForm();
        }

        updateTargetLineRange();
    }, [functionName]);

    // Regenerate form fields when evalsetOptions changes
    useEffect(() => {
        if (testFunction && evalsetOptions.length > 0) {
            let formFields = generateFormFields(testFunction);

            // Get the dataProviderMode value to initialize field visibility
            const modeField = formFields.find(f => f.key === 'dataProviderMode');
            const mode = String(modeField?.value || 'template');
            setDataProviderMode(mode);
            setCustomUsesEvalset(mode === 'evalSet');

            // Set field visibility based on mode
            formFields = applyFieldVisibility(formFields, mode);

            setFormFields(formFields);

            const evalSetFileField = formFields.find(f => f.key === 'evalSetFile');
            const fieldValue = String(evalSetFileField?.value || '');
            if (fieldValue) {
                setSelectedEvalsetFile(prev => prev || fieldValue);
            }
        }
    }, [evalsetOptions]);

    const loadEvalsets = async () => {
        try {
            const res = await rpcClient.getTestManagerRpcClient().getEvalsets({ projectPath });
            const options = res.evalsets.map((evalset: EvalsetItem) => ({
                value: evalset.filePath,
                content: `${evalset.name}`
            }));
            setEvalsetOptions(options);
            setEvalsetsLoadError(false);
        } catch (error) {
            console.error('Failed to load evalsets:', error);
            setEvalsetOptions([]);
            setEvalsetsLoadError(true);
        } finally {
            setEvalsetsLoaded(true);
        }
    };

    const loadFunction = async () => {
        const res = await rpcClient.getTestManagerRpcClient().getTestFunction({ functionName, filePath });
        setTestFunction(res.function);
        let formFields = generateFormFields(res.function);

        // Get the dataProviderMode value to initialize field visibility
        const modeField = formFields.find(f => f.key === 'dataProviderMode');
        const mode = String(modeField?.value || 'template');
        setDataProviderMode(mode);
        setCustomUsesEvalset(mode === 'evalSet');

        // Initialize evalset file selection from loaded data
        const evalSetFileField = formFields.find(f => f.key === 'evalSetFile');
        setSelectedEvalsetFile(String(evalSetFileField?.value || ''));

        // Set initial field visibility
        formFields = applyFieldVisibility(formFields, mode);

        setFormFields(formFields);
    }

    const loadEmptyForm = async () => {
        setSelectedEvalsetFile('');
        const emptyTestFunction = getEmptyTestFunctionModel();
        setTestFunction(emptyTestFunction);
        let formFields = generateFormFields(emptyTestFunction);

        // Get the dataProviderMode value to initialize field visibility
        const modeField = formFields.find(f => f.key === 'dataProviderMode');
        const mode = String(modeField?.value || 'template');
        setDataProviderMode(mode);
        setCustomUsesEvalset(mode === 'evalSet');

        // Set initial field visibility (default is 'evalSet' mode)
        formFields = applyFieldVisibility(formFields, mode);

        setFormFields(formFields);
    }

    const onFormSubmit = async (data: FormValues, formImports: FormImports) => {
        setIsSaving(true);
        const formData = {
            ...data,
            dataProviderMode: dataProviderMode
        };
        const updatedTestFunction = fillFunctionModel(formData, formImports);
        if (serviceType === 'UPDATE_TEST') {
            await rpcClient.getTestManagerRpcClient().updateTestFunction({ function: updatedTestFunction, filePath });
        } else {
            const parameters: Record<string, string> = {};
            if (templateNode?.properties) {
                Object.entries(templateNode.properties).forEach(([key, property]) => {
                    const codedata = (property as FlowProperty).codedata;
                    if ((codedata?.data as { dataSourceParam?: boolean } | undefined)?.dataSourceParam) {
                        return;
                    }
                    const originalName = codedata?.originalName || key;
                    parameters[originalName] = String(data[`template_${key}`] ?? (property as FlowProperty).value ?? '');
                });
            }
            const dataSource = dataSourceParam ? {
                paramName: dataSourceParam.paramName,
                mode: dataSourceMode,
                ...(dataSourceMode === 'evalset'
                    ? { evalSetFile: selectedEvalsetFile }
                    : { queries: (Array.isArray(data['evalQueries']) ? data['evalQueries'] : []) as string[] })
            } : undefined;
            await rpcClient.getTestManagerRpcClient().addTestFunction({
                function: updatedTestFunction,
                filePath,
                ...(dataProviderMode === 'template' && selectedTemplate && {
                    evalTemplate: {
                        symbol: selectedTemplate.codedata.symbol || '',
                        parameters,
                        ...(dataSource && { dataSource })
                    }
                })
            });
        }
        try {
            const res = await rpcClient.getTestManagerRpcClient().getTestFunction(
                { functionName: updatedTestFunction.functionName.value, filePath });
            const nodePosition = {
                startLine: res.function.codedata.lineRange.startLine.line,
                startColumn: res.function.codedata.lineRange.startLine.offset,
                endLine: res.function.codedata.lineRange.endLine.line,
                endColumn: res.function.codedata.lineRange.endLine.offset
            };
            rpcClient.getVisualizerRpcClient().openView(
                { type: EVENT_TYPE.OPEN_VIEW, location: { position: nodePosition, documentUri: filePath } })
        }
        catch (error) {
            console.error('Failed to open function in diagram:', error);
            setIsSaving(false);
        }
    };

    // Helper function to modify and set the visual information
    const handleParamChange = (param: Parameter) => {
        const name = `${param.formValues['variable']}`;
        const type = `${param.formValues['type']}`;
        const defaultValue = Object.keys(param.formValues).indexOf('defaultable') > -1 && `${param.formValues['defaultable']}`;
        let value = `${type} ${name}`;
        if (defaultValue) {
            value += ` = ${defaultValue}`;
        }
        return {
            ...param,
            key: name,
            value: value
        }
    };

    const generateFormFields = (testFunction: TestFunction): FormField[] => {
        const fields: FormField[] = [];
        if (testFunction.functionName) {
            fields.push(generateFieldFromProperty('functionName', testFunction.functionName));
        }
        if (testFunction.parameters) {
            fields.push({
                key: `params`,
                label: 'Parameters',
                type: 'PARAM_MANAGER',
                optional: true,
                editable: true,
                enabled: true,
                advanced: true,
                hidden: true,
                documentation: '',
                value: '',
                paramManagerProps: {
                    paramValues: generateParamFields(testFunction.parameters),
                    formFields: paramFields,
                    handleParameter: handleParamChange
                },
                types: [{ fieldType: "PARAM_MANAGER", selected: false }]
            });
        }
        if (testFunction.annotations) {
            const configAnnotation = getTestConfigAnnotation(testFunction.annotations);
            if (configAnnotation && configAnnotation.fields) {
                const minPassRateField = configAnnotation.fields.find(f => f.originalName === 'minPassRate');
                if (minPassRateField) {
                    const generatedField = generateFieldFromProperty('minPassRate', minPassRateField);
                    fields.push({
                        ...generatedField,
                        documentation: generatedField.documentation || 'Minimum percentage of runs that must pass for the evaluation to succeed',
                        type: 'SLIDER',
                        types: [{ fieldType: 'SLIDER', selected: false }],
                        sliderProps: {
                            min: 0,
                            max: 100,
                            step: 1,
                            showValue: true,
                            showMarkers: true,
                            valueFormatter: (value: number) => `${value}%`
                        }
                    });
                }

                const evalSetFileField = configAnnotation.fields.find(f => f.originalName === 'evalSetFile');
                if (evalSetFileField) {
                    const generatedField = generateFieldFromProperty('evalSetFile', evalSetFileField);
                    const defaultValue = generatedField.value || (evalsetOptions.length > 0 ? evalsetOptions[0].value : '');
                    fields.push({
                        ...generatedField,
                        value: defaultValue,
                        type: 'SINGLE_SELECT',
                        types: [{ fieldType: 'SINGLE_SELECT', selected: false }],
                        itemOptions: evalsetOptions
                    });
                }

                for (const field of configAnnotation.fields) {
                    // Skip fields already processed
                    if (field.originalName === 'dataProviderMode' ||
                        field.originalName === 'minPassRate' ||
                        field.originalName === 'evalSetFile') {
                        continue;
                    }

                    // Special handling for groups and dependsOn - use EXPRESSION_SET
                    if (field.originalName === 'groups' || field.originalName === 'dependsOn') {
                        fields.push({
                            ...generateFieldFromProperty(field.originalName, field),
                            type: 'EXPRESSION_SET',
                            advanced: true,
                            types: [{ fieldType: 'EXPRESSION_SET', selected: false }]
                        });
                        continue;
                    }

                    // Special handling for expression fields - ensure they use EXPRESSION type
                    if (field.originalName === 'before' || field.originalName === 'after' ||
                        field.originalName === 'runs' || field.originalName === 'dataProvider') {
                        fields.push({
                            ...generateFieldFromProperty(field.originalName, field),
                            type: 'EXPRESSION',
                            advanced: true,
                            types: [{ fieldType: 'EXPRESSION', selected: false }]
                        });
                        continue;
                    }

                    // Special handling for enabled - use FLAG
                    if (field.originalName === 'enabled') {
                        fields.push({
                            ...generateFieldFromProperty(field.originalName, field),
                            type: 'FLAG',
                            advanced: true,
                            types: [{ fieldType: 'FLAG', selected: false }]
                        });
                        continue;
                    }

                    fields.push(generateFieldFromProperty(field.originalName, field));
                }
            }
        }
        return fields;
    }

    const getTestConfigAnnotation = (annotations: Annotation[]): Annotation | undefined => {
        for (const annotation of annotations) {
            if (annotation.name === 'Config') {
                return annotation;
            }
        }
        return;
    }

    const generateParamFields = (parameters: FunctionParameter[]): Parameter[] => {
        const params: Parameter[] = [];
        let id = 0;
        for (const param of parameters) {
            const key = param.variable.value;
            const type = param.type.value;

            const value = `${type} ${key}`;
            params.push({
                id: id,
                formValues: {
                    variable: key,
                    type: type,
                    defaultable: param.defaultValue ? param.defaultValue.value : ''
                },
                key: key,
                value: value,
                icon: '',
                identifierEditable: param.variable?.editable,
                identifierRange: param.variable?.codedata?.lineRange
            });

            id++;
        }
        return params
    }

    const generateFieldFromProperty = (key: string, property: ValueProperty): FormField => {
        const fieldType = getPrimaryInputType(property.types)?.fieldType;

        // Convert decimal (0-1) to percentage (0-100) for minPassRate display
        let displayValue = property.value;
        if (key === 'minPassRate') {
            const decimalValue = parseFloat(property.value);
            displayValue = String(Math.round((isNaN(decimalValue) ? 1 : decimalValue) * 100));
        }

        const baseField: FormField = {
            key: key,
            label: property.metadata.label,
            type: fieldType,
            optional: property.optional,
            editable: property.editable,
            advanced: property.advanced,
            enabled: true,
            documentation: property.metadata.description,
            value: displayValue,
            types: [{ fieldType: fieldType, selected: false }]
        };

        // Add slider-specific configuration for minPassRate
        if (key === 'minPassRate' && fieldType === 'SLIDER') {
            baseField.sliderProps = {
                min: 0,
                max: 100,
                step: 1,
                showValue: true,
                showMarkers: true,
                valueFormatter: (value: number) => `${value}%`
            };
        }

        return baseField;
    }

    const generateTemplateFields = (node: FlowNode): FormField[] => Object.entries(node.properties || {})
        .filter(([, property]) => !(property as FlowProperty).hidden)
        .map(([key, property]) => ({
            ...convertNodePropertyToFormField(key, withAgentConnectionData(property as FlowProperty)),
            key: `template_${key}`,
            advanced: false
        }));

    const fillFunctionModel = (formValues: FormValues, formImports: FormImports): TestFunction => {
        let tmpTestFunction = testFunction;
        if (!tmpTestFunction) {
            tmpTestFunction = {};
        }

        if (formValues['functionName']) {
            tmpTestFunction.functionName.value = formValues['functionName'];
        }

        if (formValues['returnType']) {
            tmpTestFunction.returnType.value = formValues['returnType'];
            tmpTestFunction.returnType.imports = getImportsForProperty('returnType', formImports);
        }

        if (formValues['params']) {
            const params = formValues['params'];
            const paramList: FunctionParameter[] = [];
            for (const param of params) {
                const paramFormValues = param.formValues;
                const variable = paramFormValues['variable'];
                const type = paramFormValues['type'];
                const typeImports = getImportsForProperty('params', formImports);
                const defaultValue = paramFormValues['defaultable'];
                let emptyParam = getEmptyParamModel();
                emptyParam.variable.value = variable;
                emptyParam.type.value = type;
                emptyParam.type.imports = typeImports;
                emptyParam.defaultValue.value = defaultValue;
                paramList.push(emptyParam);
            }
            tmpTestFunction.parameters = paramList;
        }

        let annots = tmpTestFunction.annotations;
        for (const annot of annots) {
            if (annot.name == 'Config') {
                let configAnnot = annot;
                let fields = configAnnot.fields;
                for (const field of fields) {
                    if (field.originalName == 'groups') {
                        field.value = formValues['groups'];
                    }
                    if (field.originalName == 'enabled') {
                        field.value = formValues['enabled'];
                    }
                    if (field.originalName == 'dependsOn') {
                        field.value = formValues['dependsOn'] || [];
                    }
                    if (field.originalName == 'before') {
                        field.value = formValues['before'] || "";
                    }
                    if (field.originalName == 'after') {
                        field.value = formValues['after'] || "";
                    }
                    if (field.originalName == 'runs') {
                        field.value = formValues['runs'] || "1";
                    }
                    if (field.originalName == 'minPassRate') {
                        // Convert percentage (0-100) to decimal (0-1)
                        const percentageValue = formValues['minPassRate'] ?? 100;
                        field.value = String(Number(percentageValue) / 100);
                    }
                    if (field.originalName == 'dataProviderMode') {
                        field.value = formValues['dataProviderMode'] || "function";
                    }
                    if (field.originalName == 'dataProvider') {
                        if (formValues['dataProviderMode'] === 'function') {
                            field.value = formValues['dataProvider'] || "";
                        }
                        // Preserve existing dataProvider value when in evalSet mode
                        // (backend creates it from evalSetFile)
                    }
                    if (field.originalName == 'evalSetFile') {
                        if (formValues['dataProviderMode'] === 'evalSet' ||
                            (formValues['dataProviderMode'] === 'template' && templateNeedsEvalset(selectedTemplate))) {
                            field.value = formValues['evalSetFile'] || "";
                        }
                        // Preserve existing evalSetFile value when in function mode
                    }
                }
            }
        }

        return tmpTestFunction;
    }

    const getEmptyParamModel = (): FunctionParameter => {
        return {
            type: {
                value: "string",
                optional: false,
                editable: true,
                advanced: false,
                types: [{ fieldType: "TYPE", selected: false }]
            },
            variable: {
                value: "b",
                optional: false,
                editable: true,
                advanced: false,
                types: [{ fieldType: "IDENTIFIER", selected: false }]
            },
            defaultValue: {
                value: "\"default\"",
                optional: false,
                editable: true,
                advanced: false,
                types: [{ fieldType: "EXPRESSION", selected: false }]
            },
            optional: false,
            editable: true,
            advanced: false
        }

    }

    const getEmptyTestFunctionModel = (): TestFunction => {
        return {
            functionName: {
                metadata: {
                    label: "AI Evaluation Name",
                    description: "Name of the AI evaluation"
                },
                value: "",
                optional: false,
                editable: true,
                advanced: false,
                types: [{ fieldType: "IDENTIFIER", selected: false }]
            },
            returnType: {
                metadata: {
                    label: "Return Type",
                    description: "Return type of the function"
                },
                optional: true,
                editable: true,
                advanced: true,
                types: [{ fieldType: "TYPE", selected: false }],
            },
            parameters: [],
            annotations: [
                {
                    metadata: {
                        label: "Config",
                        description: "AI Evaluation Configurations"
                    },
                    org: "ballerina",
                    module: "test",
                    name: "Config",
                    fields: [
                        {
                            metadata: {
                                label: "Enabled",
                                description: "Enable/Disable the evaluation"
                            },
                            originalName: "enabled",
                            value: true,
                            optional: true,
                            editable: true,
                            advanced: true,
                            types: [{ fieldType: "FLAG", selected: false }]
                        },
                        {
                            metadata: {
                                label: "Groups",
                                description: "Groups to run"
                            },
                            types: [{ fieldType: "EXPRESSION_SET", selected: false }],
                            originalName: "groups",
                            value: ["evaluations"],
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Depends On",
                                description: "List of test function names that this test depends on"
                            },
                            types: [{ fieldType: "EXPRESSION_SET", selected: false }],
                            originalName: "dependsOn",
                            value: [],
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Before Function",
                                description: "Function to execute before this test"
                            },
                            types: [{ fieldType: "EXPRESSION", selected: false }],
                            originalName: "before",
                            value: "",
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "After Function",
                                description: "Function to execute after this test"
                            },
                            types: [{ fieldType: "EXPRESSION", selected: false }],
                            originalName: "after",
                            value: "",
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Runs",
                                description: "Number of times to execute this test"
                            },
                            types: [{ fieldType: "EXPRESSION", selected: false }],
                            originalName: "runs",
                            value: "1",
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Minimum Pass Rate (%)",
                                description: "Minimum percentage of runs that must pass (0-100)"
                            },
                            types: [{ fieldType: "SLIDER", selected: false }],
                            originalName: "minPassRate",
                            value: "0.9",
                            optional: true,
                            editable: true,
                            advanced: false
                        },
                        {
                            metadata: {
                                label: "",
                                description: "Choose how to provide test data"
                            },
                            types: [{ fieldType: "STRING", selected: false }],
                            originalName: "dataProviderMode",
                            value: "template",
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Data Provider",
                                description: "Function that provides test data"
                            },
                            types: [{ fieldType: "EXPRESSION", selected: false }],
                            originalName: "dataProvider",
                            value: "",
                            optional: true,
                            editable: true,
                            advanced: true
                        },
                        {
                            metadata: {
                                label: "Evalset File",
                                description: "Select an evalset for test data"
                            },
                            types: [{ fieldType: "STRING", selected: false }],
                            originalName: "evalSetFile",
                            value: "",
                            optional: true,
                            editable: true,
                            advanced: false
                        }
                    ]
                }
            ],
            editable: true
        }
    }

    const paramFields: FormField[] = [
        {
            key: `variable`,
            label: 'Name',
            type: 'string',
            optional: false,
            editable: true,
            enabled: true,
            documentation: '',
            value: '',
            types: [{ fieldType: "IDENTIFIER", selected: false }]
        },
        {
            key: `type`,
            label: 'Type',
            type: 'TYPE',
            optional: false,
            editable: true,
            enabled: true,
            documentation: '',
            value: '',
            types: [{ fieldType: "TYPE", selected: false }]
        },
        {
            key: `defaultable`,
            label: 'Default Value',
            type: 'string',
            optional: true,
            advanced: true,
            editable: true,
            enabled: true,
            documentation: '',
            value: '',
            types: [{ fieldType: "STRING", selected: false }]
        }
    ];

    const cardOptions = [
        {
            value: 'template',
            title: 'From Template',
            description: 'Use a prebuilt evaluator for a common AI evaluation pattern.',
            icon: <Icon name="bi-data-table" sx={{ fontSize: "20px", width: "20px", height: "20px" }} />
        },
        {
            value: 'custom',
            title: 'Custom',
            description: 'Implement custom evaluation logic, with or without evalset data.',
            icon: <Icon name="bi-config" sx={{ fontSize: "20px", width: "20px", height: "20px" }} />
        }
    ];

    const handleCardSelectorChange = (value: string) => {
        if (value !== 'template') {
            setSelectedTemplate(undefined);
            setTemplateNode(undefined);
            setShowTemplatePicker(false);
            setCustomUsesEvalset(false);
            setFormFields(fields => fields.filter(isBaseField));
        }
        const mode = value === 'template' ? 'template' : 'function';
        setDataProviderMode(mode);
        updateFieldVisibility(mode);
    };

    const handleCustomEvalsetChange = (usesEvalset: boolean) => {
        const mode = usesEvalset ? 'evalSet' : 'function';
        setCustomUsesEvalset(usesEvalset);
        setDataProviderMode(mode);
        updateFieldVisibility(mode);
    };

    // Show upgrade message if version is not supported
    if (isVersionSupported === false) {
        return (
            <FullHeightView>
                <TopNavigationBar projectPath={projectPath} />
                <TitleBar title="AI Evaluation" subtitle="Version upgrade required" />
                <FullHeightViewContent padding>
                    <UpgradeMessageContainer>
                        <UpgradeTitle>Please upgrade your Ballerina version</UpgradeTitle>
                        <UpgradeMessage>
                            AI Evaluation features require Ballerina version 2201.13.2 or higher.
                            Please upgrade your Ballerina installation to use this feature.
                        </UpgradeMessage>
                    </UpgradeMessageContainer>
                </FullHeightViewContent>
            </FullHeightView>
        );
    }

    return (
        <View>
            <TopNavigationBar projectPath={projectPath} />
            <TitleBar title="AI Evaluation" subtitle={formSubtitle} />
            <ViewContent padding>
                <Container>
                    <FormHeader title={formTitle} />
                    <FormContainer>

                        {targetLineRange && (
                            <ArtifactForm
                                fileName={filePath}
                                fields={formFields}
                                targetLineRange={targetLineRange}
                                onSubmit={onFormSubmit}
                                preserveFieldOrder={true}
                                onChange={handleFieldChange}
                                isSaving={isSaving}
                                disableSaveButton={(dataProviderMode === 'evalSet' && !selectedEvalsetFile)
                                    || (dataProviderMode === 'template' && (!selectedTemplate
                                        || (!!dataSourceParam && dataSourceMode === 'evalset' && !selectedEvalsetFile)))}
                                injectedComponents={[
                                    {
                                        component: <>
                                            <CardSelector
                                                title="How would you like to build this evaluation?"
                                                options={cardOptions}
                                                value={dataProviderMode === 'template' ? 'template' : 'custom'}
                                                onChange={handleCardSelectorChange}
                                            />
                                            {dataProviderMode !== 'template' && (
                                                <EvalsetModeSelector>
                                                    <RadioButtonGroup
                                                        label="Use an evalset?"
                                                        orientation="horizontal"
                                                        value={customUsesEvalset ? 'evalSet' : 'none'}
                                                        options={[
                                                            { id: 'evalset-none', value: 'none', content: 'No evalset' },
                                                            { id: 'evalset-use', value: 'evalSet', content: 'Use evalset' }
                                                        ]}
                                                        onChange={(e) => handleCustomEvalsetChange(e.target.value === 'evalSet')}
                                                    />
                                                </EvalsetModeSelector>
                                            )}
                                            {dataProviderMode === 'template' && (
                                                <TemplatePicker>
                                                    <TemplatePickerButton type="button" selected={Boolean(selectedTemplate)}
                                                        onClick={() => setShowTemplatePicker(true)}
                                                        aria-haspopup="dialog" aria-expanded={showTemplatePicker}>
                                                        <TemplatePickerIcon selected={Boolean(selectedTemplate)}>
                                                            <Codicon name={selectedTemplate ? getTemplateIcon(selectedTemplate) : 'list-selection'}
                                                                sx={{ display: 'flex', height: 'auto', width: 'auto', cursor: 'pointer' }}
                                                                iconSx={{ fontSize: '20px', lineHeight: 1, display: 'block', WebkitTextStroke: '0.4px currentColor' }} />
                                                        </TemplatePickerIcon>
                                                        <TemplatePickerCopy>
                                                            <TemplatePickerTitle>
                                                                <TemplatePickerTitleRow>
                                                                    {selectedTemplate?.metadata.label || 'Select an evaluation template'}
                                                                    {selectedTemplate && <Badge>{getTemplateKind(selectedTemplate)}</Badge>}
                                                                </TemplatePickerTitleRow>
                                                            </TemplatePickerTitle>
                                                            <TemplatePickerDescription>
                                                                {selectedTemplate?.metadata.description
                                                                    || 'Browse rule-based and LLM-as-judge checks'}
                                                            </TemplatePickerDescription>
                                                        </TemplatePickerCopy>
                                                        <TemplatePickerAction>{selectedTemplate ? 'Change' : 'Browse'}</TemplatePickerAction>
                                                        <Codicon name="chevron-down" />
                                                    </TemplatePickerButton>
                                                    {selectedTemplate && templateNode && <TemplateConfigDivider />}
                                                </TemplatePicker>
                                            )}
                                            {dataProviderMode === 'template' && selectedTemplate && templateNode
                                                && dataSourceParam && (
                                                    <TestInputSection>
                                                        <TestInputLabel>Test input</TestInputLabel>
                                                        {dataSourceParam.kind === 'union' ? (
                                                            <>
                                                                <TestInputHint>How should test input be provided?</TestInputHint>
                                                                <RadioButtonGroup
                                                                    orientation="horizontal"
                                                                    value={dataSourceMode}
                                                                    options={[
                                                                        { id: 'ds-evalset', value: 'evalset', content: 'From an evalset' },
                                                                        { id: 'ds-queries', value: 'queries', content: 'Enter queries manually' }
                                                                    ]}
                                                                    onChange={(e) => handleDataSourceModeChange(
                                                                        e.target.value === 'queries' ? 'queries' : 'evalset')}
                                                                />
                                                            </>
                                                        ) : (
                                                            <TestInputHint>This template evaluates against an evalset.</TestInputHint>
                                                        )}
                                                    </TestInputSection>
                                                )}
                                            {((dataProviderMode === 'evalSet')
                                                || (dataProviderMode === 'template' && dataSourceParam && dataSourceMode === 'evalset'))
                                                && evalsetsLoaded && evalsetOptions.length === 0
                                                && !selectedEvalsetFile && (
                                                    <EmptyEvalsetContainer>
                                                        <EmptyEvalsetTitle>
                                                            <Icon name={evalsetsLoadError ? "bi-error" : "bi-data-table"}
                                                                sx={{ fontSize: "16px", width: "16px", height: "16px" }} />
                                                            {evalsetsLoadError ? "Failed to load evalsets" : "No evalset files found"}
                                                        </EmptyEvalsetTitle>
                                                        <EmptyEvalsetMessage>
                                                            {evalsetsLoadError ? (
                                                                <>Could not load evalsets for this project. Try reopening this view, or switch to <strong>Standalone/Custom</strong> mode to define your evaluation logic from scratch.</>
                                                            ) : (
                                                                <>Evalsets are created by exporting traces from conversations with your agents.
                                                                    Have a conversation with an agent and export the traces, or switch to <strong>Standalone/Custom</strong> mode to define your evaluation logic from scratch.</>
                                                            )}
                                                        </EmptyEvalsetMessage>
                                                    </EmptyEvalsetContainer>
                                                )}
                                        </>,
                                        index: 2
                                    }
                                ]}
                            />
                        )}
                    </FormContainer>
                </Container>
            </ViewContent>
            {showTemplatePicker && (
                <TemplateModalBackdrop role="presentation" onMouseDown={() => setShowTemplatePicker(false)}>
                    <TemplateModal role="dialog" aria-modal="true" aria-labelledby="evaluation-template-dialog-title"
                        onMouseDown={(event) => event.stopPropagation()}>
                        <TemplateModalHeader>
                            <div>
                                <TemplateModalTitle id="evaluation-template-dialog-title">Browse Evaluation Templates</TemplateModalTitle>
                                <TemplateModalCount>{filteredTemplates.length} of {evalTemplates.length} templates</TemplateModalCount>
                            </div>
                            <ModalIconButton type="button" onClick={() => setShowTemplatePicker(false)} aria-label="Close template browser">
                                <Codicon name="close" />
                            </ModalIconButton>
                        </TemplateModalHeader>
                        <TemplateModalControls>
                            <TemplateSearch
                                value={templateQuery}
                                placeholder="Search by name, type, or behavior"
                                onChange={setTemplateQuery}
                                size={60}
                                autoFocus
                            />
                            <TemplateFilters>
                                {([
                                    ['all', 'All'],
                                    ['rule-based', 'Rule-based'],
                                    ['llm-as-judge', 'LLM-as-Judge'],
                                    ['uses-evalset', 'Evalset required'],
                                    ['no-evalset', 'Evalset or queries']
                                ] as Array<[TemplateFilterKind, string]>).map(([filter, label]) => (
                                    <TemplateFilter key={filter} type="button" active={templateFilter === filter}
                                        onClick={() => setTemplateFilter(filter)}>{label}</TemplateFilter>
                                ))}
                            </TemplateFilters>
                        </TemplateModalControls>
                        <TemplateResults>
                            {templateLoadError ? (
                                <EmptyTemplates>{templateLoadError}</EmptyTemplates>
                            ) : filteredTemplates.length === 0 ? (
                                <EmptyTemplates>No templates match the current search and filters.</EmptyTemplates>
                            ) : (
                                <TemplateResultsGrid>
                                    {filteredTemplates.map(template => (
                                        <TemplateOption key={template.codedata.symbol} type="button"
                                            selected={selectedTemplate?.codedata.symbol === template.codedata.symbol}
                                            onClick={() => selectEvalTemplate(template)}>
                                            <TemplateOptionIcon selected={selectedTemplate?.codedata.symbol === template.codedata.symbol}>
                                                <Codicon name={getTemplateIcon(template)}
                                                    sx={{ display: 'flex', height: 'auto', width: 'auto', cursor: 'pointer' }}
                                                    iconSx={{ fontSize: '18px', lineHeight: 1, display: 'block', WebkitTextStroke: '0.4px currentColor' }} />
                                            </TemplateOptionIcon>
                                            <TemplateOptionBody>
                                                <TemplateOptionHeading>
                                                    <span>{template.metadata.label}</span>
                                                    {selectedTemplate?.codedata.symbol === template.codedata.symbol && <Codicon name="check" />}
                                                </TemplateOptionHeading>
                                                <TemplateTags>
                                                    <Badge>{getTemplateKind(template)}</Badge>
                                                    <Badge>{templateNeedsEvalset(template) ? 'Evalset required' : 'Evalset or queries'}</Badge>
                                                </TemplateTags>
                                                <TemplateOptionDescription>{template.metadata.description}</TemplateOptionDescription>
                                            </TemplateOptionBody>
                                        </TemplateOption>
                                    ))}
                                </TemplateResultsGrid>
                            )}
                        </TemplateResults>
                    </TemplateModal>
                </TemplateModalBackdrop>
            )}
        </View>
    );
}
