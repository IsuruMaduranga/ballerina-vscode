#!/usr/bin/env node

/**
 * Copies the root package.json version into the extension manifest, where vsce
 * requires it on disk. Gradle reads the root version directly and needs no copy.
 *
 * Usage: node common/scripts/sync-version.js [--check]
 *   --check  report drift and exit 1 instead of writing
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ROOT_PACKAGE = path.join(REPO_ROOT, 'package.json');
const EXTENSION_MANIFEST = path.join(
  REPO_ROOT,
  'packages/ballerina-extension/package.json'
);
const VERSION_LINE = /^(\s*)"version"(\s*):(\s*)"[^"]*"/m;

/**
 * Reads a JSON file and returns its declared version.
 *
 * @param {string} filePath absolute path to a package manifest
 * @returns {string|undefined} the declared version
 */
function readVersion(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')).version;
}

/**
 * Synchronizes the extension manifest with the authored root version.
 */
function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  const rootVersion = readVersion(ROOT_PACKAGE);

  if (!rootVersion) {
    console.error(`No "version" field in ${ROOT_PACKAGE}.`);
    process.exit(1);
  }

  const contents = fs.readFileSync(EXTENSION_MANIFEST, 'utf8');
  const extensionVersion = JSON.parse(contents).version;

  if (extensionVersion === rootVersion) {
    console.log(`packages/ballerina-extension/package.json already at ${rootVersion}`);
    console.log(rootVersion);
    return;
  }

  if (checkOnly) {
    console.error(
      `packages/ballerina-extension/package.json is ${extensionVersion ?? '<missing>'}, ` +
      `expected ${rootVersion}`
    );
    process.exit(1);
  }

  if (!VERSION_LINE.test(contents)) {
    console.error('Could not find a version in packages/ballerina-extension/package.json.');
    process.exit(1);
  }

  const updated = contents.replace(
    VERSION_LINE,
    `$1"version"$2:$3"${rootVersion}"`
  );
  fs.writeFileSync(EXTENSION_MANIFEST, updated);
  console.log(
    `packages/ballerina-extension/package.json: ${extensionVersion ?? '<missing>'} -> ` +
    rootVersion
  );
  console.log(rootVersion);
}

main();
