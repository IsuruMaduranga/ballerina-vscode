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

package io.ballerina.modelgenerator.commons;

/**
 * A structured, multi-representation icon descriptor for a trigger/service artifact, per the Phase-6
 * <i>Icon &amp; Label Resolution</i> architecture. It carries every representation the resolver could
 * determine so each surface can pick the best one it can render and always has a guaranteed default.
 *
 * <p>Ownership: the <b>Language Server</b> fills {@link #url} (a connector-declared icon or the derived
 * Ballerina Central URL), {@link #kind}, {@link #source}, and — when the connector declared them in its
 * trigger metadata — {@link #glyph}/{@link #color}. The <b>IDE</b> completes any missing
 * {@code glyph}/{@code color} from its brand-icon registry and applies the {@code kind} default, then
 * picks the representation for its surface.
 *
 * @param url    a directly renderable image URL (connector-declared, a package resource served as a
 *               {@code data:} URI, or the derived Central PNG); {@code null} when none is known
 * @param glyph  the IDE brand-glyph key (e.g. {@code "bi-rabbitmq"}); {@code null} when not declared
 * @param color  optional tint for a monochrome {@link #glyph} (e.g. {@code "#f60"}); {@code null} when
 *               not declared
 * @param kind   semantic bucket ({@code event | file | http | graphql | ai | listener}) that drives the
 *               guaranteed default icon; {@code null} only when the module declares no metadata
 * @param source provenance of {@link #url}: {@code declared | package | central | derived}
 * @param light  a theme-specific image for light themes (connector-declared package resource served as
 *               a {@code data:} URI); paired with {@link #dark} so a surface can switch per theme;
 *               {@code null} when the connector ships no light/dark pair
 * @param dark   the dark-theme counterpart of {@link #light}; {@code null} when none
 * @since 1.9.0
 */
public record IconDescriptor(String url, String glyph, String color, String kind, String source,
                             String light, String dark) {

    public static final String SOURCE_DECLARED = "declared";
    public static final String SOURCE_PACKAGE = "package";
    public static final String SOURCE_CENTRAL = "central";
}
