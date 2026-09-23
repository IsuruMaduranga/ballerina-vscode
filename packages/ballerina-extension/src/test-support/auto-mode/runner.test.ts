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
 * shell/runner.ts, shell/output.ts and shell/shell-spawn.ts against real child processes (no
 * child_process mock). Most cases run `node -e` through the runner so they hold on every OS; the bash
 * cases skip on Windows, where the Copilot has no bash tool.
 */
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EMPTY_OUTPUT_MARKER, OutputBuffer, stripAnsiAndControl, tailCap } from "../../features/ai/agent/shell/output";
import { clampTimeoutMs, finishLine, MAX_TIMEOUT_MS, type ProcessLaunch, runProcess, shellFinish, startProcess } from "../../features/ai/agent/shell/runner";
import { bashSpawn, shellLaunch } from "../../features/ai/agent/shell/shell-spawn";

const win32 = process.platform === "win32";
const itPosix = win32 ? it.skip : it;
const cwd = process.cwd();
const node = (script: string): ProcessLaunch => ({ command: process.execPath, args: ["-e", script] });

describe("output", () => {
    it("strips ANSI colour codes, OSC sequences and stray control bytes, keeping tabs and newlines", () => {
        expect(stripAnsiAndControl("\x1b[31merror\x1b[0m\tline\r\n")).toBe("error\tline\r\n");
        expect(stripAnsiAndControl("\x1b]0;title\x07ok\x00\x08")).toBe("ok");
        expect(stripAnsiAndControl("")).toBe("");
    });

    it("keeps the newest output under the cap and says so on top once anything was dropped", () => {
        const buffer = new OutputBuffer(10);
        buffer.append("0123456789");
        expect(buffer.truncated).toBe(false);
        expect(buffer.toString()).toBe("0123456789");
        buffer.append("abc");
        expect(buffer.truncated).toBe(true);
        expect(buffer.toString()).toMatch(/^\[Output truncated\. Showing the last 0KB\.\]\n3456789abc$/);
    });

    it("tail-caps text for notifications", () => {
        expect(tailCap("short", 10)).toBe("short");
        expect(tailCap("0123456789", 4)).toBe("… (earlier output truncated)\n6789");
    });
});

