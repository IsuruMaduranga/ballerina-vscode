#!/usr/bin/env node

/**
 * Copies the version from the root package.json — the single authored version in this
 * repo — into the files that carry a generated copy of it:
 *
 *   packages/ballerina-extension/package.json            (the VS Code manifest)
 *   packages/ballerina-language-server/gradle.properties (the Gradle build's version)
 *
 * Each of those projects runs this at the head of its own `build` script, so the value is
 * refreshed before anything reads it. vsce and Gradle then behave exactly as they always
 * have, reading the version off disk. Both copies are therefore generated: editing either
 * by hand has no effect, because the next build overwrites it.
 *
 * Usage: node common/scripts/sync-version.js [--check]
 *   --check  report drift and exit 1 instead of writing (diagnostics; not a build gate,
 *            since the build's job is to fix drift rather than complain about it)
 *
 * Exit codes:
 * - 0: in sync (or updated)
 * - 1: root version missing, a target is unreadable, or --check found drift
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Paths are relative to the repo root.
const JSON_TARGETS = ['packages/ballerina-extension/package.json'];
const PROPERTIES_TARGETS = ['packages/ballerina-language-server/gradle.properties'];

/**
 * Rewrites only the "version" line, so key order, indentation and the trailing newline are
 * untouched and the diff stays a single line. JSON.parse + JSON.stringify would reformat
 * the whole file — the extension manifest is ~60KB.
 */
const JSON_VERSION_LINE = /^(\s*)"version"(\s*):(\s*)"[^"]*"/m;

/**
 * Anchored to the start of a line so it cannot match the camelCase dependency pins that
 * fill gradle.properties (ballerinaLangVersion, releasePluginVersion, stdlib*Version, ...).
 * `version=` is the only lowercase, line-initial version key in that file.
 */
const PROPERTIES_VERSION_LINE = /^version=.*$/m;

/** Where to insert `version=` if the key has been removed entirely. */
const PROPERTIES_GROUP_LINE = /^group=.*$/m;

const KINDS = {
  json: {
    read: (contents) => JSON.parse(contents).version,
    write: (contents, version) =>
      JSON_VERSION_LINE.test(contents)
        ? contents.replace(JSON_VERSION_LINE, `$1"version"$2:$3"${version}"`)
        : null,
  },
  properties: {
    read: (contents) => {
      const match = PROPERTIES_VERSION_LINE.exec(contents);
      return match ? match[0].slice('version='.length).trim() : undefined;
    },
    write: (contents, version) => {
      if (PROPERTIES_VERSION_LINE.test(contents)) {
        return contents.replace(PROPERTIES_VERSION_LINE, `version=${version}`);
      }
      // Self-heal a deleted key rather than failing: without it Gradle would fall back to
      // 'unspecified' and produce a jar named ballerina-language-server-unspecified.jar.
      if (PROPERTIES_GROUP_LINE.test(contents)) {
        return contents.replace(PROPERTIES_GROUP_LINE, (line) => `${line}\nversion=${version}`);
      }
      return null;
    },
  },
};

function main() {
  const checkOnly = process.argv.slice(2).includes('--check');

  const rootPath = path.join(REPO_ROOT, 'package.json');
  const rootVersion = JSON.parse(fs.readFileSync(rootPath, 'utf8')).version;
  if (!rootVersion) {
    console.error(`No "version" field in ${rootPath}.`);
    process.exit(1);
  }

  const targets = [
    ...JSON_TARGETS.map((target) => ({ target, kind: 'json' })),
    ...PROPERTIES_TARGETS.map((target) => ({ target, kind: 'properties' })),
  ];

  let mismatched = 0;

  for (const { target, kind } of targets) {
    const { read, write } = KINDS[kind];
    const filePath = path.join(REPO_ROOT, target);

    let contents;
    try {
      contents = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      console.error(`Error reading ${target}: ${error.message}`);
      process.exit(1);
    }

    const currentVersion = read(contents);
    if (currentVersion === rootVersion) {
      console.log(`${target} already at ${rootVersion}`);
      continue;
    }

    mismatched++;

    if (checkOnly) {
      console.error(`${target} is ${currentVersion ?? '<missing>'}, expected ${rootVersion}`);
      continue;
    }

    const updated = write(contents, rootVersion);
    if (updated === null) {
      console.error(`Could not place a version in ${target}; cannot sync.`);
      process.exit(1);
    }
    fs.writeFileSync(filePath, updated);
    console.log(`${target}: ${currentVersion ?? '<missing>'} -> ${rootVersion}`);
  }

  if (checkOnly && mismatched > 0) {
    console.error(
      `\n${mismatched} file(s) out of sync with the root version. ` +
      `Run 'node common/scripts/sync-version.js' to fix.`
    );
    process.exit(1);
  }

  // Consumers (CI, the updateVersion action) read this from stdout.
  console.log(rootVersion);
}

main();
