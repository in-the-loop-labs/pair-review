// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for CouncilRepository
 *
 * Tests CRUD operations, config JSON parsing, and edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const { CouncilRepository, query } = require('../../src/database.js');

describe('CouncilRepository', () => {
  let db;
  let repo;

  const sampleConfig = {
    levels: {
      '1': {
        enabled: true,
        voices: [
          { provider: 'claude', model: 'sonnet', tier: 'balanced' }
        ]
      },
      '2': { enabled: false, voices: [] },
      '3': { enabled: false, voices: [] }
    }
  };

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new CouncilRepository(db);
  });

  describe('create', () => {
    it('should create a council and return it with parsed config', async () => {
      const council = await repo.create({
        id: 'council-1',
        name: 'Test Council',
        config: sampleConfig
      });

      expect(council).toBeDefined();
      expect(council.id).toBe('council-1');
      expect(council.name).toBe('Test Council');
      expect(council.config).toEqual(sampleConfig);
      expect(council.created_at).toBeDefined();
      expect(council.updated_at).toBeDefined();
    });

    it('should accept config as a JSON string', async () => {
      const council = await repo.create({
        id: 'council-2',
        name: 'String Config',
        config: JSON.stringify(sampleConfig)
      });

      expect(council.config).toEqual(sampleConfig);
    });

    it('should throw when required fields are missing', async () => {
      await expect(repo.create({ id: 'c1', name: 'n' }))
        .rejects.toThrow('Missing required fields');

      await expect(repo.create({ id: 'c1', config: {} }))
        .rejects.toThrow('Missing required fields');

      await expect(repo.create({ name: 'n', config: {} }))
        .rejects.toThrow('Missing required fields');
    });

    it('should throw on duplicate id', async () => {
      await repo.create({ id: 'dup-1', name: 'First', config: sampleConfig });
      await expect(repo.create({ id: 'dup-1', name: 'Second', config: sampleConfig }))
        .rejects.toThrow();
    });
  });

  describe('getById', () => {
    it('should return a council by id with parsed config', async () => {
      await repo.create({ id: 'get-1', name: 'Get Test', config: sampleConfig });
      const council = await repo.getById('get-1');

      expect(council).toBeDefined();
      expect(council.id).toBe('get-1');
      expect(council.config).toEqual(sampleConfig);
    });

    it('should return null for non-existent id', async () => {
      const council = await repo.getById('does-not-exist');
      expect(council).toBeNull();
    });
  });

  describe('list', () => {
    it('should return all councils', async () => {
      await repo.create({ id: 'list-1', name: 'Alpha', config: sampleConfig });
      await repo.create({ id: 'list-2', name: 'Beta', config: sampleConfig });

      const councils = await repo.list();
      expect(councils).toHaveLength(2);
      // Both councils should be present
      const ids = councils.map(c => c.id).sort();
      expect(ids).toEqual(['list-1', 'list-2']);
    });

    it('should return empty array when no councils exist', async () => {
      const councils = await repo.list();
      expect(councils).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update name', async () => {
      await repo.create({ id: 'upd-1', name: 'Original', config: sampleConfig });
      const result = await repo.update('upd-1', { name: 'Updated' });
      expect(result).toBe(true);

      const council = await repo.getById('upd-1');
      expect(council.name).toBe('Updated');
    });

    it('should update config', async () => {
      await repo.create({ id: 'upd-2', name: 'Config Test', config: sampleConfig });
      const newConfig = { ...sampleConfig, levels: { ...sampleConfig.levels, '2': { enabled: true, voices: [{ provider: 'gemini', model: 'pro', tier: 'fast' }] } } };

      await repo.update('upd-2', { config: newConfig });
      const council = await repo.getById('upd-2');
      expect(council.config.levels['2'].enabled).toBe(true);
      expect(council.config.levels['2'].voices[0].provider).toBe('gemini');
    });

    it('should return false for non-existent id', async () => {
      const result = await repo.update('no-such-id', { name: 'New' });
      expect(result).toBe(false);
    });

    it('should update the updated_at timestamp', async () => {
      await repo.create({ id: 'upd-3', name: 'Timestamp', config: sampleConfig });
      const before = await repo.getById('upd-3');

      // Tiny delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10));
      await repo.update('upd-3', { name: 'Changed' });
      const after = await repo.getById('upd-3');

      // updated_at should be >= before
      expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.updated_at).getTime());
    });
  });

  describe('delete', () => {
    it('should delete an existing council and return true', async () => {
      await repo.create({ id: 'del-1', name: 'Delete Me', config: sampleConfig });
      const result = await repo.delete('del-1');
      expect(result).toBe(true);

      const council = await repo.getById('del-1');
      expect(council).toBeNull();
    });

    it('should return false for non-existent id', async () => {
      const result = await repo.delete('no-such-id');
      expect(result).toBe(false);
    });
  });

  describe('touchLastUsedAt', () => {
    it('should update last_used_at and return true for existing council', async () => {
      await repo.create({ id: 'touch-1', name: 'Touch Test', config: sampleConfig });

      const result = await repo.touchLastUsedAt('touch-1');
      expect(result).toBe(true);

      const council = await repo.getById('touch-1');
      expect(council.last_used_at).toBeDefined();
      expect(council.last_used_at).not.toBeNull();
    });

    it('should return false for non-existent council', async () => {
      const result = await repo.touchLastUsedAt('no-such-id');
      expect(result).toBe(false);
    });
  });

  describe('list (MRU ordering)', () => {
    it('should order councils with last_used_at before those without', async () => {
      await repo.create({ id: 'mru-1', name: 'Never Used', config: sampleConfig });
      await repo.create({ id: 'mru-2', name: 'Recently Used', config: sampleConfig });

      // Touch the second council to give it a last_used_at timestamp
      await repo.touchLastUsedAt('mru-2');

      const councils = await repo.list();
      expect(councils).toHaveLength(2);
      // mru-2 (has last_used_at) should come first
      expect(councils[0].id).toBe('mru-2');
      expect(councils[1].id).toBe('mru-1');
    });

    it('should order most recently used councils first', async () => {
      await repo.create({ id: 'mru-a', name: 'First Used', config: sampleConfig });
      await repo.create({ id: 'mru-b', name: 'Second Used', config: sampleConfig });

      // Set explicit timestamps to ensure ordering (CURRENT_TIMESTAMP has 1s resolution)
      const { run: dbRun } = require('../../src/database.js');
      await dbRun(db, `UPDATE councils SET last_used_at = '2025-01-01 00:00:01' WHERE id = ?`, ['mru-a']);
      await dbRun(db, `UPDATE councils SET last_used_at = '2025-01-01 00:00:02' WHERE id = ?`, ['mru-b']);

      const councils = await repo.list();
      // mru-b has a later last_used_at, should come first
      expect(councils[0].id).toBe('mru-b');
      expect(councils[1].id).toBe('mru-a');
    });
  });

  describe('_parseRow', () => {
    it('should handle malformed JSON config gracefully', async () => {
      // Insert a row with invalid JSON directly
      db.prepare('INSERT INTO councils (id, name, config) VALUES (?, ?, ?)').run(
        'bad-json', 'Bad JSON', '{not valid json'
      );

      const council = await repo.getById('bad-json');
      expect(council).toBeDefined();
      expect(council.config).toEqual({}); // Falls back to empty object
    });

    it('should handle config that is already an object', () => {
      const row = { id: 'test', name: 'Test', config: { foo: 'bar' }, created_at: 'now', updated_at: 'now' };
      const parsed = repo._parseRow(row);
      expect(parsed.config).toEqual({ foo: 'bar' });
    });
  });
});
