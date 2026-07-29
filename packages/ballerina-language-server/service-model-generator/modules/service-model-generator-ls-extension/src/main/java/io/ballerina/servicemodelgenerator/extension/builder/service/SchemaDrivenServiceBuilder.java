/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

package io.ballerina.servicemodelgenerator.extension.builder.service;

import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.compiler.syntax.tree.ServiceDeclarationNode;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerUISchemaModel;
import io.ballerina.servicemodelgenerator.extension.connector.ConnectorModelReader;
import io.ballerina.servicemodelgenerator.extension.connector.ConnectorVersionResolver;
import io.ballerina.servicemodelgenerator.extension.connector.ExistingListenerResolver;
import io.ballerina.servicemodelgenerator.extension.connector.IncludedRecordBinder;
import io.ballerina.servicemodelgenerator.extension.connector.SchemaDrivenSourceGenerator;
import io.ballerina.servicemodelgenerator.extension.connector.adapter.TriggerReadOnlyMetadataAdapter;
import io.ballerina.servicemodelgenerator.extension.connector.adapter.TriggerServiceAdapter;
import io.ballerina.servicemodelgenerator.extension.connector.adapter.TriggerSourceMerger;
import io.ballerina.servicemodelgenerator.extension.model.Codedata;
import io.ballerina.servicemodelgenerator.extension.model.Function;
import io.ballerina.servicemodelgenerator.extension.model.MetaData;
import io.ballerina.servicemodelgenerator.extension.model.PropertyType;
import io.ballerina.servicemodelgenerator.extension.model.Service;
import io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel;
import io.ballerina.servicemodelgenerator.extension.model.Value;
import io.ballerina.servicemodelgenerator.extension.model.context.AddServiceInitModelContext;
import io.ballerina.servicemodelgenerator.extension.model.context.GetServiceInitModelContext;
import io.ballerina.servicemodelgenerator.extension.model.context.ModelFromSourceContext;
import io.ballerina.servicemodelgenerator.extension.util.ListenerUtil;
import io.ballerina.servicemodelgenerator.extension.util.Utils;
import org.eclipse.lsp4j.TextEdit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

import static io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel.KEY_CONFIGURE_LISTENER;
import static io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel.KEY_EXISTING_LISTENER;
import static io.ballerina.servicemodelgenerator.extension.model.ServiceInitModel.KEY_LISTENER_VAR_NAME;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.LISTENER_VAR_NAME;
import static io.ballerina.servicemodelgenerator.extension.util.Constants.PROP_READONLY_METADATA_KEY;
import static io.ballerina.servicemodelgenerator.extension.util.ServiceModelUtils.getProtocol;
import static io.ballerina.servicemodelgenerator.extension.util.ServiceModelUtils.getServiceTypeIdentifier;

/**
 * Generic, schema-driven service builder for connectors whose unified {@link TriggerUISchemaModel} is bundled
 * as a classpath resource in this jar. It serves the add-event-integration flow
 * ({@code getServiceInitModel} + {@code addServiceAndListener}) with no per-connector code: the init
 * form comes straight from the model's {@code initProperties}, and the source is emitted by
 * {@link SchemaDrivenSourceGenerator} from the model's {@code codedata}.
 *
 * <p>Selected by {@code ServiceBuilderRouter} only when no hardcoded builder is registered for the
 * module and {@link ConnectorModelReader} finds a model — so existing connectors are unaffected.
 * The remaining {@code NodeBuilder} operations (designer/edit) are inherited from
 * {@link AbstractServiceBuilder} for now and will be specialised in later milestones.
 *
 * @since 1.8.0
 */
public class SchemaDrivenServiceBuilder extends AbstractServiceBuilder {

    public static final String KIND = "schema-driven";

    @Override
    public String kind() {
        return KIND;
    }

    @Override
    public ServiceInitModel getServiceInitModel(GetServiceInitModelContext context) {
        // Bundled classpath resource (version-gated), or (on a miss) synthesized from the connector's
        // own trigger-metadata.json + introspection: either way, its init form is derived from
        // `initProperties`. Modelled against the version the project will actually compile against, so
        // a project pinned to an older connector gets that release's form rather than the newest one.
        String version = ConnectorVersionResolver.resolve(context.project(), context.orgName(),
                context.packageName(), context.version());
        Optional<ServiceInitModel> triggerInit = ConnectorModelReader.getInstance()
                .getSchemaDrivenServiceInitModel(context.orgName(), context.moduleName(), version);
        if (triggerInit.isEmpty()) {
            return null;
        }
        ServiceInitModel initModel = triggerInit.get();
        refreshListenerName(initModel, context);
        populateExistingListeners(initModel, context);
        return initModel;
    }

