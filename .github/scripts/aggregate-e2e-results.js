#!/usr/bin/env node
// Aggregates Playwright JSON-reporter output (one or more files per matrix group,
// downloaded into per-artifact subfolders) into a Markdown summary: attempt counts per
// test and the error line for any failed attempt. Exits non-zero if any test's final
// status is not 'passed'/'skipped', or if no readable report was found at all, so
// callers can gate a failure notification on it.
//
// A group can produce more than one report file: reusable-build.yml runs a first
// attempt, then re-runs just the failed subset (`--last-failed`) into a second file
// (see PLAYWRIGHT_JSON_OUTPUT_FILE in reusable-build.yml). Both are full Playwright JSON
// reports, so per-test results across the group's files are merged here rather than
// letting the later file silently replace the earlier one.
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
      } else if (entry.isFile() && /^e2e-results.*\.json$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir);
  return found;
}

// The caller downloads each matrix group's artifact into its own explicitly-named
// subfolder (e2e-results/group1, e2e-results/group2, ...) rather than one pattern-based
// download across all groups — so the group name is simply the first path segment
// under rootDir. (A pattern-based download only nests per-artifact when more than one
// artifact matches; with exactly one surviving group it flattens to the root, which a
// folder-name regex here couldn't recover from — controlling the download layout
// avoids that ambiguity entirely instead of guessing around it.)
function groupNameFromPath(filePath, rootDir) {
  const rel = path.relative(rootDir, filePath);
  return rel.split(path.sep)[0];
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

// Merges every report file belonging to one matrix group into a single per-test view,
// keyed by (file, title). Files are merged in filename order — 'e2e-results-first.json'
// before 'e2e-results-rerun.json' — so a test's results carry the first attempt's
// history followed by the re-run's, giving a true attempt count and final outcome even
// when the group needed a re-run.
function mergeGroupReports(files, onUnreadable) {
  const merged = new Map();
  for (const file of [...files].sort()) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      onUnreadable(file, err);
      continue;
    }
    const specs = [];
    for (const suite of report.suites || []) collectSpecs(suite, specs);

    for (const spec of specs) {
      for (const test of spec.tests || []) {
        const key = `${spec.file}::${spec.title}`;
        const results = test.results || [];
        const existing = merged.get(key);
        if (existing) {
          existing.results.push(...results);
        } else {
          merged.set(key, { title: spec.title, file: spec.file, results: [...results] });
        }
      }
    }
  }
  return [...merged.values()];
}

function aggregate(rootDir) {
  const files = findResultFiles(rootDir);
  const byGroup = new Map();
  for (const file of files) {
    const group = groupNameFromPath(file, rootDir);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(file);
  }

  const rows = [];
  const allTests = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let unreadableCount = 0;

  for (const [group, groupFiles] of byGroup) {
    const mergedTests = mergeGroupReports(groupFiles, (file, err) => {
      console.error(`Skipping unreadable report ${file}: ${err.message}`);
      unreadableCount += 1;
    });

    for (const test of mergedTests) {
      total += 1;
      const attempts = test.results.length;
      const finalResult = test.results[test.results.length - 1];
      const finalStatus = finalResult ? finalResult.status : 'skipped';
      const isPassed = finalStatus === 'passed';
      const isSkipped = attempts === 0 || finalStatus === 'skipped';

      if (isPassed) passed += 1;
      else if (!isSkipped) failed += 1;
      // Flakiness is derived from the merged attempt history rather than either report
      // file's own test.status: a test re-run via --last-failed spans two separate
      // Playwright invocations, so no single file's status reflects the merged outcome.
      if (isPassed && attempts > 1) flaky += 1;

      const errorLines = test.results
        .map((r, i) => {
          const line = firstErrorLine(r);
          return line ? `attempt ${i + 1}: ${line}` : null;
        })
        .filter(Boolean);

      allTests.push({
        group,
        title: test.title,
        file: test.file,
        attempts,
        finalStatus,
        error: errorLines.length ? errorLines[errorLines.length - 1] : null,
      });

      if (attempts > 1 || (!isPassed && !isSkipped)) {
        rows.push({ group, title: test.title, file: test.file, attempts, finalStatus, errorLines });
      }
    }
  }

  // A malformed report is a lost test, not a passed one — count it toward 'failed' so
  // it isn't reported as a clean run, and note it separately so the cause is visible.
  failed += unreadableCount;

  return { rows, allTests, total, passed, failed, flaky, unreadableCount, groupCount: byGroup.size };
}

function toNdjson(allTests) {
  const timestamp = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';
  const sourceTag = process.env.E2E_SOURCE_TAG || '';

  return allTests
    .map((t) =>
      JSON.stringify({
        timestamp,
        runId,
        runAttempt,
        sourceTag,
        ...t,
      })
    )
    .join('\n');
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// Markdown table cells break on a bare '|' and render garbage on raw ANSI escapes —
// both show up routinely in Playwright assertion/diff output.
function cell(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '').replace(/\|/g, '\\|');
}

function toMarkdown({ rows, total, passed, failed, flaky, unreadableCount, groupCount }) {
  const lines = [];
  lines.push('## E2E flakiness report');
  lines.push('');
  lines.push(
    `Groups reported: ${groupCount} · Total: ${total} · Passed: ${passed} · Failed: ${failed} · Flaky (passed after retry): ${flaky}`
  );
  if (unreadableCount > 0) {
    lines.push(`⚠️ ${unreadableCount} report file(s) could not be parsed and were counted as failed.`);
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push('No retries or failures — every test passed on the first attempt.');
    return lines.join('\n');
  }

  lines.push('| Group | Test | Attempts | Final status | Errors |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows.sort((a, b) => b.attempts - a.attempts)) {
    const errors = row.errorLines.map(cell).join('<br>');
    lines.push(
      `| ${cell(row.group)} | ${cell(row.title)} (${cell(row.file)}) | ${row.attempts} | ${cell(row.finalStatus)} | ${errors} |`
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

  if (summary.groupCount === 0) {
    console.error(`No e2e-results*.json found under ${rootDir}; the artifact contract is broken.`);
    process.exit(1);
  }

  if (summary.failed > 0) process.exit(1);
}

main();
