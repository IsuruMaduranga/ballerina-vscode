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
 * The vendored tree-sitter Bash grammar, loaded once per extension-host process.
 *
 * Parsing remains synchronous after the asynchronous WebAssembly initialisation,
 * so the shell gate and guards retain their synchronous APIs. Until loading
 * settles, or if it fails, callers receive no parse tree and must fail closed.
 * The grammar source and its MIT license live under resources/grammars/.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import { join } from "path";
import { Language, Parser, type Tree } from "web-tree-sitter";

interface BashParserState {
    ready: Promise<void>;
    parser?: Parser;
    error?: string;
}

const STATE_KEY = Symbol.for("wso2-integrator-copilot.bash-parser");
const bundledGrammar = join(__dirname, "..", "resources", "grammars", "tree-sitter-bash.wasm");
const sourceGrammar = join(__dirname, "..", "..", "..", "..", "..", "resources", "grammars", "tree-sitter-bash.wasm");
const RESOURCE_GRAMMAR = existsSync(bundledGrammar) ? bundledGrammar : sourceGrammar;
// webpack emits this runtime beside extension.js. The fallback supports Jest's
// unbundled TypeScript execution without making webpack resolve a WASM import.
const bundledRuntime = join(__dirname, "web-tree-sitter.wasm");
const RUNTIME_WASM = existsSync(bundledRuntime)
    ? bundledRuntime
    : createRequire(__filename).resolve("web-tree-sitter/web-tree-sitter.wasm");

function state(): BashParserState {
    const store = globalThis as { [STATE_KEY]?: BashParserState };
    let current = store[STATE_KEY];
    if (!current) {
        const created: BashParserState = { ready: Promise.resolve() };
        created.ready = load(created);
        store[STATE_KEY] = created;
        current = created;
    }
    return current;
}

async function load(target: BashParserState): Promise<void> {
    try {
        const [runtime, grammar] = await Promise.all([readFile(RUNTIME_WASM), readFile(RESOURCE_GRAMMAR)]);
        // Passing the runtime bytes avoids web-tree-sitter's Node-only dynamic
        // `import("fs/promises")` path, which Jest's VM does not provide.
        await Parser.init({ locateFile: () => RUNTIME_WASM, wasmBinary: runtime });
        const parser = new Parser();
        // Passing bytes has the same benefit for the language grammar loader.
        parser.setLanguage(await Language.load(grammar));
        target.parser = parser;
    } catch (error) {
        target.error = `the Bash grammar failed to load (${error instanceof Error ? error.message : String(error)})`;
    }
}

// Start before the first tool call; the gate also awaits readiness.
state();

/** Settles when the grammar has loaded or failed. It never rejects. */
export function bashParserReady(): Promise<void> {
    return state().ready;
}

/** Why the grammar is unavailable, or undefined once it is ready. */
export function bashParserUnavailable(): string | undefined {
    const current = state();
    if (current.parser) { return undefined; }
    return current.error ?? "the Bash grammar is still loading";
}

/** Parse a command synchronously once the grammar is available. The caller deletes the returned tree. */
export function parseBash(command: string): Tree | undefined {
    return state().parser?.parse(command) ?? undefined;
}
