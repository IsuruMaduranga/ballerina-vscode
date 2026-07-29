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

import io.ballerina.modelgenerator.commons.IconDescriptor;

import java.util.List;

/**
 * Deserialization target for a connector's <b>Trigger Artifact</b> metadata
 * ({@code resources/trigger-artifact.json}) — a small, display-only sibling of the (much larger)
 * {@code trigger-ui-schema.json}. It carries what a project-tree / left-panel renderer needs to show an
 * entry-point artifact: its display name, an {@link IconDescriptor} (any of url/glyph/color/kind), and
 * the annotation field(s) (in preference order) that supply the instance-label suffix (e.g.
 * {@code "FTP Integration - /home/in"}).
 *
 * <p>Deliberately kept separate from {@code TriggerUISchemaModel}: reading the full form/service-type/
 * handler schema just to paint a tree node would mean deserializing a document an order of magnitude
 * larger than what the tree actually needs.
 *
 * @param displayName  the label shown for the artifact, e.g. {@code "RabbitMQ Event Integration"}
 * @param icon         the connector-declared {@link IconDescriptor} (any of {@code url}, {@code glyph},
 *                     {@code color}, {@code kind}); all fields optional. The resolver fills {@code url}
 *                     (Central/package) and {@code source} when absent. {@code null} when undeclared.
 * @param labelFields  service-annotation field names to try, in order, for the instance-label suffix
 *                     (e.g. {@code ["queueName", "topicName"]}); {@code null}/empty means no suffix
 * @since 1.9.0
 */
public record TriggerArtifactModel(String displayName, IconDescriptor icon, List<String> labelFields) {
}
