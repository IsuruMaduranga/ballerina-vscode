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

package io.ballerina.flowmodelgenerator.core.copilot.service;

import io.ballerina.flowmodelgenerator.core.copilot.model.ConstraintSubject;
import io.ballerina.flowmodelgenerator.core.copilot.model.ServiceConstraint;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;

/**
 * The spec {@code rules[]} — the exclusivity constraints a service type declares.
 *
 * <p><b>Runs before the handler catalog.</b> {@link ConstraintResolver} needs this service type's handler
 * names, so that a {@code {handler}} member naming something absent can be dropped rather than offered to
 * the model as a choice. Those names are read from the document and semantic model directly rather than
 * from the built {@link ServiceDraft}, which keeps this a pure function of its inputs and leaves the
 * registry with a single ordering rule ("the catalog runs last"). They are sourced the same way the catalog
 * itself decides them, by asking {@link HandlerCatalogResolver} which kind of catalog this type has:
 * <ul>
 *   <li>a <b>marker</b> type's names are its non-wildcard {@code options[].name} values;</li>
 *   <li>a <b>concrete</b> type's names come from the semantic model, the same source the catalog reads.</li>
 * </ul>
 *
 * <p>When neither is available — no facts, or a concrete type whose object type does not resolve — the set
 * is passed as {@code null}, which suppresses the cross-check rather than dropping every handler member. An
 * unresolvable type is already vetoed elsewhere and must not additionally cause a rule to be emptied.
 *
 * @since 1.7.0
 */
final class ConstraintAspect {

    private static final Logger LOGGER = Logger.getLogger(ConstraintAspect.class.getName());

    private ConstraintAspect() {
        // Prevent instantiation
    }

    static void contribute(TriggerScope scope, ServiceDraft draft) {
        TriggerMetadataModel.ServiceType serviceType = scope.serviceType();
        if (serviceType == null) {
            return;
        }
        List<TriggerMetadataModel.Rule> rules = new ArrayList<>();
        if (serviceType.rules() != null) {
            rules.addAll(serviceType.rules());
        }
        rules.addAll(spanningRules(scope, serviceType));
        if (rules.isEmpty()) {
            return;
        }
        List<ConstraintResolver.Constraint> constraints = ConstraintResolver.resolve(
                scope.libraryName(), rules, serviceType.id(), index(scope), scope.annotations());
        if (constraints.isEmpty()) {
            return;
        }
        List<ServiceConstraint> resolved = new ArrayList<>();
        constraints.forEach(constraint -> resolved.add(toModel(constraint)));
        draft.setConstraints(resolved);
    }

    /**
     * The spec's <b>top-level</b> {@code rules[]} — constraints spanning more than one service type, where
     * every subject must name its {@code serviceType} — narrowed to the ones this service type
     * participates in.
     *
     * <p>A spanning rule is stated on every participant because entries render independently: a reader
     * looking at one service never sees the other's notes, so stating it once would leave whichever entry
     * they happen to be writing with no mention of the constraint. Restricting it to <i>participants</i>
     * keeps it off the service types it does not govern.
     *
     * <p><b>Latent</b>: no corpus document declares a top-level rule. The key was parsed and validated by
     * {@code RuleRefCheck} but read by nothing on the render path, so the first document to use one would
     * have lost it silently.
     */
    private static List<TriggerMetadataModel.Rule> spanningRules(TriggerScope scope,
                                                                TriggerMetadataModel.ServiceType serviceType) {
        if (scope.document() == null || scope.document().rules() == null || serviceType.id() == null) {
            return List.of();
        }
        List<TriggerMetadataModel.Rule> participating = new ArrayList<>();
        for (TriggerMetadataModel.Rule rule : scope.document().rules()) {
            if (rule == null) {
                continue;
            }
            if (mentions(rule, serviceType.id())) {
                participating.add(rule);
                continue;
            }
            // A rule that names NO service type at all reaches no entry, so it would otherwise disappear
            // from the catalog with no veto and no log line. Reported once per service type rather than
            // globally because this aspect has no library-wide hook.
            //
            // Not a veto: the rule is the document's defect, not this service type's, and dropping a
            // service over another construct's error is exactly what `drop` exists to avoid.
            if (namesNoServiceType(rule)) {
                LOGGER.warning("Skipped top-level rule '" + rule.id() + "' for " + scope.libraryName()
                        + ": The spec requires every subject of a top-level rule to name its `serviceType`,"
                        + " and none of this rule's subjects does, so it reaches no service type.");
            }
        }
        return participating;
    }