    @Override
    public Map<String, List<TextEdit>> addServiceInitSource(AddServiceInitModelContext context) {
        ServiceInitModel filledModel = context.serviceInitModel();
        ModulePartNode rootNode = context.document().syntaxTree().rootNode();
        // Bundled classpath resource (version-gated by the filled model's own version), or (on a miss)
        // synthesized from the connector's own trigger-metadata.json + introspection.
        Optional<TriggerUISchemaModel> triggerModel = ConnectorModelReader.getInstance()
                .getSchemaDrivenTriggerModel(filledModel.getOrgName(), filledModel.getModuleName(),
                        filledModel.getVersion());
        if (triggerModel.isEmpty()) {
            return Map.of();
        }
        return SchemaDrivenSourceGenerator.buildAddServiceEditsForTrigger(
                filledModel, triggerModel.get(), rootNode, context.filePath());
    }

    @Override
    public Service getModelFromSource(ModelFromSourceContext context) {
        // Bundled (version-gated) or synthesized schema: build the designer template from its
        // serviceTypes[], then merge the user's source (functions present, base path, listeners, line
        // ranges). Reading an existing service already knows the exact version from the source's
        // ModuleID (context.version()).
        Optional<TriggerUISchemaModel> triggerModel = ConnectorModelReader.getInstance()
                .getSchemaDrivenTriggerModel(context.orgName(), context.moduleName(), context.version());
        if (triggerModel.isEmpty()) {
            // Not a schema-driven connector after all -> fall back to the DB-backed behaviour.
            return super.getModelFromSource(context);
        }
        if (Objects.isNull(context.serviceType())) {
            return null;
        }
        String serviceType = getServiceTypeIdentifier(context.serviceType());
        Service serviceModel = TriggerServiceAdapter.toServiceTemplate(triggerModel.get(),
                serviceType, context.orgName(), context.packageName(), context.moduleName());
        if (serviceModel == null) {
            return null;
        }
        serviceModel.getServiceType().setValue(serviceType);
        serviceModel.getServiceType().setEditable(false);
        serviceModel.getServiceType().setEnabled(triggerModel.get().serviceTypes().size() > 1);
        populateServiceModelFromSource(serviceModel, (ServiceDeclarationNode) context.node(), context);

        Value stringLiteralProperty = serviceModel.getStringLiteralProperty();
        if (stringLiteralProperty != null) {
            String stringLiteral = stringLiteralProperty.getValue();
            stringLiteralProperty.setEnabled(!stringLiteralProperty.isOptional()
                    || (stringLiteral != null && !stringLiteral.isEmpty()));
        }

        // Included-record payloads: the textual merge above only sees the generated wrapper's name
        // (e.g. KafkaAnydataConsumer1[]); resolve its payload field so the UI shows the bound type.
        IncludedRecordBinder.overlayFromSource(serviceModel, context);

        // Read-only summary chips (e.g. "Monitored Path", "Queue Name") resolved from the source, using
        // the trigger model's readOnlyMetadata definitions. Absent when the model ships none.
        Value readOnlyMetadata = TriggerReadOnlyMetadataAdapter.build(triggerModel.get().readOnlyMetadata(),
                serviceModel, (ServiceDeclarationNode) context.node(), context);
        if (readOnlyMetadata != null) {
            serviceModel.getProperties().put(PROP_READONLY_METADATA_KEY, readOnlyMetadata);
        }
        return serviceModel;
    }

    /**
     * The unified trigger template ships an addable handler catalog ({@code schemaFunctions}), so
     * the source merge enriches each source function with its schema variant's data and consumes the
     * matched catalog entries — instead of the default enable/disable merge.
     */
    @Override
    protected void mergeSourceFunctions(Service serviceModel, List<Function> functionsInSource) {
        if (serviceModel.getSchemaFunctions() != null) {
            TriggerSourceMerger.mergeSource(serviceModel, functionsInSource);
            return;
        }
        super.mergeSourceFunctions(serviceModel, functionsInSource);
    }

