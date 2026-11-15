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
 *   - context stage (context files): the place of each context file in the
 *     pane, its ranges, the text of its lines, the number of lines each gap
 *     hides and the line each card is under must be identical, with two
 *     exceptions that are LISTED per file: a gap of five lines or fewer is
 *     drawn in full by the virtualized viewer (the ranges then run on over
 *     it and the gap is not counted), and a file that ends in a newline has
 *     one line fewer there. How a context file is drawn is not compared.
 *   - landings: within 1 px, measured from whatever is pinned above the diff
 *     when both dumps have that measurement (the toolbar is inside the
 *     scroll container on one engine and above it on the other), else from
 *     the top of the scroll container.
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
const DRAWING_CLASSES = new Set(['has-diff-lines', 'has-diff-body']);
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
  // The virtualized viewer's element of a file says with two classes what the
  // per-file renderer says with an element (a code block under the header,
  // and lines in it); pr.css keys the space under the header on them. They
  // are how a file is drawn, not a state of the file.
  const stateClasses = (classes) => (classes || []).filter((name) => !DRAWING_CLASSES.has(name));
  if (!same(stateClasses(a.classes), stateClasses(b.classes))) notes.push(`${where}: wrapper classes ${JSON.stringify(a.classes)} vs ${JSON.stringify(b.classes)}`);

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

const SMALL_GAP = 5;

/** `ranges` with every hidden gap of at most SMALL_GAP lines (between two, before the first) drawn in full. */
function withSmallGapsShown(ranges) {
  const out = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (last && range.start - last.end - 1 <= SMALL_GAP) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  if (out.length > 0 && out[0].start - 1 <= SMALL_GAP) out[0].start = 1;
  return out;
}

/**
 * The hidden-line counts an engine draws for `ranges` of a file of `total`
 * lines. The table renderer gives every range a gap row above it (back to
 * line 1) and below it (on to the end of the file); the virtualized viewer
 * one separator per run of hidden lines, and none for five lines or fewer.
 */
function hiddenAsDrawn(engine, ranges, total) {
  const counts = [];
  if (engine === 'codeview') {
    let previous = 0;
    for (const range of ranges) {
      if (range.start - previous - 1 > 0) counts.push(range.start - previous - 1);
      previous = range.end;
    }
    if (total - previous > 0) counts.push(total - previous);
    return counts;
  }
  for (const range of ranges) {
    if (range.start > 1) counts.push(range.start - 1);
    if (range.end < total) counts.push(total - range.end);
  }
  return counts;
}

function compareContext(label, a, b, engines) {
  if (!a && !b) return;
  if (!a || !b) {
    // A reference taken before the stage existed has nothing to compare with.
    notes.push(`${label} [context]: present in only one dump`);
    return;
  }
  if (!same(a.pane, b.pane)) regressions.push(`${label} [context]: pane order differs: ${JSON.stringify(a.pane)} vs ${JSON.stringify(b.pane)}`.slice(0, 600));
  for (const file of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    const fa = a.files[file];
    const fb = b.files[file];
    const where = `${label} [context] ${file}`;
    if (!fa || !fb) {
      regressions.push(`${where}: present in only one dump`);
      continue;
    }
    for (const key of ['header', 'collapsed', 'cards']) {
      if (!same(fa[key], fb[key])) regressions.push(`${where}: ${key} differs: ${JSON.stringify(fa[key])} vs ${JSON.stringify(fb[key])}`.slice(0, 600));
    }
    // Every line both dumps show has the same text.
    const textA = new Map(fa.lines);
    const differing = fb.lines.filter(([line, text]) => textA.has(line) && textA.get(line) !== text).map(([line]) => line);
    if (differing.length > 0) regressions.push(`${where}: the text of lines ${differing.slice(0, 10).join(', ')} differs`);

    // The counts each engine draws are the ones its ranges and the file's
    // length give under that engine's rule: the numbers on screen are right.
    for (const [engine, f] of [[engines[0], fa], [engines[1], fb]]) {
      const expectedCounts = hiddenAsDrawn(engine, f.ranges, f.totalLines);
      if (!same(f.hidden, expectedCounts)) {
        regressions.push(`${where}: ${engine} draws hidden-line counts ${JSON.stringify(f.hidden)} for ranges ${JSON.stringify(f.ranges)} of ${f.totalLines} lines; expected ${JSON.stringify(expectedCounts)}`);
      }
    }
    if (fa.totalLines !== fb.totalLines) {
      if (fb.totalLines === fa.totalLines - 1) listed.push(`${where}: ${fa.totalLines} lines against ${fb.totalLines} (the file ends in a newline)`);
      else regressions.push(`${where}: ${fa.totalLines} lines against ${fb.totalLines}`);
    }
    if (same(fa.ranges, fb.ranges)) continue;
    // The one accepted difference in what is shown: small gaps drawn in full
    // (and, at the end of a file that ends in a newline, one line fewer).
    const expected = withSmallGapsShown(fa.ranges);
    const lastA = fa.ranges[fa.ranges.length - 1];
    const lastB = fb.ranges[fb.ranges.length - 1];
    const sameButEnd = expected.length === fb.ranges.length
      && expected.every((range, i) => range.start === fb.ranges[i].start && (i === expected.length - 1 || range.end === fb.ranges[i].end));
    const endExplained = lastA && lastB && (lastB.end === lastA.end
      // The last range runs to the end of the file when at most SMALL_GAP lines were hidden after it.
      || (lastB.end > lastA.end && lastB.end - lastA.end <= SMALL_GAP)
      || lastB.end === lastA.end - 1);
    if (sameButEnd && endExplained) {
      listed.push(`${where}: ranges ${JSON.stringify(fa.ranges)} are shown as ${JSON.stringify(fb.ranges)} (gaps of ${SMALL_GAP} lines or fewer drawn in full, or the file's final newline)`);
    } else {
      regressions.push(`${where}: ranges ${JSON.stringify(fa.ranges)} vs ${JSON.stringify(fb.ranges)}`.slice(0, 600));
    }
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
  compareContext(name, a.context, b.context, [a.meta?.engine || 'filediff', b.meta?.engine || 'filediff']);
  for (const key of new Set([...Object.keys(a.landings || {}), ...Object.keys(b.landings || {})])) {
    const la = (a.landings || {})[key];
    const lb = (b.landings || {})[key];
    if (!la || !lb) {
      regressions.push(`${name}: landing ${key} measured in only one dump`);
    } else {
      // A header landing is `headerTop`; a card landing is `cardBelowPinned`.
      const pinned = la.belowPinned != null && lb.belowPinned != null;
      const pa = pinned ? la.belowPinned : (la.headerTop ?? la.cardBelowPinned);
      const pb = pinned ? lb.belowPinned : (lb.headerTop ?? lb.cardBelowPinned);
      if (pa == null || pb == null || Math.abs(pa - pb) > 1) {
        // A landing at the very end of the diff is bounded by the scroll extent, not by the target.
        if (!(la.atEnd && lb.atEnd)) regressions.push(`${name}: landing ${key}: ${pa} vs ${pb}`);
      }
    }
  }
}

console.log(`compared ${names.length} dump(s)`);
if (notes.length) console.log(`\nNotes (${notes.length}):\n  ${notes.join('\n  ')}`);
if (listed.length) console.log(`\nListed differences: post-upgrade context rows, to be read against decision D5, and context files against the small-gap rule (${listed.length}):\n  ${listed.join('\n  ')}`);
if (regressions.length) {
  console.log(`\nREGRESSIONS (${regressions.length}):\n  ${regressions.join('\n  ')}`);
  process.exit(1);
}
console.log('\nno regression');
