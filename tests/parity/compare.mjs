// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Compare two golden dumps written by dump.mjs (one per diff engine).
 *
 *   node tests/parity/compare.mjs <reference-dir> <candidate-dir>
 *
 * Rules (plans/codeview-virtualized-diff.md, parity rule 3):
 *   - pre-upgrade stage: everything must be identical.
 *   - post-upgrade stage: changed rows (additions and deletions) must be
 *     identical. Context rows may differ only where decision D5 applies (the
 *     reference engine re-diffs the full contents and can show a context line
 *     more or less next to a hunk); every file where they differ is LISTED,
 *     not failed, so a reviewer reads the list.
 *   - landings: within 1 px.
 *   - `classes` on the file wrapper are engine bookkeeping and are reported
 *     as notes only; `collapsed` is compared.
 *
 * Exit status 0 when there is no regression, 1 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';

const [referenceDir, candidateDir] = process.argv.slice(2);
if (!referenceDir || !candidateDir) {
  console.error('usage: node tests/parity/compare.mjs <reference-dir> <candidate-dir>');
  process.exit(2);
}

const regressions = [];
const listed = [];
const notes = [];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CHANGED = new Set(['change-addition', 'change-deletion']);
const rowsOf = (dump, predicate) => (dump ? dump.columns.flatMap((c) => c.rows.filter(predicate).map((r) => ({ column: c.name, ...r }))) : []);

function compareFile(label, stage, a, b) {
  const where = `${label} [${stage}] ${a ? a.file : b && b.file}`;
  if (!a || !b) {
    regressions.push(`${where}: present in only one dump`);
    return;
  }
  if (a.unsettled || b.unsettled) notes.push(`${where}: did not settle within the dump's time limit`);
  for (const key of ['collapsed', 'diffType', 'header', 'notices', 'annotations']) {
    if (!same(a[key], b[key])) regressions.push(`${where}: ${key} differs: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`.slice(0, 600));
  }
  if (!same(a.classes, b.classes)) notes.push(`${where}: wrapper classes ${JSON.stringify(a.classes)} vs ${JSON.stringify(b.classes)}`);

  const changedA = rowsOf(a, (r) => CHANGED.has(r.type));
  const changedB = rowsOf(b, (r) => CHANGED.has(r.type));
  if (!same(changedA, changedB)) regressions.push(`${where}: changed rows differ (${changedA.length} vs ${changedB.length})`);

  const contextA = rowsOf(a, (r) => !CHANGED.has(r.type));
  const contextB = rowsOf(b, (r) => !CHANGED.has(r.type));
  const rest = { separators: [a.separators, b.separators], expandControls: [a.expandControls, b.expandControls] };
  const contextDiffers = !same(contextA, contextB) || !same(rest.separators[0], rest.separators[1]) || rest.expandControls[0] !== rest.expandControls[1];
  if (contextDiffers) {
    const message = `${where}: context rows ${contextA.length} vs ${contextB.length}, separators ${a.separators.length} vs ${b.separators.length}, expand controls ${a.expandControls} vs ${b.expandControls}`;
    if (stage === 'pre') regressions.push(message);
    else listed.push(message);
  }
}

const names = fs.readdirSync(referenceDir).filter((name) => name.endsWith('.json') && name !== 'SUMMARY.json');
for (const name of names) {
  const candidatePath = path.join(candidateDir, name);
  if (!fs.existsSync(candidatePath)) {
    regressions.push(`${name}: missing from the candidate`);
    continue;
  }
  const a = JSON.parse(fs.readFileSync(path.join(referenceDir, name), 'utf8'));
  const b = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  if (!same(a.order, b.order)) regressions.push(`${name}: file order differs`);
  for (const stage of ['pre', 'post']) {
    for (const file of a.order) compareFile(name, stage, a[stage][file], b[stage][file]);
  }
  // The annotated stage holds one file. Its rows are post-upgrade rows.
  if (a.annotated || b.annotated) {
    const files = new Set([...Object.keys(a.annotated || {}), ...Object.keys(b.annotated || {})]);
    for (const file of files) {
      const fa = (a.annotated || {})[file];
      const fb = (b.annotated || {})[file];
      compareFile(name, 'annotated', fa, fb);
      if (fa && fb && fa.fileCommentCards !== fb.fileCommentCards) {
        regressions.push(`${name} [annotated] ${file}: file-comment cards ${fa.fileCommentCards} vs ${fb.fileCommentCards}`);
      }
    }
  }
  for (const key of new Set([...Object.keys(a.landings || {}), ...Object.keys(b.landings || {})])) {
    const la = (a.landings || {})[key];
    const lb = (b.landings || {})[key];
    if (!la || !lb) {
      regressions.push(`${name}: landing ${key} measured in only one dump`);
    } else {
      // A header landing is `headerTop`; a card landing is `cardBelowPinned`.
      const pa = la.headerTop ?? la.cardBelowPinned;
      const pb = lb.headerTop ?? lb.cardBelowPinned;
      if (pa == null || pb == null || Math.abs(pa - pb) > 1) {
        // A landing at the very end of the diff is bounded by the scroll extent, not by the target.
        if (!(la.atEnd && lb.atEnd)) regressions.push(`${name}: landing ${key}: ${pa} vs ${pb}`);
      }
    }
  }
}

console.log(`compared ${names.length} dump(s)`);
if (notes.length) console.log(`\nNotes (${notes.length}):\n  ${notes.join('\n  ')}`);
if (listed.length) console.log(`\nPost-upgrade context differences, to be read against decision D5 (${listed.length}):\n  ${listed.join('\n  ')}`);
if (regressions.length) {
  console.log(`\nREGRESSIONS (${regressions.length}):\n  ${regressions.join('\n  ')}`);
  process.exit(1);
}
console.log('\nno regression');
