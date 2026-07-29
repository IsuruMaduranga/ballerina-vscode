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

package io.ballerina.modelgenerator.commons.trigger.utils;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonDeserializationContext;
import com.google.gson.JsonDeserializer;
import com.google.gson.JsonElement;
import com.google.gson.JsonParseException;
import com.google.gson.reflect.TypeToken;
import io.ballerina.modelgenerator.commons.trigger.models.TriggerMetadataModel;
import io.ballerina.modelgenerator.commons.trigger.models.TypeRef;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;

/**
 * The {@link Gson} instance for deserializing a {@code trigger-metadata.json} document into a
 * {@link TriggerMetadataModel}.
 *
 * <p>The schema's one shape ambiguity (spec {@code README.md}/{@code spec.md} &sect;1 — "Every place
 * a Ballerina type is referenced ... uses the same shape"): a slot that may hold either a single type
 * or a union is written as a bare object ({@code {"name": "Caller"}}) for the single case and a JSON
 * array for the union case, but is always modeled in Java as {@code List<TypeRef>} so callers never
 * branch on the raw shape. This class registers the one adapter that normalizes both wire shapes onto
 * that one Java shape; every {@code List<TypeRef>} field in the model (params/returns/dataBinding
 * type constraints) shares this single rule.
 *
 * @since 1.10.0
 */
public final class TriggerMetadataGson {

    private static final Type TYPE_REF_LIST = new TypeToken<List<TypeRef>>() { }.getType();

    // A separate, plain Gson instance dedicated to parsing individual TypeRef leaves from within the
    // custom deserializer below. Gson's record support (ReflectiveTypeAdapterFactory$RecordAdapter)
    // reuses a per-adapter constructor-args buffer across invocations; reentering the SAME Gson
    // instance's adapter graph via JsonDeserializationContext.deserialize while an ancestor record
    // (e.g. Param, HandlerOption) is still mid-populate can corrupt that buffer and misassign fields
    // (observed as a ClassCastException between TypeRef and TypeRef[]). Using a wholly separate Gson
    // object -- its own adapter cache, nothing shared with INSTANCE -- sidesteps the reentrancy
    // regardless of which Gson version is on the classpath.
    private static final Gson TYPE_REF_GSON = new Gson();

    private static final Gson INSTANCE = new GsonBuilder()
            .registerTypeAdapter(TYPE_REF_LIST, new TypeRefListDeserializer())
            .create();

    private TriggerMetadataGson() {
    }

    /** The shared, preconfigured {@link Gson} instance for {@code trigger-metadata.json} documents. */
    public static Gson instance() {
        return INSTANCE;
    }

    /**
     * Normalizes a {@code TypeRef}-or-union slot onto {@code List<TypeRef>}: a bare JSON object
     * deserializes to a singleton list; a JSON array deserializes element-by-element as
     * {@link TypeRef}. Leaves are parsed via {@link #TYPE_REF_GSON} rather than the deserialization
     * {@code context} -- see that field's doc comment for why.
     */
    private static final class TypeRefListDeserializer implements JsonDeserializer<List<TypeRef>> {

        @Override
        public List<TypeRef> deserialize(JsonElement json, Type typeOfT, JsonDeserializationContext context)
                throws JsonParseException {
            if (json == null || json.isJsonNull()) {
                return null;
            }
            if (json.isJsonArray()) {
                JsonArray array = json.getAsJsonArray();
                List<TypeRef> result = new ArrayList<>(array.size());
                for (JsonElement element : array) {
                    result.add(TYPE_REF_GSON.fromJson(element, TypeRef.class));
                }
                return result;
            }
            return List.of(TYPE_REF_GSON.fromJson(json, TypeRef.class));
        }
    }
}
