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

/**
 * The API facts {@link TriggerLibraryIntrospector} resolves from a connector's compiled semantic
 * model: its listener's init-parameter <b>structure</b> (names, kind, optionality, and
 * included-record field expansion -- but deliberately not a rendered widget), its service object
 * types (with their remote/resource functions), and declared annotations. Facts only -- no labels,
 * defaults, or curation. A {@code TriggerUISchemaModel} synthesizer combines these with a connector's
 * {@link TriggerMetadataModel} to fill in what the authoring-rules document only references by name
 * (the governing DRY principle behind both documents: introspectable facts live here, never restated
 * there).
 *
 * <p><b>{@link Listener} carries structure only, not rendering.</b> Which init params exist, which
 * are an {@code INCLUDED_RECORD} spread (whose fields become independently-named constructor
 * arguments, consuming no positional slot of their own) versus a plain record-typed parameter (whose
 * fields render as one record-literal argument at its own slot) is exactly the fact a synthesizer
 * needs to correctly place each value as a listener constructor argument -- but is NOT enough to
 * decide by itself which UI widget (record editor, number field, text field, ...) to render for a
 * given parameter's type. That resolution is already solved, for an arbitrary listener class by name,
 * by {@code ListenerUtil#getListenerModelByName} (the same utility the non-schema-driven "add
 * listener" flow already uses); a synthesizer calls that directly for widgets/values and consults
 * this structure only to assign the correct {@code argType}/position codedata.
 *
 * @param listeners    every {@code Listener}-named or Listener-type-including class in the module
 * @param serviceTypes every {@code service} object type declared in the module
 * @param annotations  every annotation declared in the module
 * @since 1.10.0
 */
public record TriggerLibraryFacts(List<Listener> listeners, List<ServiceType> serviceTypes,
                                  List<Annotation> annotations) {

    /**
     * A listener class and the structure of its init parameters (not their rendering -- see the
     * class javadoc).
     *
     * @param type       the listener's module-qualified name, e.g. {@code "kafka:Listener"}
     * @param initParams the init method's parameters, in declaration order
     */
    public record Listener(String type, List<Param> initParams) {
    }

    /**
     * A declared function parameter, or a record field reached while expanding one -- one node in
     * the (possibly recursive, for a record-typed parameter) parameter tree.
     *
     * @param name     the parameter/field name; {@code ""} for an unnamed rest parameter
     * @param type     the type's signature, e.g. {@code "string"}, {@code "kafka:ConsumerConfig"}
     * @param optional {@code true} for a defaultable/included-record parameter, or an
     *                optional/defaulted record field
     * @param kind     {@code REQUIRED}/{@code DEFAULTABLE}/{@code INCLUDED_RECORD}/{@code REST} for
     *                a function parameter, or {@code RECORD_FIELD} for a field reached by expanding
     *                a record-typed parameter
     * @param doc      the parameter's/field's documentation description; {@code ""} if undocumented
     * @param fields   the expanded fields when {@code type} is a record (or a union of records, or a
     *                type reference to either) -- depth-capped and recursive; {@code []} for a
     *                non-record type
     */
    public record Param(String name, String type, boolean optional, String kind, String doc, List<Param> fields) {
    }

    /**
     * A remote or resource function declared on a service type.
     *
     * @param name         the function name
     * @param qualifiers   the function's declared qualifiers (e.g. {@code "remote"}, {@code "resource"})
     * @param kind         {@code REMOTE} or {@code RESOURCE}
     * @param returnType   the return type's signature; {@code null} if the function declares no
     *                    return type
     * @param returnsError {@code true} if the return type's signature contains {@code error}
     * @param doc          the function's documentation description; {@code ""} if undocumented
     * @param parameters   the function's parameters, in declaration order
     */
    public record Function(String name, List<String> qualifiers, String kind, String returnType,
                           boolean returnsError, String doc, List<Param> parameters) {
    }

    /**
     * A {@code service} object type declared in the module.
     *
     * @param name      the type's name
     * @param doc       the type's documentation description; {@code ""} if undocumented
     * @param functions its declared remote/resource functions
     */
    public record ServiceType(String name, String doc, List<Function> functions) {
    }

    /**
     * An annotation declared in the module.
     *
     * @param name             the annotation name
     * @param module           the module the annotation is declared in; {@code ""} if unresolvable
     * @param typeConstraint   the annotation record's type signature; {@code null} for a marker
     *                        annotation with no attached type
     * @param attachmentPoints the syntactic attach points the annotation declares
     * @param doc              the annotation's documentation description; {@code ""} if undocumented
     * @param fields           the expanded fields of the annotation's record type (same expansion as
     *                        {@link Param#fields()}), so a synthesizer can pre-fill a skeleton value
     *                        for the attachment instead of an empty {@code {}}; {@code []} for a
     *                        marker annotation with no attached type
     */
    public record Annotation(String name, String module, String typeConstraint, List<String> attachmentPoints,
                             String doc, List<Param> fields) {
    }
}
