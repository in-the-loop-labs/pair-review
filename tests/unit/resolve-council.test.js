// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the council handle resolver.
 *
 * Covers resolveCouncilHandle (id / id-prefix / name / normalized-name matching,
 * ambiguity, and not-found) and getCouncilLastUsedRepos (most-recent council run
 * per council, with inline-config and run-less councils excluded).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const {
  normalizeForMatch,
  shortId,
  resolveCouncilHandle,
  getCouncilLastUsedRepos
} = require('../../src/councils/resolve-council.js');
const { CouncilRepository, AnalysisRunRepository } = require('../../src/database.js');

const sampleConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

describe('normalizeForMatch', () => {
  it('lowercases, trims, and slugifies', () => {
    expect(normalizeForMatch('  My Council  ')).toBe('my-council');
    expect(normalizeForMatch('Security_Review!!')).toBe('security-review');
    expect(normalizeForMatch('--Edge--')).toBe('edge');
  });

  it('handles null/undefined safely', () => {
    expect(normalizeForMatch(null)).toBe('');
    expect(normalizeForMatch(undefined)).toBe('');
  });
});

describe('shortId', () => {
  it('truncates to the first 8 characters', () => {
    expect(shortId('a1b2c3d4-e5f6-7890')).toBe('a1b2c3d4');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe('');
  });
});

describe('resolveCouncilHandle', () => {
  let db;
  let councilRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    councilRepo = new CouncilRepository(db);
  });

  it('resolves an exact id match', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'Security Review', config: sampleConfig });

    const result = await resolveCouncilHandle(db, id);
    expect(result.id).toBe(id);
    expect(result.name).toBe('Security Review');
  });

  it('resolves a unique UUID-prefix match', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'Security Review', config: sampleConfig });

    const result = await resolveCouncilHandle(db, id.slice(0, 8));
    expect(result.id).toBe(id);
  });

  it('throws on an ambiguous UUID-prefix match, listing the full ids', async () => {
    const id1 = 'aaaa1111-1111-4111-8111-111111111111';
    const id2 = 'aaaa2222-2222-4222-8222-222222222222';
    await councilRepo.create({ id: id1, name: 'First Council', config: sampleConfig });
    await councilRepo.create({ id: id2, name: 'Second Council', config: sampleConfig });

    let err;
    try {
      await resolveCouncilHandle(db, 'aaaa');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Ambiguous council "aaaa" matches 2 councils/);
    // Full UUIDs must appear so the user can actually disambiguate.
    expect(err.message).toContain(id1);
    expect(err.message).toContain(id2);
  });

  it('ambiguity error shows the FULL id, not the truncated shortId, when prefixes collide', async () => {
    // Both ids share the same 8-char prefix, so shortId() would be identical for
    // both rows and could not disambiguate. The full UUIDs must be present.
    const id1 = 'abcd1234-1111-4111-8111-111111111111';
    const id2 = 'abcd1234-2222-4222-8222-222222222222';
    await councilRepo.create({ id: id1, name: 'First Council', config: sampleConfig });
    await councilRepo.create({ id: id2, name: 'Second Council', config: sampleConfig });

    let err;
    try {
      await resolveCouncilHandle(db, 'abcd1234');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Ambiguous council "abcd1234" matches 2 councils/);
    expect(err.message).toContain(id1);
    expect(err.message).toContain(id2);
    // The shared prefix alone is insufficient: each candidate line must carry a
    // distinct full UUID (i.e. the parenthesized portion is not just the prefix).
    expect(err.message).toContain('(abcd1234-1111-4111-8111-111111111111)');
    expect(err.message).toContain('(abcd1234-2222-4222-8222-222222222222)');
  });

  it('resolves an exact name match case-insensitively', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'My Council', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'my council');
    expect(result.id).toBe(id);
  });

  it('resolves a normalized-name match', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'My Council', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'my-council');
    expect(result.id).toBe(id);
  });

  it('throws on duplicate-name ambiguity with a candidate list', async () => {
    const id1 = uuidv4();
    const id2 = uuidv4();
    await councilRepo.create({ id: id1, name: 'Review', config: sampleConfig });
    await councilRepo.create({ id: id2, name: 'Review', config: sampleConfig });

    let err;
    try {
      await resolveCouncilHandle(db, 'Review');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Ambiguous council "Review" matches 2 councils/);
    // Full ids (which subsume the shortId prefix) are shown for disambiguation.
    expect(err.message).toContain(id1);
    expect(err.message).toContain(id2);
  });

  it('throws a not-found error with the --list-councils hint', async () => {
    await councilRepo.create({ id: uuidv4(), name: 'Something Else', config: sampleConfig });

    await expect(resolveCouncilHandle(db, 'nonexistent'))
      .rejects.toThrow(/No council matches "nonexistent"\. Run `pair-review --list-councils`/);
  });

  it('throws when the handle is missing', async () => {
    await expect(resolveCouncilHandle(db, '')).rejects.toThrow('A council handle is required.');
    await expect(resolveCouncilHandle(db, undefined)).rejects.toThrow('A council handle is required.');
  });

  it('treats a short non-hex handle as a name match, not a prefix', async () => {
    // 'rev' is length 3 and not hex-only, so it must not be treated as a UUID prefix.
    // It should resolve by normalized name only when it exactly matches a council name.
    const id = uuidv4();
    await councilRepo.create({ id, name: 'rev', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'rev');
    expect(result.id).toBe(id);
  });

  it('resolves a partial (substring) name fragment that matches exactly one council', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'Dream Team Review', config: sampleConfig });
    await councilRepo.create({ id: uuidv4(), name: 'Security Audit', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'dream');
    expect(result.id).toBe(id);
  });

  it('throws an ambiguity error listing all partial matches with full ids', async () => {
    const id1 = uuidv4();
    const id2 = uuidv4();
    await councilRepo.create({ id: id1, name: 'Dream Team Review', config: sampleConfig });
    await councilRepo.create({ id: id2, name: 'Daydream Council', config: sampleConfig });
    await councilRepo.create({ id: uuidv4(), name: 'Security Audit', config: sampleConfig });

    let err;
    try {
      await resolveCouncilHandle(db, 'dream');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Ambiguous council "dream" matches 2 councils/);
    expect(err.message).toContain(id1);
    expect(err.message).toContain(id2);
  });

  it('matches a fragment via the normalized name (spaces/punctuation collapsed)', async () => {
    const id = uuidv4();
    await councilRepo.create({ id, name: 'Front-End Review', config: sampleConfig });

    // 'front end' normalizes to 'front-end', a substring of the normalized name.
    const result = await resolveCouncilHandle(db, 'front end');
    expect(result.id).toBe(id);
  });

  it('does not double-count a council matched by both raw and normalized substring', async () => {
    // 'Review' matches both c.name.includes (raw) and the normalized substring.
    // De-duplication by id means a single matching council resolves, not throws.
    const id = uuidv4();
    await councilRepo.create({ id, name: 'Review Board', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'review');
    expect(result.id).toBe(id);
  });

  it('still throws "No council matches" when a fragment matches nothing', async () => {
    await councilRepo.create({ id: uuidv4(), name: 'Security Review', config: sampleConfig });

    await expect(resolveCouncilHandle(db, 'zzz-nomatch'))
      .rejects.toThrow(/No council matches "zzz-nomatch"\. Run `pair-review --list-councils`/);
  });

  it('lets an exact name win over a substring match (precedence preserved)', async () => {
    // 'Review' is an exact name for one council and a substring of another.
    // The exact-name tier must win and return the exact match, not throw on the
    // substring collision.
    const exactId = uuidv4();
    const substringId = uuidv4();
    await councilRepo.create({ id: exactId, name: 'Review', config: sampleConfig });
    await councilRepo.create({ id: substringId, name: 'Review Board', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'Review');
    expect(result.id).toBe(exactId);
  });

  it('lets a unique id-prefix win over a substring name match (precedence preserved)', async () => {
    // Construct a hex-ish handle that is a unique id prefix AND a substring of
    // another council's name. The id-prefix tier must win.
    const targetId = 'abcdef12-1111-4111-8111-111111111111';
    await councilRepo.create({ id: targetId, name: 'Target Council', config: sampleConfig });
    // This council's name contains 'abcdef' as a substring, so it would match the
    // substring tier — but the id-prefix tier resolves first.
    await councilRepo.create({ id: uuidv4(), name: 'The abcdef Review', config: sampleConfig });

    const result = await resolveCouncilHandle(db, 'abcdef');
    expect(result.id).toBe(targetId);
  });
});

