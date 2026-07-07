// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for src/interactive-analysis-config.js.
 *
 * Covers:
 *   - resolveCliInstructions: --instructions text, --instructions-file read,
 *     trim/empty handling, the 5000-char cap, and unreadable-file errors.
 *   - prepareInteractiveAnalysisConfig: the CLI→browser bridge that stashes the
 *     resolved review config + instructions in the bulk-analysis store and
 *     returns the analysisConfigId (null when no instructions). Single and
 *     council (repo-default) shapes are checked against the persisted entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

const {
  resolveCliInstructions,
  buildInteractiveAnalysisConfig,
  prepareInteractiveAnalysisConfig
} = require('../../src/interactive-analysis-config.js');
const bulkConfigs = require('../../src/routes/bulk-analysis-configs.js');
const { CouncilRepository } = require('../../src/database.js');

const REPOSITORY = 'owner/repo';

const advancedConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

describe('resolveCliInstructions', () => {
  it('returns null when neither flag is supplied', async () => {
    expect(await resolveCliInstructions({})).toBeNull();
  });

  it('returns the --instructions text, trimmed', async () => {
    expect(await resolveCliInstructions({ instructions: '  focus on auth  ' })).toBe('focus on auth');
  });

  it('returns null for whitespace-only --instructions', async () => {
    expect(await resolveCliInstructions({ instructions: '   ' })).toBeNull();
  });

  it('reads --instructions-file from disk', async () => {
    const file = path.join(os.tmpdir(), `pr-instr-${uuidv4()}.txt`);
    fs.writeFileSync(file, '  review the migration carefully \n');
    try {
      expect(await resolveCliInstructions({ instructionsFile: file })).toBe('review the migration carefully');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('throws a clear error when --instructions-file cannot be read', async () => {
    await expect(
      resolveCliInstructions({ instructionsFile: '/no/such/file-xyz.txt' })
    ).rejects.toThrow(/Failed to read --instructions-file/);
  });

  it('throws when the text exceeds the 5000-char cap', async () => {
    await expect(
      resolveCliInstructions({ instructions: 'x'.repeat(5001) })
    ).rejects.toThrow(/5000-character limit/);
  });
});

describe('buildInteractiveAnalysisConfig (pure builder, no storage)', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
    bulkConfigs._resetBulkAnalysisConfigs();
  });

  afterEach(() => {
    bulkConfigs._resetBulkAnalysisConfigs();
    closeTestDatabase(db);
  });

  it('returns null when no instructions are supplied', async () => {
    const cfg = await buildInteractiveAnalysisConfig({
      db, config: {}, flags: { ai: true }, repository: REPOSITORY
    });
    expect(cfg).toBeNull();
  });

  it('returns a single provider/model object (with instructions) and does NOT store it', async () => {
    const cfg = await buildInteractiveAnalysisConfig({
      db,
      config: { default_provider: 'claude', default_model: 'opus' },
      flags: { ai: true, instructions: 'be terse' },
      repository: REPOSITORY
    });

    expect(cfg).toEqual({ provider: 'claude', model: 'opus', customInstructions: 'be terse' });
    // Pure: the returned object is the raw config, NOT a stored entry (no id), and
    // nothing was written to the in-process bulk store.
    expect(cfg.id).toBeUndefined();
    expect(cfg.isCouncil).toBeUndefined();
  });

  it('honors an explicit --provider (regression: provider must not be dropped)', async () => {
    // Regression for the delegated `--ai --provider --instructions` path: this
    // builder used to omit flags.provider from the resolveReviewConfig picks, so
    // the explicit provider silently fell through to the config default. With
    // config.default_provider = 'claude' and flags.provider = 'codex', the
    // explicit pick must win. Model is unspecified, so it resolves from config.
    const cfg = await buildInteractiveAnalysisConfig({
      db,
      config: { default_provider: 'claude', default_model: 'opus' },
      flags: { ai: true, provider: 'codex', instructions: 'be terse' },
      repository: REPOSITORY
    });

    expect(cfg).toEqual({ provider: 'codex', model: 'opus', customInstructions: 'be terse' });
  });

  it('an explicit --provider overrides a repo default council (regression: no silent council switch)', async () => {
    // The nastier aggravating factor: when the repo has a default council, a
    // dropped --provider fell through to the COUNCIL branch — silently switching
    // the delegated run to council mode. An explicit provider pick must yield a
    // single selection, never the repo default council.
    const councilId = uuidv4();
    await new CouncilRepository(db).create({ id: councilId, name: 'Security', config: advancedConfig, type: 'advanced' });
    await db.prepare(
      'INSERT INTO repo_settings (repository, default_council_id) VALUES (?, ?)'
    ).run(REPOSITORY, councilId);

    const cfg = await buildInteractiveAnalysisConfig({
      db,
      config: {},
      flags: { ai: true, provider: 'codex', instructions: 'be terse' },
      repository: REPOSITORY
    });

    expect(cfg.isCouncil).toBeUndefined();
    expect(cfg.provider).toBe('codex');
    expect(cfg.customInstructions).toBe('be terse');
  });

  it('returns a council snapshot object (with instructions) when --council is given', async () => {
    const councilId = uuidv4();
    await new CouncilRepository(db).create({ id: councilId, name: 'Security', config: advancedConfig, type: 'advanced' });

    const cfg = await buildInteractiveAnalysisConfig({
      db,
      config: {},
      flags: { council: 'Security', instructions: 'check authz' },
      repository: REPOSITORY
    });

    expect(cfg.isCouncil).toBe(true);
    expect(cfg.configType).toBe('advanced');
    expect(cfg.councilName).toBe('Security');
    expect(cfg.councilConfig).toBeTruthy();
    expect(cfg.customInstructions).toBe('check authz');
    // Inline snapshot only — no councilId, so the analysis route uses the resolved
    // config rather than re-fetching by id.
    expect(cfg.councilId).toBeUndefined();
  });
});

