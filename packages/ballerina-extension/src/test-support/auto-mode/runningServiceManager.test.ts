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
 * tools/running-service-manager.ts on the shell runner: `bal` spawned with `shell: false` from a path with
 * spaces (the `/Applications/WSO2 Integrator.app/...` case `quoteShellPath` existed for), arguments passed
 * verbatim, exit-based bookkeeping, and stop/kill of the tree. A stand-in `bal` shell script plays the
 * binary; POSIX only (on Windows the same path goes through `commandLaunch` → cmd.exe, covered by
 * commandLaunch.test.ts).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunningServicesManager, spawnProcess, waitForExit } from "../../features/ai/agent/tools/running-service-manager";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("spawnProcess for bal", () => {
    let dir: string;
    let bal: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "rsm-"));
        const bin = join(dir, "WSO2 Integrator.app", "bin");
        mkdirSync(bin, { recursive: true });
        bal = join(bin, "bal");
        // Echoes each argument on its own line, colours one, then either exits or serves until killed.
        writeFileSync(bal, [
            "#!/bin/bash",
            "for a in \"$@\"; do echo \"arg:$a\"; done",
            "printf '\\033[32mRunning executable\\033[0m\\n'",
            "if [ \"$1\" = serve ]; then sleep 30; fi",
            "exit 3",
        ].join("\n"));
        chmodSync(bal, 0o755);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("starts an executable whose path has spaces, keeps arguments whole, and strips colour", async () => {
        const logs: string[] = [];
        const { process: proc } = spawnProcess(`"${bal}"`, ["test", "two words"], dir, logs);
        const manager = new RunningServicesManager();
        const service = { taskId: "t1", process: proc, logs, logCursor: 0, packagePath: dir, startedAt: Date.now(), exited: false, exitCode: -1 };
        manager.register(service);
        const started = Date.now();
        while (!service.exited && Date.now() - started < 5000) { await new Promise((r) => setTimeout(r, 20)); }
        expect(service.exited).toBe(true);
        expect(service.exitCode).toBe(3);
        expect(logs.join("")).toBe("arg:test\narg:two words\nRunning executable\n");
        await manager.dispose();
    });

    it("stopOne ends a serving process tree promptly and drops it", async () => {
        const logs: string[] = [];
        const { process: proc } = spawnProcess(bal, ["serve"], dir, logs);
        const manager = new RunningServicesManager();
        manager.register({ taskId: "t2", process: proc, logs, logCursor: 0, packagePath: dir, startedAt: Date.now(), exited: false, exitCode: -1 });
        const ready = Date.now();
        while (!logs.join("").includes("Running executable") && Date.now() - ready < 5000) { await new Promise((r) => setTimeout(r, 20)); }
        const started = Date.now();
        expect(await manager.stopOne("t2")).toBe(true);
        expect(Date.now() - started).toBeLessThan(4000);
        expect(manager.get("t2")).toBeUndefined();
        expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    });

    it("waitForExit returns at once for a process a signal already ended", async () => {
        const { process: proc } = spawnProcess(bal, ["serve"], dir, []);
        proc.kill("SIGKILL");
        await new Promise((r) => proc.once("exit", r));
        const started = Date.now();
        await waitForExit(proc, 5000);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("reports a missing executable in the logs instead of throwing", async () => {
        const logs: string[] = [];
        const { process: proc } = spawnProcess(join(dir, "missing", "bal"), [], dir, logs);
        await new Promise((r) => proc.once("error", r));
        expect(logs.join("")).toMatch(/Failed to start process: .*ENOENT/);
    });
});
