// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

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

/**
 * vitest's `expect(value, message)` for tests ported from another harness.
 * Jest's `expect` takes no message, so a table test that loops over commands
 * would fail without naming the command. This wraps every matcher and puts the
 * label on the first line of the failure.
 */
export function expectLabeled<T>(value: T, label: string): jest.JestMatchers<T> {
    const matchers = expect(value);
    return new Proxy(matchers, {
        get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (typeof member !== "function") { return member; }
            return (...args: unknown[]) => {
                try {
                    return member.apply(target, args);
                } catch (error) {
                    if (error instanceof Error) { error.message = `${label}\n${error.message}`; }
                    throw error;
                }
            };
        },
    });
}
