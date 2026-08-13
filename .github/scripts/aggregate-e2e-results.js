#!/usr/bin/env node
// Aggregates Playwright JSON-reporter output (one file per matrix group, downloaded
// into per-artifact subfolders) into a Markdown summary: attempt counts per test and
// the error line for any failed attempt. Exits non-zero if any test's final status
// is not 'passed'/'skipped', so callers can gate a failure notification on it.
//
// When given a second argument, also writes one NDJSON line per test (including
// clean single-attempt passes) so a caller can append it to a cross-run history file.

const fs = require('fs');
const path = require('path');

function findResultFiles(rootDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'e2e-results.json') {
        found.push(full);
      }
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir);
  return found;
}

// A group name is derived from the artifact subfolder Playwright's JSON landed in,
// e.g. Ballerina-e2e-test-results-linux-group2-1/test-results/e2e-results.json -> group2.
function groupNameFromPath(filePath, rootDir) {
  const rel = path.relative(rootDir, filePath);
  const match = rel.match(/-(group\d+)-\d+[\\/]/);
  return match ? match[1] : rel.split(path.sep)[0];
}

function collectSpecs(suite, out) {
  for (const spec of suite.specs || []) out.push(spec);
  for (const child of suite.suites || []) collectSpecs(child, out);
}

function firstErrorLine(result) {
  const error = result.error || (result.errors && result.errors[0]);
  if (!error) return null;
  const message = (error.message || '').split('\n')[0].trim();
  const stackLine = (error.stack || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /\.(ts|js):\d+/.test(l));
  return [message, stackLine].filter(Boolean).join(' — ');
}

function aggregate(rootDir) {
  const files = findResultFiles(rootDir);
  const rows = [];
  const allTests = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let flaky = 0;

  for (const file of files) {
    const group = groupNameFromPath(file, rootDir);
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const specs = [];
    for (const suite of report.suites || []) collectSpecs(suite, specs);

    for (const spec of specs) {
      for (const test of spec.tests || []) {
        total += 1;
        const attempts = test.results ? test.results.length : 0;
        const finalResult = test.results && test.results[test.results.length - 1];
        const finalStatus = finalResult ? finalResult.status : test.status;
        const isPassed = finalStatus === 'passed';
        const isSkipped = finalStatus === 'skipped';

        if (isPassed) passed += 1;
        else if (!isSkipped) failed += 1;
        if (isPassed && attempts > 1) flaky += 1;

        const errorLines = (test.results || [])
          .map((r, i) => {
            const line = firstErrorLine(r);
            return line ? `attempt ${i + 1}: ${line}` : null;
          })
          .filter(Boolean);

        allTests.push({
          group,
          title: spec.title,
          file: spec.file,
          attempts,
          finalStatus,
          error: errorLines.length ? errorLines[errorLines.length - 1] : null,
        });

        if (attempts > 1 || (!isPassed && !isSkipped)) {
          rows.push({ group, title: spec.title, file: spec.file, attempts, finalStatus, errorLines });
        }
      }
    }
  }

  return { rows, allTests, total, passed, failed, flaky, groupCount: files.length };
}

function toNdjson(allTests) {
  const timestamp = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';
  const sourceBranch = process.env.E2E_SOURCE_BRANCH || '';

  return allTests
    .map((t) =>
      JSON.stringify({
        timestamp,
        runId,
        runAttempt,
        sourceBranch,
        ...t,
      })
    )
    .join('\n');
}

function toMarkdown({ rows, total, passed, failed, flaky, groupCount }) {
  const lines = [];
  lines.push('## E2E flakiness report');
  lines.push('');
  lines.push(
    `Groups reported: ${groupCount} · Total: ${total} · Passed: ${passed} · Failed: ${failed} · Flaky (passed after retry): ${flaky}`
  );
  lines.push('');

  if (rows.length === 0) {
    lines.push('No retries or failures — every test passed on the first attempt.');
    return lines.join('\n');
  }

  lines.push('| Group | Test | Attempts | Final status | Errors |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows.sort((a, b) => b.attempts - a.attempts)) {
    const errors = row.errorLines.length ? row.errorLines.join('<br>') : '';
    lines.push(
      `| ${row.group} | ${row.title} (${row.file}) | ${row.attempts} | ${row.finalStatus} | ${errors} |`
    );
  }
  return lines.join('\n');
}

function main() {
  const rootDir = process.argv[2];
  const ndjsonOutPath = process.argv[3];
  if (!rootDir) {
    console.error('Usage: aggregate-e2e-results.js <downloaded-artifacts-dir> [ndjson-output-path]');
    process.exit(2);
  }

  const summary = aggregate(rootDir);
  console.log(toMarkdown(summary));

  if (ndjsonOutPath && summary.allTests.length > 0) {
    fs.writeFileSync(ndjsonOutPath, toNdjson(summary.allTests) + '\n');
  }

  if (summary.failed > 0) process.exit(1);
}

main();
