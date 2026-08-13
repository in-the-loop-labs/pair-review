// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for printCouncilList (src/main.js, used by --list-councils).
 *
 * These tests use a real in-memory database (the same createTestDatabase helper
 * the rest of the suite uses) plus the real CouncilRepository /
 * AnalysisRunRepository, and capture console.log output to assert on the
 * rendered table. They verify the empty-DB message, the populated table
 * (handles, names, types, last-used repo), and the header/footer guidance.
 *
 * File councils have no DB row, so those cases prime the process-wide overlay
 * cache with `_resetForTests` and clear it again in afterEach — leaving it
 * primed would silently add rows to every later test in this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const { printCouncilList } = require('../../src/main');
const { CouncilRepository, AnalysisRunRepository } = require('../../src/database.js');
const { shortId } = require('../../src/councils/resolve-council.js');
const { _resetForTests } = require('../../src/councils/council-store.js');

const sampleConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

describe('printCouncilList', () => {
  let db;
  let logs;
  let spy;

  beforeEach(async () => {
    db = await createTestDatabase();
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  });

  afterEach(() => {
    _resetForTests();
    if (spy) spy.mockRestore();
    if (db) db.close();
  });

  /**
   * Build a file-council overlay row (the shape loadFileCouncils returns).
   */
  function fileCouncil({ stem, name, type = 'council' }) {
    return {
      id: `file:${stem}`,
      name,
      type,
      config: { voices: [{ provider: 'claude', model: 'sonnet' }], levels: { '1': true } },
      description: null,
      last_used_at: null,
      created_at: null,
      updated_at: null,
      source: 'file',
      readOnly: true,
      filePath: `/councils/${stem}.council.json`
    };
  }

  /** Split the captured output into non-empty table lines. */
  function tableLines() {
    return logs.join('\n').split('\n').filter(Boolean);
  }

  /**
   * The row containing `nameFragment`, split into its padded columns
   * (columns are joined with two spaces, so 2+ spaces is the separator).
   * @returns {{handle: string, name: string, type: string, source: string, lastUsed: string, lastUsedWith: string}}
   */
  function rowFor(nameFragment) {
    const line = tableLines().find(l => l.includes(nameFragment));
    expect(line, `no row containing "${nameFragment}"`).toBeDefined();
    const [handle, name, type, source, lastUsed, lastUsedWith] = line.trim().split(/\s{2,}/);
    return { handle, name, type, source, lastUsed, lastUsedWith };
  }

  it('prints a helpful message when there are no councils', async () => {
    await printCouncilList(db);

    const output = logs.join('\n');
    expect(output).toContain('No councils found');
  });

  it('renders a table with handles, names, types, and last-used repo', async () => {
    const councilRepo = new CouncilRepository(db);
    const runRepo = new AnalysisRunRepository(db);

    const council1Id = uuidv4();
    const council2Id = uuidv4();
    await councilRepo.create({ id: council1Id, name: 'Security Review', type: 'council', config: sampleConfig });
    await councilRepo.create({ id: council2Id, name: 'Architecture Review', type: 'advanced', config: sampleConfig });

    // Seed a completed council run for council1 against acme/widget #7.
    const reviewId = seedTestReview(db, { prNumber: 7, repository: 'acme/widget' });
    await runRepo.create({
      id: uuidv4(),
      reviewId,
      provider: 'council',
      model: council1Id,
      status: 'completed',
      configType: 'council'
    });

    await printCouncilList(db);
    const output = logs.join('\n');

    // Both councils' short ids (first 8 chars) appear.
    expect(output).toContain(shortId(council1Id));
    expect(output).toContain(shortId(council2Id));

    // Both names appear.
    expect(output).toContain('Security Review');
    expect(output).toContain('Architecture Review');

    // Both type strings appear.
    expect(output).toContain('council');
    expect(output).toContain('advanced');

    // council1's most recent run repo (and PR number) appears.
    expect(output).toContain('acme/widget');
    expect(output).toContain('#7');

    // council2 has no run, so it shows the "never used" placeholder.
    expect(output).toMatch(/—|never/);

    // Footer guidance mentions --council.
    expect(output).toContain('--council');
  });

  it('includes the table header row', async () => {
    const councilRepo = new CouncilRepository(db);
    await councilRepo.create({ id: uuidv4(), name: 'Some Council', type: 'council', config: sampleConfig });

    await printCouncilList(db);
    const output = logs.join('\n');

    expect(output).toContain('HANDLE');
    expect(output).toContain('NAME');
    expect(output).toContain('TYPE');
    expect(output).toContain('SOURCE');
    expect(output).toContain('LAST USED');
    expect(output).toContain('LAST USED WITH');
  });

  it('marks the source of DB and file councils', async () => {
    const councilRepo = new CouncilRepository(db);
    const dbId = uuidv4();
    await councilRepo.create({ id: dbId, name: 'Saved Council', type: 'council', config: sampleConfig });
    _resetForTests([fileCouncil({ stem: 'dream-team', name: 'Dream Team' })]);

    await printCouncilList(db);

    expect(rowFor('Saved Council').source).toBe('db');
    expect(rowFor('Dream Team').source).toBe('file');
  });

  it('prints the full file: id as the handle (a short id would not resolve)', async () => {
    const councilRepo = new CouncilRepository(db);
    const dbId = uuidv4();
    await councilRepo.create({ id: dbId, name: 'Saved Council', type: 'council', config: sampleConfig });
    _resetForTests([fileCouncil({ stem: 'dream-team', name: 'Dream Team' })]);

    await printCouncilList(db);

    expect(rowFor('Dream Team').handle).toBe('file:dream-team');
    // DB councils still get the 8-char short id.
    expect(rowFor('Saved Council').handle).toBe(shortId(dbId));
  });

  it('shows last-used repo for a file council with analysis_runs history', async () => {
    const runRepo = new AnalysisRunRepository(db);
    _resetForTests([fileCouncil({ stem: 'dream-team', name: 'Dream Team' })]);

    const reviewId = seedTestReview(db, { prNumber: 12, repository: 'acme/gizmo' });
    await runRepo.create({
      id: uuidv4(),
      reviewId,
      provider: 'council',
      model: 'file:dream-team',
      status: 'completed',
      configType: 'council'
    });

    await printCouncilList(db);

    const row = rowFor('Dream Team');
    expect(row.lastUsedWith).toBe('acme/gizmo#12');
    // The run's start date fills LAST USED, so the never-used placeholder is gone.
    expect(row.lastUsed).not.toBe('never');
    expect(row.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows the never-used placeholders for a file council with no runs', async () => {
    _resetForTests([fileCouncil({ stem: 'unused-team', name: 'Unused Team' })]);

    await printCouncilList(db);

    const row = rowFor('Unused Team');
    expect(row.lastUsed).toBe('never');
    expect(row.lastUsedWith).toBe('—');
  });

  it('uses a resolvable handle in the example line when only file councils exist', async () => {
    _resetForTests([fileCouncil({ stem: 'dream-team', name: 'Dream Team' })]);

    await printCouncilList(db);

    expect(logs.join('\n')).toContain('--council file:dream-team');
  });

  it('lists DB councils before file councils', async () => {
    const councilRepo = new CouncilRepository(db);
    await councilRepo.create({ id: uuidv4(), name: 'Saved Council', type: 'council', config: sampleConfig });
    _resetForTests([fileCouncil({ stem: 'dream-team', name: 'Dream Team' })]);

    await printCouncilList(db);

    const lines = tableLines();
    expect(lines.findIndex(l => l.includes('Saved Council')))
      .toBeLessThan(lines.findIndex(l => l.includes('Dream Team')));
  });
});
