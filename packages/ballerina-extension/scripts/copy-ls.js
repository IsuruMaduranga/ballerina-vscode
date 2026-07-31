#!/usr/bin/env node
/**
 * Copies the locally-built Ballerina Language Server distribution jar from
 *   packages/ballerina-language-server/build/ballerina-language-server-<version>.jar
 * into
 *   packages/ballerina-extension/ls/
 *
 * The language server is always the one built from source in this repo, at the
 * extension version (the extension package.json, which the Gradle build reads
 * directly). There is deliberately
 * no download fallback: a prebuilt jar from elsewhere could not carry this repo's
 * version, so a VSIX built around it would ship an extension and a server claiming
 * different versions.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const LS_DEST = path.join(PROJECT_ROOT, 'ls');
const LS_BUILD_DIR = path.join(PROJECT_ROOT, '..', 'ballerina-language-server', 'build');

/** Return the newest locally packed language-server jar, or null when none exists. */
function findPackJar() {
    if (!fs.existsSync(LS_BUILD_DIR)) return null;
    // The `pack` Gradle task writes to build/ballerina-language-server-<version>.jar
    const candidates = fs.readdirSync(LS_BUILD_DIR)
        .filter((f) => /^ballerina-language-server-.+\.jar$/.test(f))
        .map((f) => path.join(LS_BUILD_DIR, f));
    if (candidates.length === 0) return null;
    // Pick the most recently modified to handle stale jars.
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
}

/** Remove stale language-server jars from the extension destination. */
function clearDest() {
    if (!fs.existsSync(LS_DEST)) return;
    for (const f of fs.readdirSync(LS_DEST)) {
        if (/^ballerina-language-server-.+\.jar$/.test(f)) {
            fs.unlinkSync(path.join(LS_DEST, f));
        }
    }
}

/** Copy the newest packed jar into the extension and report whether one was found. */
function copyLocal() {
    const jar = findPackJar();
    if (!jar) return false;
    if (!fs.existsSync(LS_DEST)) fs.mkdirSync(LS_DEST, { recursive: true });
    clearDest();
    const dest = path.join(LS_DEST, path.basename(jar));
    fs.copyFileSync(jar, dest);
    console.log(`Copied local LS jar: ${path.relative(PROJECT_ROOT, jar)} -> ls/${path.basename(jar)}`);
    return true;
}

if (copyLocal()) {
    process.exit(0);
}

console.error(
    `No locally-built LS jar found in ${path.relative(PROJECT_ROOT, LS_BUILD_DIR)}.\n` +
    `Build the language server first:\n` +
    `  rush build --to ballerina-language-server\n` +
    `or, from packages/ballerina-language-server:\n` +
    `  ./gradlew pack -x test\n` +
    `This needs JDK 21 and GitHub Packages credentials (packageUser / packagePAT).`
);
process.exit(1);
