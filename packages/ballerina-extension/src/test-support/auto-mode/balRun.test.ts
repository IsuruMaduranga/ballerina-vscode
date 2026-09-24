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
 * Which background shell commands become a service (shell/bal-run.ts). A miss turns a service into a chat
 * task that is stopped on the next chat change; a false hit keeps an ordinary command running across
 * chats and lists it as a service.
 */
import { delimiter, join, resolve } from "path";
import { balRunDirectory, withBalOnPath } from "../../features/ai/agent/shell/bal-run";

const ROOT = resolve("/work/proj");

describe("balRunDirectory", () => {
    it("reads a plain bal run as the workspace root", () => {
        expect(balRunDirectory("bal run", ROOT)).toBe(ROOT);
        expect(balRunDirectory("bal run --offline", ROOT)).toBe(ROOT);
        expect(balRunDirectory("BAL_ENV=dev bal run", ROOT)).toBe(ROOT);
    });

    it("follows cd steps, in bash and PowerShell spellings", () => {
        expect(balRunDirectory("cd greeter && bal run", ROOT)).toBe(join(ROOT, "greeter"));
        expect(balRunDirectory("cd greeter; bal run", ROOT)).toBe(join(ROOT, "greeter"));
        expect(balRunDirectory("Set-Location greeter; bal run", ROOT)).toBe(join(ROOT, "greeter"));
        expect(balRunDirectory("cd a && cd b && bal run", ROOT)).toBe(join(ROOT, "a", "b"));
    });

    it("takes the package path bal run is given, skipping option values and program arguments", () => {
        expect(balRunDirectory("bal run greeter", ROOT)).toBe(join(ROOT, "greeter"));
        expect(balRunDirectory("bal run --debug 5005 greeter", ROOT)).toBe(join(ROOT, "greeter"));
        expect(balRunDirectory("bal run -- greeter", ROOT)).toBe(ROOT);
        expect(balRunDirectory("bal run greeter/main.bal", ROOT)).toBe(join(ROOT, "greeter"));
    });

    it("accepts the Windows launcher names", () => {
        expect(balRunDirectory("bal.bat run", ROOT)).toBe(ROOT);
        expect(balRunDirectory("bal.cmd run", ROOT)).toBe(ROOT);
    });

    it("is not a service for any other command, or a bal run inside a larger one", () => {
        expect(balRunDirectory("bal build", ROOT)).toBeUndefined();
        expect(balRunDirectory("bal test", ROOT)).toBeUndefined();
        expect(balRunDirectory("bal run && curl localhost:9090", ROOT)).toBeUndefined();
        expect(balRunDirectory("npm start", ROOT)).toBeUndefined();
        expect(balRunDirectory("echo bal run", ROOT)).toBeUndefined();
        expect(balRunDirectory("cd $PKG && bal run", ROOT)).toBeUndefined();
        expect(balRunDirectory("cd ~/pkg && bal run", ROOT)).toBeUndefined();
        expect(balRunDirectory("bal run 'unterminated", ROOT)).toBeUndefined();
    });
});

describe("withBalOnPath", () => {
    const bal = resolve("/Applications/WSO2 Integrator.app/ballerina/bin/bal");

    it("puts the extension's bal directory first", () => {
        expect(withBalOnPath({ PATH: "/usr/bin" }, bal).PATH).toBe(`${resolve(bal, "..")}${delimiter}/usr/bin`);
        expect(withBalOnPath({ PATH: "/usr/bin" }, `"${bal}"`).PATH).toBe(`${resolve(bal, "..")}${delimiter}/usr/bin`);
    });

    it("keeps Windows' `Path` spelling rather than adding a second key", () => {
        const env = withBalOnPath({ Path: "C:\\Windows" }, bal);
        expect(Object.keys(env)).toEqual(["Path"]);
        expect(env.Path.startsWith(resolve(bal, ".."))).toBe(true);
    });

    it("leaves the environment alone for a bare command name or none", () => {
        const env = { PATH: "/usr/bin" };
        expect(withBalOnPath(env, "bal")).toBe(env);
        expect(withBalOnPath(env, undefined)).toBe(env);
    });
});
