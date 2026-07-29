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

package io.ballerina.modelgenerator.commons.trigger.models;

import java.util.List;
import java.util.Map;

/**
 * Deserialization target for a connector-shipped <b>Trigger UI Schema</b>
 * ({@code resources/trigger-ui-schema.json}). This is the single unified model that supersedes the
 * earlier two-model design ({@code service-creation.json} + {@code service-metadata.json}): one
 * document unifies the add-trigger init form ({@code initProperties}) with the service type(s) and
 * their handler functions ({@code serviceTypes}).
 *
 * <p>It mirrors the authoring spec ({@code spec.bal}) one-to-one. The core principle is that
 * everything configurable is a {@link Property} that is BOTH a UI widget ({@code types[].fieldType})
 * and a code-generation instruction ({@code codedata}); a {@link Parameter} carries its {@code type}
 * and {@code name} as {@code Property} sub-nodes.
 *
 * <p>These are plain Gson DTOs (records). Gson 2.10+ deserializes records via their canonical
 * constructor and ignores unknown JSON fields, which preserves the schema's forward-compatible
 * {@code additionalProperties: true} contract (unknown {@code fieldType}/{@code codedata} roles and
 * the leading {@code $comment} key degrade gracefully). Adapters translate these into the wire POJOs
 * ({@code Service}/{@code Function}/{@code Value}).
 *
 * <p>Open-vocabulary and dual-typed fields are kept as {@code String}/{@code Object}: {@code fieldType}
 * is an open string; {@code PropertyType.template} is a {@code Property}-or-{@code String} union;
 * {@code Property.value} is an arbitrary JSON scalar. These are resolved by the generator/adapters,
 * not here.
 *
 * @param schemaVersion    the {@code trigger-ui-schema.json} schema version this document conforms to
 * @param id               the connector's catalog identifier
 * @param displayName      the human-readable connector name shown in the designer
 * @param description      the connector's summary description
 * @param orgName          the Ballerina organization that owns the connector package
 * @param packageName      the Ballerina package name
 * @param moduleName       the Ballerina module name
 * @param version          the connector package version
 * @param type             the entry-point kind bucket used for icon/category fallback (e.g.
 *                         {@code event}/{@code file}/{@code http}/{@code graphql}/{@code ai})
 * @param icon             the connector's icon URL
 * @param kind             the connector's document kind as declared by the authoring spec (mirrors
 *                         {@code spec.bal})
 * @param listenerKind     the listener property's widget in the designer (a {@code Value.FieldType}
 *                         name, e.g. {@code SINGLE_SELECT_LISTENER} / {@code MULTIPLE_SELECT_LISTENER}):
 *                         whether a service may bind one or several listeners of this connector's type.
 *                         Defaults to {@code SINGLE_SELECT_LISTENER} when a model omits it.
 * @param initProperties   the add-trigger init form's fields, keyed by property name
 * @param serviceTypes     the connector's service-object type(s) and their handler functions
 * @param readOnlyMetadata the read-only summary chips shown in the service-card header
 * @param importStatements additional raw import statements the generated source must include
 * @param importPrefix     optional override for the import prefix the connector's own module is
 *                         referenced under in generated source. Absent/blank -> the generator computes
 *                         one (a camelCase join of a dotted module name, e.g. {@code trigger.twilio} ->
 *                         {@code triggerTwilio}, so it cannot clash with a base {@code ballerinax/twilio}
 *                         import; a single-segment module keeps its natural prefix, unaliased).
 * @since 1.9.0
 */
