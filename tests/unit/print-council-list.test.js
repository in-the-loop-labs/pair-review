// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for printCouncilList (src/main.js, used by --list-councils).
 *
 * These tests use a real in-memory database (the same createTestDatabase helper
 * the rest of the suite uses) plus the real CouncilRepository /
 * AnalysisRunRepository, and capture console.log output to assert on the
 * rendered table. They verify the empty-DB message, the populated table
 * (handles, names, types, last-used repo), and the header/footer guidance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const { printCouncilList } = require('../../src/main');
const { CouncilRepository, AnalysisRunRepository } = require('../../src/database.js');
const { shortId } = require('../../src/councils/resolve-council.js');

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
    if (spy) spy.mockRestore();
    if (db) db.close();
  });

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
    expect(output).toContain('LAST USED');
    expect(output).toContain('LAST USED WITH');
  });
});