describe('prepareInteractiveAnalysisConfig', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
    bulkConfigs._resetBulkAnalysisConfigs();
  });

  afterEach(() => {
    bulkConfigs._resetBulkAnalysisConfigs();
    closeTestDatabase(db);
  });

  it('returns null when no instructions are supplied (caller keeps prior URL shape)', async () => {
    const id = await prepareInteractiveAnalysisConfig({
      db, config: {}, flags: { ai: true }, repository: REPOSITORY
    });
    expect(id).toBeNull();
  });

  it('stashes a single provider/model + instructions and returns a resolvable id', async () => {
    const id = await prepareInteractiveAnalysisConfig({
      db,
      config: { default_provider: 'claude', default_model: 'opus' },
      flags: { ai: true, instructions: 'be terse' },
      repository: REPOSITORY
    });

    expect(id).toBeTruthy();
    const stored = bulkConfigs._getBulkAnalysisConfig(id);
    expect(stored).toBeTruthy();
    expect(stored.isCouncil).toBeUndefined();
    expect(stored.provider).toBe('claude');
    expect(stored.model).toBe('opus');
    expect(stored.customInstructions).toBe('be terse');
  });

  it('honors an explicit --model when stashing the single config', async () => {
    // 'haiku' is a real claude model id, so it survives the bulk store's
    // defense-in-depth model normalization unchanged.
    const id = await prepareInteractiveAnalysisConfig({
      db,
      config: { default_provider: 'claude' },
      flags: { ai: true, model: 'haiku', instructions: 'focus on tests' },
      repository: REPOSITORY
    });

    const stored = bulkConfigs._getBulkAnalysisConfig(id);
    expect(stored.model).toBe('haiku');
    expect(stored.customInstructions).toBe('focus on tests');
  });

  it('stashes a council snapshot + instructions when --council is given', async () => {
    const councilId = uuidv4();
    await new CouncilRepository(db).create({ id: councilId, name: 'Security', config: advancedConfig, type: 'advanced' });

    const id = await prepareInteractiveAnalysisConfig({
      db,
      config: {},
      flags: { council: 'Security', instructions: 'check authz' },
      repository: REPOSITORY
    });

    const stored = bulkConfigs._getBulkAnalysisConfig(id);
    expect(stored.isCouncil).toBe(true);
    expect(stored.configType).toBe('advanced');
    expect(stored.councilName).toBe('Security');
    expect(stored.councilConfig).toBeTruthy();
    expect(stored.customInstructions).toBe('check authz');
    // Inline snapshot forces the analysis route to use the resolved config, not
    // re-fetch by id.
    expect(stored.councilId).toBeUndefined();
  });
});