describe("clampTimeoutMs", () => {
    it("takes milliseconds, caps them, and drops nonsense", () => {
        expect(clampTimeoutMs(120_000)).toBe(120_000);
        expect(clampTimeoutMs(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
        for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(clampTimeoutMs(bad)).toBeUndefined();
        }
    });
});

describe("runProcess", () => {
    it("interleaves stdout and stderr and reports a clean exit as completed", async () => {
        const summary = await runProcess(node("console.log('out'); console.error('err')"), { cwd });
        expect(summary.exitCode).toBe(0);
        expect(summary.output).toContain("out");
        expect(summary.output).toContain("err");
        expect(shellFinish(summary)).toEqual({ status: "completed" });
        expect(finishLine(summary)).toBe("completed");
    });

    it("reports a non-zero exit as failed with its exit code", async () => {
        const summary = await runProcess(node("process.exit(3)"), { cwd });
        expect(summary.exitCode).toBe(3);
        expect(finishLine(summary)).toBe("failed (exit code 3)");
    });

    it("never returns an empty output for a finished run", async () => {
        const summary = await runProcess(node(""), { cwd });
        expect(summary.output).toBe(EMPTY_OUTPUT_MARKER);
    });

    it("sanitises the child's colour codes", async () => {
        const summary = await runProcess(node("process.stdout.write('\\x1b[32mgreen\\x1b[0m\\n')"), { cwd });
        expect(summary.output).toBe("green\n");
    });

    it("keeps a multibyte character whole when it arrives split across two writes", async () => {
        const script = "const b = Buffer.from('é'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)";
        const summary = await runProcess(node(script), { cwd });
        expect(summary.output).toBe("é");
    });

    it("caps the output from the front", async () => {
        const summary = await runProcess(node("process.stdout.write('x'.repeat(5000) + 'END')"), { cwd, outputCap: 1000 });
        expect(summary.truncated).toBe(true);
        expect(summary.output.endsWith("END")).toBe(true);
        expect(summary.output.length).toBeLessThan(1100);
    });

    it("stops the tree at the timeout and reports it as a failure with the detail", async () => {
        const started = Date.now();
        const summary = await runProcess(node("setTimeout(() => {}, 30000)"), { cwd, timeoutMs: 300 });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(summary.timedOut).toBe(true);
        expect(shellFinish(summary, 300)).toEqual({ status: "failed", detail: "timed out after 300ms" });
        expect(shellFinish(summary, 120_000).detail).toBe("timed out after 120s");
    });

    it("stops the tree when the signal aborts, and reports it as killed", async () => {
        const controller = new AbortController();
        const pending = runProcess(node("setTimeout(() => {}, 30000)"), { cwd, signal: controller.signal });
        setTimeout(() => controller.abort(), 150);
        const summary = await pending;
        expect(summary.stopped).toBe(true);
        expect(shellFinish(summary).status).toBe("killed");
        expect(finishLine(summary)).toBe("stopped");
    });

    it("does not start anything when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const running = startProcess(node("process.exit(0)"), { cwd, signal: controller.signal });
        expect(running.child).toBeUndefined();
        expect((await running.finished).stopped).toBe(true);
    });

    it("reports a missing working directory and a missing executable instead of rejecting", async () => {
        const noCwd = await runProcess(node(""), { cwd: join(cwd, "no-such-dir-for-this-test") });
        expect(noCwd.spawnError).toMatch(/Working directory does not exist/);
        expect(shellFinish(noCwd).status).toBe("failed");

        const noExe = await runProcess({ command: "no-such-executable-for-this-test", args: [] }, { cwd });
        expect(noExe.spawnError).toMatch(/Failed to start no-such-executable-for-this-test/);
        expect(noExe.output).toContain("ENOENT");
    });

    it("spools the full output and resolves only once the file is flushed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "runner-log-"));
        try {
            const logPath = join(dir, "output.log");
            const summary = await runProcess(node("process.stdout.write('y'.repeat(4000))"), { cwd, logPath, outputCap: 100 });
            expect(summary.truncated).toBe(true);
            expect(readFileSync(logPath, "utf8")).toBe("y".repeat(4000));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("streams sanitised chunks to onOutput and exposes output while running", async () => {
        const seen: string[] = [];
        const running = startProcess(node("console.log('\\x1b[1mone\\x1b[0m'); setTimeout(() => {}, 30000)"), { cwd, onOutput: (t) => seen.push(t) });
        await new Promise((r) => setTimeout(r, 400));
        expect(running.isDone()).toBe(false);
        expect(running.output()).toContain("one");
        running.stop();
        const summary = await running.finished;
        expect(running.isDone()).toBe(true);
        expect(seen.join("")).toContain("one");
        expect(seen.join("")).not.toContain("\x1b");
        expect(summary.stopped).toBe(true);
    });
});

describe("bash", () => {
    it("is /bin/bash off Windows and absent on Windows", () => {
        expect(bashSpawn("darwin")).toEqual({ shell: "/bin/bash", args: ["-c"] });
        expect(bashSpawn("linux")).toEqual({ shell: "/bin/bash", args: ["-c"] });
        expect(bashSpawn("win32")).toBeUndefined();
    });

    it("passes the command as one argv element", () => {
        expect(shellLaunch({ shell: "/bin/bash", args: ["-c"] }, "echo 'a b' | cat")).toEqual({ command: "/bin/bash", args: ["-c", "echo 'a b' | cat"] });
    });

    itPosix("runs a pipeline and surfaces the shell's exit code", async () => {
        const summary = await runProcess(shellLaunch(bashSpawn()!, "echo 'a b' | cat; exit 4"), { cwd });
        expect(summary.output).toBe("a b\n");
        expect(summary.exitCode).toBe(4);
    });

    itPosix("ends a pipeline's members on abort, so the wait does not hang on the pipe", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const pending = runProcess(shellLaunch(bashSpawn()!, "sleep 30 | cat"), { cwd, signal: controller.signal });
        setTimeout(() => controller.abort(), 150);
        const summary = await pending;
        expect(Date.now() - started).toBeLessThan(4000);
        expect(summary.stopped).toBe(true);
    });
});