    /** Whether no subject of a rule names a service type — which at top level makes it unreachable. */
    private static boolean namesNoServiceType(TriggerMetadataModel.Rule rule) {
        if (rule.subjects() == null || rule.subjects().isEmpty()) {
            return true;
        }
        for (TriggerMetadataModel.Subject subject : rule.subjects()) {
            if (subject != null && subject.serviceType() != null && !subject.serviceType().isBlank()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether a rule names this service type in any subject.
     *
     * <p>A subject naming no {@code serviceType} at all is <b>not</b> read as the enclosing one here, unlike
     * in {@link ConstraintResolver}: at top level the spec requires every subject to name one, so an unnamed
     * subject is a document defect ({@code RuleRefCheck} reports it) and treating it as a match would attach
     * the rule to every service type in the document.
     */
    private static boolean mentions(TriggerMetadataModel.Rule rule, String serviceTypeId) {
        if (rule.subjects() == null) {
            return false;
        }
        for (TriggerMetadataModel.Subject subject : rule.subjects()) {
            if (subject != null && serviceTypeId.equals(subject.serviceType())) {
                return true;
            }
        }
        return false;
    }

    /**
     * The document's service types, for attributing a subject that names one.
     *
     * <p>Handler names are resolved per service type by the same {@link #declaredHandlerNames} the enclosing
     * entry uses, so a spanning rule's subjects are cross-checked against <i>their own</i> catalogs.
     */
    private static ConstraintResolver.ServiceTypeIndex index(TriggerScope scope) {
        Map<String, TriggerMetadataModel.ServiceType> byId = new LinkedHashMap<>();
        if (scope.document() != null && scope.document().serviceTypes() != null) {
            for (TriggerMetadataModel.ServiceType candidate : scope.document().serviceTypes()) {
                if (candidate != null && candidate.id() != null) {
                    byId.putIfAbsent(candidate.id(), candidate);
                }
            }
        }
        return new ConstraintResolver.ServiceTypeIndex() {
            @Override
            public String typeName(String serviceTypeId) {
                TriggerMetadataModel.ServiceType found = byId.get(serviceTypeId);
                return found == null || found.type() == null ? null : found.type().name();
            }

            @Override
            public Set<String> handlerNames(String serviceTypeId) {
                // The ENCLOSING service type is answered from the scope, never through the map. `byId` is
                // built with `putIfAbsent`, so two entries sharing an id would resolve the second one's
                // subjects against the first one's handlers and drop them as phantoms. Nothing validates
                // id uniqueness, and here the right answer is already in hand.
                String enclosingId = scope.serviceType() == null ? null : scope.serviceType().id();
                if (serviceTypeId == null || serviceTypeId.equals(enclosingId)) {
                    return scope.serviceType() == null
                            ? null : declaredHandlerNames(scope, scope.serviceType());
                }
                // An id naming nothing yields `null`, which suppresses the cross-check rather than dropping
                // the subject: the subject itself is dropped by `attribute`, so reaching here means the id
                // resolved and only its catalog is unknown.
                TriggerMetadataModel.ServiceType found = byId.get(serviceTypeId);
                return found == null ? null : declaredHandlerNames(scope, found);
            }
        };
    }

    /**
     * The handler names this service type declares, or {@code null} when the catalog is not knowable.
     */
    private static Set<String> declaredHandlerNames(TriggerScope scope,
                                                    TriggerMetadataModel.ServiceType serviceType) {
        if (!HandlerCatalogResolver.isConcrete(serviceType)) {
            Set<String> names = new LinkedHashSet<>();
            List<TriggerMetadataModel.ServiceType.HandlerOption> options =
                    serviceType.handlers() == null ? null : serviceType.handlers().options();
            if (options == null) {
                return null;
            }
            for (TriggerMetadataModel.ServiceType.HandlerOption option : options) {
                if (option == null || option.name() == null
                        || TriggerMetadataModel.ServiceType.HandlerOption.WILDCARD_NAME
                                .equals(option.name())) {
                    continue;
                }
                names.add(option.name());
            }
            return names;
        }
        // The type's OWN name, not `scope.serviceTypeName()`: this is called for every service type a
        // spanning rule mentions, and reading the enclosing entry's name would cross-check one service
        // type's subjects against another's methods.
        String typeName = serviceType.type() == null ? null : serviceType.type().name();
        if (scope.facts() == null || typeName == null) {
            return null;
        }
        return scope.facts().serviceObjectType(typeName)
                .map(objectType -> {
                    Set<String> names = new LinkedHashSet<>();
                    scope.facts().declaredMethods(objectType)
                            .forEach(method -> names.add(method.name()));
                    return names;
                })
                .orElse(null);
    }

    /**
     * Wire shape: {@code {id?, rule, subjects[], message?, severity?, prefer?}}.
     *
     * <p>The registry id is emitted verbatim rather than a normalized enum name, so a consumer states what
     * the document states. {@code message} is carried because the document's own sentence says <i>why</i> a
     * constraint exists, which a renderer should prefer over anything it can synthesize from the subjects.
     */
    private static ServiceConstraint toModel(ConstraintResolver.Constraint constraint) {
        ServiceConstraint resolved = new ServiceConstraint();
        if (constraint.id() != null && !constraint.id().isEmpty()) {
            resolved.setId(constraint.id());
        }
        resolved.setRule(constraint.kind().registryId());
        List<ConstraintSubject> subjects = new ArrayList<>();
        for (ConstraintResolver.Subject subject : constraint.subjects()) {
            subjects.add(subjectToModel(subject));
        }
        resolved.setSubjects(subjects);
        resolved.setMessage(constraint.message());
        // Emitted only when the document downgrades the rule; `error` is the default and stating it would
        // break the omission rule.
        if (TriggerMetadataModel.Rule.SEVERITY_WARNING.equals(constraint.severity())) {
            resolved.setSeverity(constraint.severity());
        }
        resolved.setPrefer(constraint.prefer());
        return resolved;
    }

    private static ConstraintSubject subjectToModel(ConstraintResolver.Subject subject) {
        ConstraintSubject resolved = new ConstraintSubject();
        switch (subject) {
            case ConstraintResolver.Subject.Identifier ignored ->
                    resolved.setKind(TriggerMetadataModel.Subject.KIND_IDENTIFIER);
            case ConstraintResolver.Subject.Annotation annotation -> {
                resolved.setKind(TriggerMetadataModel.Subject.KIND_ANNOTATION);
                // The resolved name is what a reader must write; the id is kept so the wire still says
                // which registry entry the rule referenced.
                resolved.setAnnotation(annotation.annotationName());
                resolved.setAnnotationId(annotation.annotationId());
            }
            case ConstraintResolver.Subject.AnnotationField field -> {
                resolved.setKind(TriggerMetadataModel.Subject.KIND_ANNOTATION_FIELD);
                resolved.setAnnotation(field.annotationName());
                resolved.setAnnotationId(field.annotationId());
                resolved.setPath(List.copyOf(field.path()));
            }
            case ConstraintResolver.Subject.Handler handler -> {
                resolved.setKind(TriggerMetadataModel.Subject.KIND_HANDLER);
                resolved.setName(handler.name());
            }
            case ConstraintResolver.Subject.Param param -> {
                resolved.setKind(TriggerMetadataModel.Subject.KIND_PARAM);
                resolved.setHandler(param.handler());
                resolved.setName(param.name());
            }
        }
        resolved.setRole(subject.role());
        // The spec: emitted only for a subject belonging to a DIFFERENT service type than the entry being
        // rendered, so a service-type-scoped rule — every rule in the corpus — is byte-identical to before.
        // The resolved type name is what a reader recognises; the id follows it for traceability.
        if (subject.serviceType() != null) {
            resolved.setServiceType(subject.serviceType());
            resolved.setServiceTypeId(subject.serviceTypeId());
        }
        return resolved;
    }
}
