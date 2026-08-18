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
 * Deserialization target for a connector's {@code resources/trigger-metadata.json}, per the
 * Ballerina Trigger Construct Spec v1.0.
 *
 * @param version spec version this instance conforms to, e.g. {@code "v1.0"}
 * @param listeners listener entry points
 * @param serviceTypes service type alternatives this connector exposes
 * @param annotations annotation types referenced elsewhere, defined once
 * @param rules constraints spanning more than one service type
 * @since 1.10.0
 */
public record TriggerMetadataModel(
        String version,
        List<Listener> listeners,
        List<ServiceType> serviceTypes,
        List<Annotation> annotations,
        List<Rule> rules) {

    /**
     * @param type the listener type
     * @param deprecated why this construct is deprecated, if it is
     * @param services serviceTypes ids this listener can host
     * @param multipleServicesAllowed can one instance host more than one service at all?
     * @param multipleServicesOfSameTypeAllowed can two of those be the same type? {@code null} means unconstrained
     * @param requiredImports side-effect-only imports, never referenced by name
     * @param platformDependencies native dependencies declared in {@code Ballerina.toml}
     */
    public record Listener(
            TypeRef type,
            String deprecated,
            List<String> services,
            boolean multipleServicesAllowed,
            Boolean multipleServicesOfSameTypeAllowed,
            List<RequiredImport> requiredImports,
            List<PlatformDependency> platformDependencies) {
    }

    /**
     * @param importType the kind of required import
     * @param packageInfo the package to import
     */
    public record RequiredImport(String importType, TypeRef.PackageInfo packageInfo) {

        public static final String IMPORT_TYPE_DRIVER = "driver";
    }

    /**
     * @param groupId Maven group id
     * @param artifactId Maven artifact id
     * @param version Maven version, may be a wildcard such as {@code "3.1.*"}
     * @param scope {@link #SCOPE_PROVIDED} keeps the jar compile-time only; absent means bundled
     * @param acquisition how to get an artifact no public repository serves
     * @param nativeLibraries OS-specific libraries needed at run time
     */
    public record PlatformDependency(
            String groupId,
            String artifactId,
            String version,
            String scope,
            Acquisition acquisition,
            List<NativeLibrary> nativeLibraries) {

        public static final String SCOPE_PROVIDED = "provided";
    }

    /**
     * @param url machine-actionable acquisition URL
     * @param note human-readable instructions
     */
    public record Acquisition(String url, String note) {
    }

    /**
     * @param os {@link #OS_LINUX}, {@link #OS_WINDOWS} or {@link #OS_MACOS}
     * @param file the native library file name
     */
    public record NativeLibrary(String os, String file) {

        public static final String OS_LINUX = "linux";
        public static final String OS_WINDOWS = "windows";
        public static final String OS_MACOS = "macos";
    }

    /**
     * @param id referenced from {@code listeners[].services} and sibling constructs
     * @param type the service object type
     * @param deprecated why this construct is deprecated, if it is
     * @param concrete true when the type's own methods are introspectable
     * @param multipleListenersAllowed can one service attach to more than one listener at once?
     * @param annotations ids of annotations with {@code attachPoint: "service"}
     * @param identifier omitted when the identifier slot carries no meaning
     * @param handlers the handler shape block
     * @param rules constraints scoped to this service type
     */
    public record ServiceType(
            String id,
            TypeRef type,
            String deprecated,
            boolean concrete,
            boolean multipleListenersAllowed,
            List<String> annotations,
            IdentifierSpec identifier,
            Handlers handlers,
            List<Rule> rules) {

        /**
         * @param backedByConcreteType true means the type's own methods are the handlers
         * @param options only when {@code backedByConcreteType} is {@code false}
         */
        public record Handlers(boolean backedByConcreteType, List<HandlerOption> options) {
        }

        /**
         * @param name the handler method name, or {@code "*"} for an open handler
         * @param kind {@link #KIND_REMOTE} or {@link #KIND_RESOURCE}
         * @param addMode {@link #ADD_MODE_SUBSET} (default) or {@link #ADD_MODE_MANY}
         * @param doc what this handler is for and when it fires
         * @param deprecated why this construct is deprecated, if it is
         * @param presence only under {@code addMode: "subset"}
         * @param annotations ids of annotations with {@code attachPoint: "function"}
         * @param returnAnnotations ids of annotations with {@code attachPoint: "return"}
         * @param params the handler's parameters
         * @param returns the handler's possible return types
         * @param accessor resource kind only
         * @param path resource kind only
         */
        public record HandlerOption(
                String name,
                String kind,
                String addMode,
                String doc,
                String deprecated,
                String presence,
                List<String> annotations,
                List<String> returnAnnotations,
                List<Param> params,
                List<TypeRef> returns,
                ValueSpec accessor,
                ValueSpec path) {

            public static final String KIND_REMOTE = "remote";
            public static final String KIND_RESOURCE = "resource";
            public static final String ADD_MODE_SUBSET = "subset";
            public static final String ADD_MODE_MANY = "many";
            public static final String WILDCARD_NAME = "*";
        }

        /**
         * @param name the parameter name to emit; omitted only when {@code addMode} is {@code "many"}
         * @param doc what this parameter carries
         * @param deprecated why this construct is deprecated, if it is
         * @param type the parameter's possible types
         * @param presence required or optional
         * @param addMode {@link #ADD_MODE_MANY} when the slot repeats
         * @param dataBinding present only when the value can be projected into a user-defined type
         * @param annotations ids of annotations with {@code attachPoint: "parameter"}
         */
        public record Param(
                String name,
                String doc,
                String deprecated,
                List<TypeRef> type,
                String presence,
                String addMode,
                DataBinding dataBinding,
                List<String> annotations) {

            public static final String ADD_MODE_MANY = "many";
        }

        /** @param typedescs independent variants that share nothing */
        public record DataBinding(List<TypedescVariant> typedescs) {
        }

        /**
         * @param constraint this variant's upper bound; one type, never a union
         * @param excludes instantiations another variant already owns
         * @param shapes legal embeddings of this variant's bound
         */
        public record TypedescVariant(TypeRef constraint, List<TypeRef> excludes, List<Shape> shapes) {
        }

        /**
         * @param form {@link #FORM_BARE}, {@link #FORM_ARRAY}, {@link #FORM_STREAM} or {@link #FORM_INCLUDED}
         * @param element for array/stream, whether each element is bare or included
         * @param envelope the envelope type, for {@code included}
         * @param bindableFields fields bound to this variant, for {@code included}
         * @param completionType a union with {@code ()} when nilable, for {@code stream}
         */
        public record Shape(String form, String element, TypeRef envelope, List<String> bindableFields,
                            List<TypeRef> completionType) {

            public static final String FORM_BARE = "bare";
            public static final String FORM_ARRAY = "array";
            public static final String FORM_STREAM = "stream";
            public static final String FORM_INCLUDED = "included";

            public static final String ELEMENT_BARE = "bare";
            public static final String ELEMENT_INCLUDED = "included";
        }
    }

    /**
     * A named constraint from an open registry; {@code rule} decides how {@code subjects} is read.
     *
     * @param id stable and unique within the file
     * @param rule registry id, e.g. {@code "structure.exactlyOne"}
     * @param subjects what the constraint ranges over
     * @param severity {@link #SEVERITY_ERROR} (default) or {@link #SEVERITY_WARNING}
     * @param message diagnostic text for a consumer to surface
     * @param prefer role a generator should default to; a hint, not part of the constraint
     */
    public record Rule(String id, String rule, List<Subject> subjects, String severity, String message,
                       String prefer) {

        public static final String RULE_EXACTLY_ONE = "structure.exactlyOne";
        public static final String RULE_AT_MOST_ONE = "structure.atMostOne";
        public static final String RULE_AT_LEAST_ONE = "structure.atLeastOne";
        public static final String RULE_ALL_OR_NONE = "structure.allOrNone";
        public static final String RULE_REQUIRES = "structure.requires";
        public static final String RULE_CONFLICTS_WITH = "structure.conflictsWith";

        public static final String SEVERITY_ERROR = "error";
        public static final String SEVERITY_WARNING = "warning";
    }

    /**
     * A tagged union over {@code kind}; only the fields that kind uses are populated.
     *
     * @param kind {@link #KIND_IDENTIFIER}, {@link #KIND_ANNOTATION}, {@link #KIND_ANNOTATION_FIELD},
     *             {@link #KIND_HANDLER} or {@link #KIND_PARAM}
     * @param name an annotation id ({@code annotation} kind) or a handler name ({@code handler} kind)
     * @param annotation annotation id, for {@code annotationField}
     * @param path field path inside the annotation record, for {@code annotationField}
     * @param handler handler name, for {@code param}
     * @param serviceType defaults to the enclosing service type; required in a top-level rule
     * @param role this subject's name within its rule
     */
    public record Subject(String kind, String name, String annotation, List<String> path, String handler,
                          String serviceType, String role) {

        public static final String KIND_IDENTIFIER = "identifier";
        public static final String KIND_ANNOTATION = "annotation";
        public static final String KIND_ANNOTATION_FIELD = "annotationField";
        public static final String KIND_HANDLER = "handler";
        public static final String KIND_PARAM = "param";
    }

    /**
     * @param id referenced from whichever construct the annotation attaches to
     * @param type the annotation's type, may be cross-module
     * @param attachPoint {@link #ATTACH_POINT_SERVICE}, {@link #ATTACH_POINT_FUNCTION},
     *                    {@link #ATTACH_POINT_PARAMETER} or {@link #ATTACH_POINT_RETURN}
     * @param presence required or optional
     */
    public record Annotation(String id, TypeRef type, String attachPoint, String presence) {

        public static final String ATTACH_POINT_SERVICE = "service";
        public static final String ATTACH_POINT_FUNCTION = "function";
        public static final String ATTACH_POINT_PARAMETER = "parameter";
        public static final String ATTACH_POINT_RETURN = "return";

        public static final String PRESENCE_REQUIRED = "required";
        public static final String PRESENCE_OPTIONAL = "optional";
    }
}