    /**
     * Populates the "use existing" branch of the listener {@code configureListener} CHOICE with the
     * listeners of this connector's type already present in the project, so the user can attach to one
     * instead of creating a new listener. Mirrors the hardcoded builders (FTP/Solace/…): by convention
     * {@code choices[0]} is "create new" and {@code choices[1]} is "use existing", and the selection is
     * a {@code SINGLE_SELECT} bound to {@code KEY_EXISTING_LISTENER}. When the project has no compatible
     * listener, the "use existing" branch is disabled so only the create-new path is offered.
     */
    private void populateExistingListeners(ServiceInitModel creationModel, GetServiceInitModelContext context) {
        Value configureListener = findListenerChoice(creationModel);
        if (configureListener == null || configureListener.getChoices() == null
                || configureListener.getChoices().size() < 2) {
            return;
        }
        List<Value> choices = configureListener.getChoices();
        Set<String> listeners = ListenerUtil.getCompatibleListeners(context.moduleName(),
                context.semanticModel(), context.project());
        Value selector = null;
        if (!listeners.isEmpty()) {
            Value createNewBranch = choices.get(indexOfCreateNewBranch(choices));
            // Resolve each existing listener's config from the model (create-new params as the field
            // template) + the source (its new(...) args), like the FTP/RabbitMQ builders do.
            selector = ExistingListenerResolver.buildSelector(createNewBranch, new ArrayList<>(listeners),
                    context.semanticModel(), context.project(), getProtocol(context.moduleName()));
        } else {
            int useExistingIndex = indexOfCreateNewBranch(choices) == 0 ? 1 : 0;
            Value useExistingBranch = choices.get(useExistingIndex);
            useExistingBranch.setMetadata(new MetaData("Use existing (none available)",
                    "No compatible listener of this type is present in the project."));
        }
        applyListenerChoiceSelection(configureListener, selector);
    }

    /**
     * Wires the listener {@code configureListener} CHOICE (pure; unit-testable). Identifies the "create
     * new" branch by content (it carries listener params) and treats the other as "use existing". When a
     * {@code selector} is supplied (listeners exist), it is nested in the use-existing branch's
     * {@code listenerConfig} GROUP_SECTION (like FTP/RabbitMQ) and that branch becomes the enabled
     * default; when {@code selector} is null, the use-existing branch is disabled and create-new is the
     * default.
     */
    static void applyListenerChoiceSelection(Value configureListener, Value selector) {
        List<Value> choices = configureListener.getChoices();
        if (choices == null || choices.size() < 2) {
            return;
        }
        int createNewIndex = indexOfCreateNewBranch(choices);
        int useExistingIndex = createNewIndex == 0 ? 1 : 0;
        Value createNewChoice = choices.get(createNewIndex);
        Value useExistingChoice = choices.get(useExistingIndex);

        if (selector == null) {
            // Nothing to attach to: offer only the create-new path and disable the use-existing radio.
            useExistingChoice.setEnabled(false);
            useExistingChoice.setEditable(false);
            createNewChoice.setEnabled(true);
            createNewChoice.setEditable(true);
            configureListener.setValue(String.valueOf(createNewIndex));
            return;
        }

        Map<String, Value> existingProps = new LinkedHashMap<>();
        existingProps.put(KEY_EXISTING_LISTENER, selector);
        Value group = firstGroupSection(useExistingChoice);
        if (group == null) {
            // The branch ships no GROUP_SECTION (model-author's choice): synthesize one so the
            // selector and its resolved read-only config render inside a titled "Listener
            // Configurations" box, matching the create-new branch and the hardcoded builders.
            group = new Value.ValueBuilder()
                    .metadata("Listener Configurations", "Configuration of the selected listener.")
                    .types(List.of(PropertyType.types(Value.FieldType.GROUP_SECTION)))
                    .enabled(true)
                    .editable(true)
                    .build();
            Map<String, Value> branchProps = new LinkedHashMap<>();
            branchProps.put("listenerConfig", group);
            useExistingChoice.setProperties(branchProps);
        }
        group.setProperties(existingProps);
        // Existing listeners are available -> enable and default-select the "use existing" branch.
        // Both branches must be `editable` so the front-end radio (ChoiceForm) lets the user switch
        // between "Create new" and "Use existing".
        useExistingChoice.setEnabled(true);
        useExistingChoice.setEditable(true);
        createNewChoice.setEnabled(false);
        createNewChoice.setEditable(true);
        configureListener.setValue(String.valueOf(useExistingIndex));
    }