public record TriggerUISchemaModel(
        String schemaVersion,
        String id,
        String displayName,
        String description,
        String orgName,
        String packageName,
        String moduleName,
        String version,
        String type,
        String icon,
        String kind,
        String listenerKind,
        Map<String, Property> initProperties,
        List<ServiceTypeModel> serviceTypes,
        List<ReadOnlyMetadata> readOnlyMetadata,
        List<String> importStatements,
        String importPrefix) {

    /**
     * A service-object type and its handler functions. {@code functions} are present/locked
     * handlers; {@code schemaFunctions} are addable templates. {@code properties} carries
     * service-level config / annotations. For multi-type connectors {@code enabled} marks the
     * selected type.
     *
     * @param metadata        display metadata for this service type
     * @param name            the service type's identifier (e.g. the {@code ServiceType} name)
     * @param description     the service type's description
     * @param enabled         for a multi-type connector, whether this is the selected type
     * @param editable        whether the service type selection may be changed
     * @param properties      service-level config / annotation fields, keyed by property name
     * @param functions       the present/locked handler functions
     * @param schemaFunctions the still-addable handler templates
     * @param codedata        source-generation semantics for this service type
     */
    public record ServiceTypeModel(
            Metadata metadata,
            String name,
            String description,
            Boolean enabled,
            Boolean editable,
            Map<String, Property> properties,
            List<FunctionModel> functions,
            List<FunctionModel> schemaFunctions,
            Codedata codedata) {
    }

    /**
     * The recursive building block of every form. The four boolean markers
     * ({@code enabled}/{@code editable}/{@code optional}/{@code advanced}) are required by the schema.
     * Leaves carry {@code types} + {@code value}; containers carry {@code properties}; choices carry
     * {@code choices}.
     *
     * @param metadata    display metadata for this field
     * @param enabled     whether this field is currently active/included
     * @param editable    whether the user may change this field's value
     * @param optional    whether this field may be omitted/disabled
     * @param advanced    whether this field is tucked behind an "advanced" toggle in the form
     * @param placeholder the placeholder/default rendering shown when {@code value} is unset
     * @param value       this field's current value (an arbitrary JSON scalar)
     * @param types       the candidate rendering descriptors; the {@code selected:true} one is active
     * @param items       enumerated option values, for a list-typed field
     * @param choices     the alternative sub-forms, for a CHOICE-typed field
     * @param properties  nested fields, for a container field
     * @param codedata    source-generation semantics for this field
     * @param validations the named validation rules bound to this field
     */
    public record Property(
            Metadata metadata,
            boolean enabled,
            boolean editable,
            boolean optional,
            boolean advanced,
            String placeholder,
            Object value,
            List<PropertyType> types,
            List<String> items,
            List<Property> choices,
            Map<String, Property> properties,
            Codedata codedata,
            List<ValidationRule> validations) {
    }

    /**
     * A candidate rendering descriptor. The entry with {@code selected:true} is the active widget.
     * {@code template} is a {@code Property} (REPEATABLE_LIST element clone) OR a {@code String}
     * type-wrap (e.g. {@code "{{type}}[]"}), hence {@code Object}.
     *
     * @param fieldType     the widget kind (an open string, e.g. {@code TEXT}/{@code CHOICE}/
     *                      {@code REPEATABLE_LIST})
     * @param selected      whether this is the currently active rendering
     * @param ballerinaType the Ballerina type this widget produces/expects
     * @param options       the selectable options, for an enum-like widget
     * @param typeMembers   the selectable record/union members, for a TYPE / RECORD_MAP_EXPRESSION field
     * @param template      the element clone (a {@code Property}) or type-wrap string (e.g.
     *                      {@code "{{type}}[]"}) this rendering composes onto the bound value
     * @param formats       the data-binding definition formats offered, for a PAYLOAD_TYPE field
     * @param validations   the named validation rules bound to this rendering
     */
    public record PropertyType(
            String fieldType,
            boolean selected,
            String ballerinaType,
            List<Option> options,
            List<TypeMember> typeMembers,
            Object template,
            List<PayloadFormat> formats,
            List<ValidationRule> validations) {
    }

    /**
     * A trigger handler / resource definition. Rich enough to render the add/edit-function dialog
     * and generate the Ballerina function source.
     *
     * @param metadata            display metadata for this handler
     * @param name                the emitted function name
     * @param nameEditable        whether the emitted name may be changed when adding this handler
     * @param nameMetadata        display metadata for the name field itself when {@code nameEditable}
     *                            is {@code true} (e.g. {@code "Function Name"} / {@code "The name of
     *                            the function"}) — falls back to {@code metadata} when absent, so
     *                            existing schemas need no change
     * @param kind                the function's syntax kind (e.g. {@code REMOTE}/{@code RESOURCE})
     * @param accessor            the resource accessor (e.g. {@code get}), for a resource function
     * @param qualifiers          the function's source qualifiers (e.g. {@code remote}/{@code resource})
     * @param group               the handler-catalog group this variant belongs to, if any (see
     *                            {@link Repeatable})
     * @param variantLabel        this variant's label within its {@code group}
     * @param enabled             whether this handler is currently present/enabled
     * @param editable            whether this handler's fields may be edited
     * @param optional            whether this handler may be removed once present
     * @param canAddParameters    whether the user may append extra parameters beyond the schema's own
     *                            (see {@code parameterSchema})
     * @param repeatable          how this handler may be added to the addable catalog (see
     *                            {@link Repeatable})
     * @param documentation       the handler's doc-comment text emitted above the generated function,
     *                            for a fixed (non-editable) handler
     * @param documentationSchema when present, makes the handler's doc-comment a user-editable field
     *                            (e.g. MCP's "Tool Description") driven by this template's own
     *                            label/placeholder/description, instead of the fixed
     *                            {@code documentation} string — layered onto the same
     *                            {@code Function.documentation} the generic emitter
     *                            ({@code Utils#getDocumentationEdits}) already renders as a
     *                            {@code # ...} doc comment, so no new emission logic is needed
     * @param parameters          the handler's parameters
     * @param parameterSchema     the addable parameter template(s) offered when {@code canAddParameters}
     *                            is {@code true}, keyed by kind (e.g. {@code parameter} for a plain
     *                            user-typed parameter, {@code header} for an individually bound
     *                            {@code @http:Header} parameter) — the schema-driven counterpart of a
     *                            non-schema-driven builder's hardcoded {@code Function.schema} (see e.g.
     *                            {@code functions/http_resource.json}'s {@code schema} map). A
     *                            {@code header} template's own {@code documentation} sub-property is
     *                            optional — HTTP's header form has none; a connector that needs one per
     *                            header (e.g. MCP) declares it and the header editor picks it up.
     * @param properties          the handler's annotation / composition fields, keyed by property name
     * @param returnType          the handler's return type
     * @param codedata            source-generation semantics for this handler
     * @param validations         the named validation rules bound to this handler
     */
    public record FunctionModel(
            Metadata metadata,
            String name,
            Boolean nameEditable,
            Metadata nameMetadata,
            String kind,
            String accessor,
            List<String> qualifiers,
            String group,
            String variantLabel,
            boolean enabled,
            Boolean editable,
            Boolean optional,
            Boolean canAddParameters,
            Repeatable repeatable,
            String documentation,
            Property documentationSchema,
            List<Parameter> parameters,
            Map<String, Parameter> parameterSchema,
            Map<String, Property> properties,
            ReturnType returnType,
            Codedata codedata,
            List<ValidationRule> validations) {
    }

    /**
     * A function parameter whose {@code type} and {@code name} are {@link Property} sub-nodes, so a
     * parameter is rendered and generated with the same generic walk as any form field. Also doubles
     * as an addable-parameter <b>template</b> when it appears under a {@link FunctionModel}'s
     * {@code parameterSchema} rather than its {@code parameters} — {@code defaultValue}/
     * {@code documentation}/{@code headerName} are meaningful in that role (a plain {@code parameters}
     * entry normally leaves them unset).
     *
     * @param metadata      display metadata for this parameter
     * @param kind          the parameter's kind (e.g. {@code REQUIRED}/{@code OPTIONAL}/
     *                      {@code DATA_BINDING})
     * @param type          the parameter's type, as a {@code Property} sub-node
     * @param name          the parameter's identifier, as a {@code Property} sub-node
     * @param defaultValue  the parameter's default value, as a {@code Property} sub-node (template use)
     * @param documentation the parameter's doc text, as a {@code Property} sub-node (template use)
     * @param headerName    the wire HTTP header name, when it differs from {@code name}'s identifier
     *                      (template use — pairs with {@code httpParamType == HEADER}); left unset, the
     *                      header name is derived from the identifier at emit time
     * @param httpParamType marks this as an HTTP-bound parameter template ({@code HEADER} is the only
     *                      value currently emitted by the schema-driven path — {@code QUERY}/
     *                      {@code PAYLOAD} are HTTP-resource-only concepts today), mirroring
     *                      {@code functions/http_resource.json}'s {@code schema.*.httpParamType}
     * @param enabled       whether this parameter is currently included in the emitted signature
     * @param editable      whether the user may change this parameter's fields
     * @param optional      whether this parameter may be omitted from the emitted signature
     * @param advanced      whether this parameter is tucked behind an "advanced" toggle in the form
     * @param hidden        whether this parameter is fixed/internal and not shown to the user
     * @param codedata      source-generation semantics for this parameter
     * @param validations   the named validation rules bound to this parameter
     */
    public record Parameter(
            Metadata metadata,
            String kind,
            Property type,
            Property name,
            Property defaultValue,
            Property documentation,
            Property headerName,
            String httpParamType,
            Boolean enabled,
            Boolean editable,
            Boolean optional,
            Boolean advanced,
            Boolean hidden,
            Codedata codedata,
            List<ValidationRule> validations) {
    }

    /**
     * The return type of a handler. {@code enabled:false} = returns {@code ()}; {@code optional} =
     * nilable ({@code T?}); {@code hasError} = error union.
     *
     * @param metadata         display metadata for the return type field
     * @param type             the rendered return type text
     * @param typeEditable     whether the user may change the return type
     * @param typeConstraint   the type constraint the user's chosen type must satisfy, if any
     * @param enabled          whether a return type is emitted at all ({@code false} = returns
     *                         {@code ()})
     * @param editable         whether the user may edit this field
     * @param optional         whether the return type is nilable ({@code T?})
     * @param hasError         whether the return type includes an error union
     * @param importStatements additional import statements the return type requires
     * @param codedata         source-generation semantics for the return type
     * @param validations      the named validation rules bound to the return type
     */
    public record ReturnType(
            Metadata metadata,
            String type,
            Boolean typeEditable,
            String typeConstraint,
            boolean enabled,
            Boolean editable,
            Boolean optional,
            Boolean hasError,
            String importStatements,
            Codedata codedata,
            List<ValidationRule> validations) {
    }

    /**
     * Source-generation semantics for a node. Fields are used selectively per {@code type} role;
     * {@code type}/{@code argType} are open strings. {@code modifiers} is an open object. A leaf's
     * rendered value kind (e.g. string quoting) is derived from the node's {@code types[]}
     * ({@code fieldType}/{@code ballerinaType}), not carried here.
     *
     * @param type           the node's semantic role (an open string, e.g. {@code PAYLOAD_TYPE}/
     *                       {@code FUNCTION_PARAM}/{@code LISTENER_VAR_NAME}); interpreted per-role by
     *                       the generator/adapters
     * @param argType        how a listener-config field is placed as a constructor argument (an open
     *                       string, e.g. {@code LISTENER_PARAM_REQUIRED}/
     *                       {@code LISTENER_PARAM_INCLUDED_FIELD})
     * @param originalName   the field/annotation's real name in the underlying Ballerina API, when it
     *                       differs from the display key
     * @param moduleName     the Ballerina module this node's type/annotation belongs to
     * @param orgName        the Ballerina organization this node's type/annotation belongs to
     * @param packageName    the Ballerina package this node's type/annotation belongs to
     * @param position       this node's positional slot among a listener's constructor arguments
     * @param path           a dotted path (e.g. {@code auth.credentials.username}) nesting this leaf
     *                       into a record literal at code-generation time
     * @param defaultType    the payload's default bound type when the user has not selected a custom
     *                       one
     * @param boundType      the payload's user-selected bound type, overriding {@code defaultType}
     * @param bindable       whether this PAYLOAD_TYPE field may be data-bound to a user-selected type
     * @param bindingKind    how the bound type was determined (e.g. user-selected vs. schema-inferred)
     * @param typeConstraint the type constraint a bound/chosen type must satisfy
     * @param template       the composition template applied to the bound element (e.g.
     *                       {@code "{{type}}[]"}, {@code "stream<{{type}}, error?>"})
     * @param modifier       the PAYLOAD_MODIFIER's short name (e.g. {@code stream})
     * @param supersedes     the other PAYLOAD_MODIFIER names this modifier takes precedence over when
     *                       multiple are active
     * @param targetParam    the parameter this PAYLOAD_MODIFIER's composition applies to
     * @param modifiers      open, node-specific source-generation options not covered by the named
     *                       fields above
     * @param field          the record field name this node binds to (e.g. the included-record
     *                       wrapper's payload field)
     * @param optional       whether this node's presence in the generated source is optional
     * @param value          an open literal value used when rendering this node (e.g. an ENUM_LITERAL's
     *                       source text)
     * @param valueQualifier the module/type qualifier prefixed onto {@code value} when rendering (e.g.
     *                       {@code ftp} for {@code ftp:FTPS})
     * @param group          the handler-catalog group this node belongs to, mirroring
     *                       {@link FunctionModel#group}
     * @param variantLabel   this node's variant label within its {@code group}
     * @param nameEditable   whether the bound parameter's identifier (e.g. kafka's {@code records}, the
     *                       CDC {@code before}/{@code after}) may be renamed in the edit UI. Some
     *                       connectors bind to a fixed, structural identifier the generated code and its
     *                       surrounding annotations refer to by name — only the bound type is
     *                       user-selected there. Unset defaults to editable ({@code true}), matching
     *                       FTP's genuinely user-named payload.
     */
    public record Codedata(
            String type,
            String argType,
            String originalName,
            String moduleName,
            String orgName,
            String packageName,
            Integer position,
            String path,
            String defaultType,
            String boundType,
            Boolean bindable,
            String bindingKind,
            String typeConstraint,
            String template,
            String modifier,
            List<String> supersedes,
            String targetParam,
            Object modifiers,
            String field,
            Boolean optional,
            String value,
            String valueQualifier,
            String group,
            String variantLabel,
            Boolean nameEditable) {
    }

    /**
     * An inline selectable option for SINGLE_SELECT / ENUM / CHOICE / VARIATION_SELECTOR.
     *
     * @param label      the option's display text
     * @param value      the option's underlying value
     * @param helperText supplementary explanatory text shown alongside the option
     */
    public record Option(
            String label,
            String value,
            String helperText) {
    }

    /**
     * A selectable record/union member offered by a TYPE / RECORD_MAP_EXPRESSION field.
     *
     * @param type        the member's type name
     * @param packageInfo the member's declaring package, in {@code org:package:version} form
     * @param packageName the member's declaring package name
     * @param kind        the member's type kind (e.g. {@code RECORD_TYPE})
     * @param selected    whether this member is the currently selected one
     */
    public record TypeMember(
            String type,
            String packageInfo,
            String packageName,
            String kind,
            Boolean selected) {
    }

    /**
     * How a data-binding type may be defined by the user (offered by a PAYLOAD_TYPE field).
     *
     * @param supported     the definition formats offered (e.g. {@code schema}/{@code browse}/
     *                      {@code json}/{@code xml})
     * @param defaultFormat the format selected by default
     */
    public record PayloadFormat(
            List<String> supported,
            String defaultFormat) {
    }

    /**
     * A read-only summary chip in the service-card header (derived from source).
     *
     * @param key         the chip's identifying key
     * @param displayName the chip's display label
     * @param kind        how the value is extracted from the source (an open string; interpreted by
     *                    the matching extractor)
     * @param paramKind   the source parameter kind to resolve the value from, when {@code kind} needs
     *                    one
     * @param path        a dotted path narrowing the value within the resolved source construct
     */
    public record ReadOnlyMetadata(
            String key,
            String displayName,
            String kind,
            String paramKind,
            String path) {
    }

    /**
     * A reference to a named validation rule.
     *
     * @param rule     the validation rule's name
     * @param args     the rule's arguments, keyed by parameter name
     * @param message  the message shown when this rule fails, overriding the rule's own default
     * @param severity the diagnostic severity reported when this rule fails
     */
    public record ValidationRule(
            String rule,
            Map<String, Object> args,
            String message,
            String severity) {
    }

    /**
     * Display metadata for any UI node.
     *
     * @param label       the display name shown for this node
     * @param description the explanatory text shown alongside the label
     * @param notice      an optional callout message (e.g. a deprecation notice)
     * @param icon        an optional icon identifier for the front end to render next to the label
     * @param subLabel    optional secondary text shown beneath the label
     * @param addLabel    the label shown on the affordance that adds this node (e.g. a handler's
     *                    "Add ..." button text)
     * @param groupName   the display name of the {@code group} this node's handler-catalog entry
     *                    belongs to
     * @param badge       a short category tag rendered as a chip before the node's label
     */
    public record Metadata(
            String label,
            String description,
            String notice,
            String icon,
            String subLabel,
            String addLabel,
            String groupName,
            String badge) {
    }
}
