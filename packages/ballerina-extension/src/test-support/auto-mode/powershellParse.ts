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
 * PowerShell's own parse for tests of the PowerShell gate.
 *
 * Two sources. A real PowerShell, when one is found (`PWSH_PATH`, `pwsh` on
 * PATH, or the portable PowerShell 7 build cached under
 * `~/.cache/cc-windows-mode/pwsh` for Mac development), serves one parse
 * server per test file. Without one, a line whose parse was recorded in
 * `powershell-parses.json` is answered from the recording, so the tree
 * verdicts are tested on every machine; a test that needs any other line is
 * wrapped in `describeWithPowerShell` and skips.
 *
 * `POWERSHELL_TESTS_OFFLINE=1` runs them as a machine without PowerShell would.
 *
 * Recording: run the PowerShell tests with `RECORD_POWERSHELL_PARSES=1` and
 * `--runInBand` on a machine with PowerShell. Every line parsed live that
 * names no temporary directory is written to the recording.
 * `powershellParserLive.test.ts` checks the recording against the live parser.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { type PowerShellParse, PowerShellParser } from "../../features/ai/agent/auto-mode/powershell-parser";
import { powershellReadOnly, type PowerShellReadOnlyOptions } from "../../features/ai/agent/auto-mode/powershell-rules";
import { spawnLaunch } from "../../features/ai/agent/shell/runner";
import { POWERSHELL_ARGS, shellLaunch, type ShellSpawn } from "../../features/ai/agent/shell/shell-spawn";
import { whichOnPath } from "../../features/ai/agent/shell/which";

/** A real pwsh: `PWSH_PATH`, PATH, or the portable PowerShell 7 build cached for Mac development. */
function findPwsh(): string | undefined {
    // Runs the tests as a machine without PowerShell would: recorded lines only.
    if (process.env.POWERSHELL_TESTS_OFFLINE === "1") { return undefined; }
    const candidates = [process.env.PWSH_PATH, whichOnPath("pwsh", process.env), join(homedir(), ".cache", "cc-windows-mode", "pwsh", "pwsh")];
    return candidates.find((path): path is string => !!path && existsSync(path));
}

const pwsh = findPwsh();

/** The local PowerShell the live tests run, or undefined. */
export const LOCAL_POWERSHELL: ShellSpawn | undefined = pwsh ? { shell: pwsh, args: [...POWERSHELL_ARGS] } : undefined;
export const HAVE_POWERSHELL = LOCAL_POWERSHELL !== undefined;

/** `describe` when a real PowerShell is found, `describe.skip` otherwise. */
export const describeWithPowerShell = HAVE_POWERSHELL ? describe : describe.skip;

/** Per-test timeout for tests that parse live: the first parse in a file starts PowerShell. */
export const POWERSHELL_TEST_TIMEOUT = 60_000;

/** Where the recorded parses live, and the platform they were recorded on. */
export const RECORDING_PATH = join(__dirname, "powershell-parses.json");

export interface Recording {
    /** `process.platform` of the recording machine: command lookup (aliases, applications) depends on it. */
    platform: string;
    /** The PowerShell version that parsed. */
    version: string;
    parses: Record<string, PowerShellParse>;
}

export function readRecording(): Recording {
    try {
        return JSON.parse(readFileSync(RECORDING_PATH, "utf8")) as Recording;
    } catch {
        return { platform: process.platform, version: "", parses: {} };
    }
}

const recording = readRecording();
const recordingOn = process.env.RECORD_POWERSHELL_PARSES === "1";

/** The recording as JSON with one line per parse, so a re-recording diffs line by line. */
export function formatRecording(recording: Recording): string {
    const entries = Object.keys(recording.parses).sort().map((command) => `  ${JSON.stringify(command)}: ${JSON.stringify(recording.parses[command])}`);
    return `{\n "platform": ${JSON.stringify(recording.platform)},\n "version": ${JSON.stringify(recording.version)},\n "parses": {\n${entries.join(",\n")}\n }\n}\n`;
}

/** A parser on `spec`, with generous timeouts for a cold start. */
export function testParser(spec: ShellSpawn): PowerShellParser {
    return new PowerShellParser({
        spawnServer: (bootstrap) => spawnLaunch(shellLaunch(spec, bootstrap), { cwd: homedir(), stdin: "pipe" }),
        startTimeoutMs: 60_000,
        requestTimeoutMs: 20_000,
    });
}

let shared: PowerShellParser | undefined;

afterAll(() => {
    shared?.stop();
    shared = undefined;
});

/** PowerShell's live parse of `command`; throws when the parser cannot answer. */
export async function liveParse(command: string): Promise<PowerShellParse> {
    if (!LOCAL_POWERSHELL) { throw new Error("no local PowerShell: wrap the test in describeWithPowerShell"); }
    shared ??= testParser(LOCAL_POWERSHELL);
    const outcome = await shared.parse(command);
    if (!outcome.ok) { throw new Error((outcome as { reason: string }).reason); }
    return outcome.parse;
}

const TEMP_SPELLINGS = [tmpdir(), realpathSync(tmpdir())];

/** Whether `command` can be answered without a live PowerShell. */
export function isRecorded(command: string): boolean {
    return Object.prototype.hasOwnProperty.call(recording.parses, command);
}

/**
 * PowerShell's parse of `command`: the recording when it holds the line
 * (unless recording), else the live parser.
 */
export async function psParse(command: string): Promise<PowerShellParse> {
    // A copy: the tree verdicts are memoized per parse object, and each live parse is a new one.
    if (!recordingOn && isRecorded(command)) { return JSON.parse(JSON.stringify(recording.parses[command])) as PowerShellParse; }
    const parse = await liveParse(command);
    if (recordingOn && !TEMP_SPELLINGS.some((dir) => command.toLowerCase().includes(dir.toLowerCase()))) {
        const current = readRecording();
        current.platform = process.platform;
        current.parses[command] = parse;
        writeFileSync(RECORDING_PATH, formatRecording(current));
    }
    return parse;
}

/** `powershellReadOnly` on PowerShell's parse of `command`. */
export async function psReadOnly(command: string, opts: Omit<PowerShellReadOnlyOptions, "parse">) {
    return powershellReadOnly({ ...opts, parse: await psParse(command) });
}

/** `it` when every line is recorded or a real PowerShell is found, `it.skip` otherwise. */
export function itParses(commands: readonly string[]): jest.It {
    return HAVE_POWERSHELL || commands.every(isRecorded) ? it : it.skip;
}