    private static Value firstGroupSection(Value branch) {
        if (branch.getProperties() == null) {
            return null;
        }
        for (Value child : branch.getProperties().values()) {
            if (child.getTypes() != null
                    && child.getTypes().stream().anyMatch(type -> type.fieldType() == Value.FieldType.GROUP_SECTION)) {
                return child;
            }
        }
        return null;
    }

    /**
     * Returns the index of the "create new" branch — the one that carries listener parameters
     * ({@code LISTENER_PARAM_*} / {@code LISTENER_VAR_NAME}). Defaults to 0 when none is detected.
     */
    private static int indexOfCreateNewBranch(List<Value> choices) {
        for (int i = 0; i < choices.size(); i++) {
            if (hasListenerParams(choices.get(i))) {
                return i;
            }
        }
        return 0;
    }

    private static boolean hasListenerParams(Value node) {
        if (node == null) {
            return false;
        }
        Codedata codedata = node.getCodedata();
        if (codedata != null) {
            String argType = codedata.getArgType();
            if ((argType != null && argType.startsWith("LISTENER_PARAM"))
                    || "LISTENER_VAR_NAME".equals(codedata.getType())
                    || "LISTENER_VAR_NAME".equals(argType)) {
                return true;
            }
        }
        if (node.getProperties() != null) {
            for (Value child : node.getProperties().values()) {
                if (hasListenerParams(child)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Replaces the shipped default listener variable name with a project-unique identifier, mirroring
     * the hardcoded builders so a second trigger of the same kind does not collide.
     */
    private void refreshListenerName(ServiceInitModel creationModel, GetServiceInitModelContext context) {
        // v1: listenerVarName is a top-level property. Unified model: it lives inside the listener
        // CHOICE's create-new branch, so fall back to a codedata-driven recursive lookup.
        Value listenerName = creationModel.getProperties().get(KEY_LISTENER_VAR_NAME);
        if (listenerName == null) {
            listenerName = findListenerVarNameNode(creationModel.getProperties());
        }
        if (listenerName == null) {
            return;
        }
        String uniqueName = Utils.generateVariableIdentifier(context.semanticModel(), context.document(),
                context.document().syntaxTree().rootNode().lineRange().endLine(),
                LISTENER_VAR_NAME.formatted(getProtocol(context.moduleName())));
        listenerName.setValue(uniqueName);
    }

    /**
     * Locates the listener create/reuse CHOICE. Prefers the v1 {@code configureListener} key; falls
     * back to the unified model's node carrying {@code codedata.type == LISTENER_CONFIG} (keyed
     * {@code listener}). Robust to the key name so both conventions resolve.
     */
    private static Value findListenerChoice(ServiceInitModel model) {
        Value byKey = model.getProperties().get(KEY_CONFIGURE_LISTENER);
        if (byKey != null) {
            return byKey;
        }
        for (Value candidate : model.getProperties().values()) {
            if (candidate != null && candidate.getCodedata() != null
                    && "LISTENER_CONFIG".equals(candidate.getCodedata().getType())) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Recursively locates the listener-variable-name node ({@code codedata.type == LISTENER_VAR_NAME}),
     * which in the unified model is nested inside the listener CHOICE's create-new branch.
     */
    private static Value findListenerVarNameNode(Map<String, Value> properties) {
        if (properties == null) {
            return null;
        }
        for (Value value : properties.values()) {
            if (value == null) {
                continue;
            }
            Codedata codedata = value.getCodedata();
            if (codedata != null && "LISTENER_VAR_NAME".equals(codedata.getType())) {
                return value;
            }
            Value nested = findListenerVarNameNode(value.getProperties());
            if (nested != null) {
                return nested;
            }
            if (value.getChoices() != null) {
                for (Value choice : value.getChoices()) {
                    Value found = findListenerVarNameNode(choice.getProperties());
                    if (found != null) {
                        return found;
                    }
                }
            }
        }
        return null;
    }
}
