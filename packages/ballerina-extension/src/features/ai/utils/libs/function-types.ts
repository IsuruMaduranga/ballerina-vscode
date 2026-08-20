// Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { z } from 'zod';

export interface GetFunctionsRequest {
    name: string;
    description: string;
    clients: MinifiedClient[];
    functions?: MinifiedRemoteFunction[];
    services?: MinifiedService[];
}

export interface MinifiedClient {
    name: string;
    description?: string;
    functions: (MinifiedRemoteFunction | MinifiedResourceFunction)[];
}

export interface MinifiedService {
    listener: string;
    name?: string;
    methods?: string[];
}

/**
 * One service the selection model kept, as it comes back in the response.
 *
 * Deliberately narrower than {@link MinifiedService}, which is the *request* shape. The request carries
 * `methods` because handler names are what make a service recognisably relevant to a query — that is input
 * the model reasons over. The response does not, because a selected service is re-inflated from the original
 * library whole: its methods, handler templates and constraints have to agree with each other, and
 * `renderConstraintLines` emits notes naming handlers by name, so a per-method selection would produce
 * constraint notes pointing at handlers no longer in the body.
 *
 * `listener` and `name` are therefore the entire response surface — exactly enough to identify which service
 * was kept, and nothing the renderer would have to reconcile.
 */
export interface SelectedService {
    listener: string;
    name?: string;
}

export interface MinifiedRemoteFunction extends MiniFunction {
    name: string;
}

export interface MiniFunction {
    parameters?: string[];
    returnType?: string;
    description?: string;
}

export interface MinifiedResourceFunction extends MiniFunction {
    accessor: string;
    paths: (PathParameter | string)[];
}

export interface GetFunctionsResponse {
    libraries: GetFunctionResponse[];
}

export interface GetFunctionResponse {
    name: string;
    clients?: MinifiedClient[];
    functions?: MinifiedRemoteFunction[];
    services?: SelectedService[];
}

export interface PathParameter {
    name: string;
    type: string;
}

const pathItemSchema = z.union([
    z.string(),
    z.object({
        name: z.string(),
        type: z.string(),
    }),
]);

const remoteFunctionSchema = z.object({
    name: z.string(),
    parameters: z.array(z.string()).optional(),
    returnType: z.string().optional(),
    description: z.string().optional(),
});

const resourceFunctionSchema = z.object({
    accessor: z.string(),
    paths: z.array(pathItemSchema),
    parameters: z.array(z.string()).optional(),
    returnType: z.string().optional(),
    description: z.string().optional(),
});

const clientSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    functions: z.array(z.union([resourceFunctionSchema, remoteFunctionSchema])),
});

// The response counterpart of `MinifiedService` — see `SelectedService` for why `methods` is absent here
// while the request carries it.
const selectedServiceSchema = z.object({
    listener: z.string(),
    name: z.string().optional(),
});

const libraryResponseSchema = z.object({
    name: z.string(),
    clients: z.array(clientSchema).optional(),
    functions: z.array(remoteFunctionSchema).optional(),
    services: z.array(selectedServiceSchema).optional(),
});

export const getFunctionsResponseSchema = z.object({
    libraries: z.array(libraryResponseSchema),
});