describe('getCouncilLastUsedRepos', () => {
  let db;
  let councilRepo;
  let runRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    councilRepo = new CouncilRepository(db);
    runRepo = new AnalysisRunRepository(db);
  });

  it('returns the most recent council run repo per council and excludes inline-config and run-less councils', async () => {
    const councilId = uuidv4();
    const councilNoRuns = uuidv4();
    await councilRepo.create({ id: councilId, name: 'Used Council', config: sampleConfig });
    await councilRepo.create({ id: councilNoRuns, name: 'Unused Council', config: sampleConfig });

    // Older run against owner/repo PR #5
    const reviewOld = seedTestReview(db, { prNumber: 5, repository: 'owner/repo' });
    const runOldId = uuidv4();
    await runRepo.create({
      id: runOldId,
      reviewId: reviewOld,
      provider: 'council',
      model: councilId,
      status: 'completed',
      configType: 'council',
      levelsConfig: sampleConfig.levels
    });

    // Newer run against other/repo PR #9
    const reviewNew = seedTestReview(db, { prNumber: 9, repository: 'other/repo' });
    const runNewId = uuidv4();
    await runRepo.create({
      id: runNewId,
      reviewId: reviewNew,
      provider: 'council',
      model: councilId,
      status: 'completed',
      configType: 'council',
      levelsConfig: sampleConfig.levels
    });

    // Force deterministic ordering: old run earlier than new run.
    db.prepare("UPDATE analysis_runs SET started_at = '2026-01-01 00:00:00' WHERE id = ?").run(runOldId);
    db.prepare("UPDATE analysis_runs SET started_at = '2026-06-01 00:00:00' WHERE id = ?").run(runNewId);

    // An inline-config run should be ignored entirely.
    const reviewInline = seedTestReview(db, { prNumber: 11, repository: 'inline/repo' });
    const runInlineId = uuidv4();
    await runRepo.create({
      id: runInlineId,
      reviewId: reviewInline,
      provider: 'council',
      model: 'inline-config',
      status: 'completed',
      configType: 'council',
      levelsConfig: sampleConfig.levels
    });

    const map = await getCouncilLastUsedRepos(db);

    // The used council maps to the MORE RECENT run's repo.
    expect(map.has(councilId)).toBe(true);
    const entry = map.get(councilId);
    expect(entry.repository).toBe('other/repo');
    expect(entry.review_type).toBe('pr');
    expect(entry.pr_number).toBe(9);
    expect(entry.last_started).toBe('2026-06-01 00:00:00');

    // inline-config is excluded.
    expect(map.has('inline-config')).toBe(false);

    // A council with no runs is absent.
    expect(map.has(councilNoRuns)).toBe(false);
  });
});
