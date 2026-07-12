// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for ChatSnippetRepository
 *
 * Tests CRUD operations, MRU ordering, and edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const { ChatSnippetRepository, run: dbRun } = require('../../src/database.js');

describe('ChatSnippetRepository', () => {
  let db;
  let repo;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new ChatSnippetRepository(db);
  });

  describe('create', () => {
    it('should create a snippet and return it', async () => {
      const snippet = await repo.create({ body: 'Review this for security issues' });

      expect(snippet).toBeDefined();
      expect(snippet.id).toBeDefined();
      expect(snippet.body).toBe('Review this for security issues');
      expect(snippet.last_used_at).toBeNull();
      expect(snippet.created_at).toBeDefined();
      expect(snippet.updated_at).toBeDefined();
    });

    it('should reject an empty body', async () => {
      await expect(repo.create({ body: '' })).rejects.toThrow('body is required');
      await expect(repo.create({ body: '   ' })).rejects.toThrow('body is required');
    });

    it('should reject a non-string body', async () => {
      await expect(repo.create({ body: 42 })).rejects.toThrow('body is required');
      await expect(repo.create({})).rejects.toThrow('body is required');
    });
  });

  describe('getById', () => {
    it('should return a snippet by id', async () => {
      const created = await repo.create({ body: 'Hello' });
      const snippet = await repo.getById(created.id);

      expect(snippet).toBeDefined();
      expect(snippet.id).toBe(created.id);
      expect(snippet.body).toBe('Hello');
    });

    it('should return null for a non-existent id', async () => {
      const snippet = await repo.getById(99999);
      expect(snippet).toBeNull();
    });
  });

  describe('list', () => {
    it('should return an empty array when no snippets exist', async () => {
      const snippets = await repo.list();
      expect(snippets).toEqual([]);
    });

    it('should return all snippets', async () => {
      await repo.create({ body: 'One' });
      await repo.create({ body: 'Two' });

      const snippets = await repo.list();
      expect(snippets).toHaveLength(2);
    });

    it('should order snippets with last_used_at before those without', async () => {
      const never = await repo.create({ body: 'Never Used' });
      const used = await repo.create({ body: 'Recently Used' });

      await repo.touchLastUsedAt(used.id);

      const snippets = await repo.list();
      expect(snippets).toHaveLength(2);
      expect(snippets[0].id).toBe(used.id);
      expect(snippets[1].id).toBe(never.id);
    });

    it('should order most recently used snippets first', async () => {
      const a = await repo.create({ body: 'First Used' });
      const b = await repo.create({ body: 'Second Used' });

      // Set explicit timestamps (CURRENT_TIMESTAMP has 1s resolution)
      await dbRun(db, `UPDATE chat_snippets SET last_used_at = '2025-01-01 00:00:01' WHERE id = ?`, [a.id]);
      await dbRun(db, `UPDATE chat_snippets SET last_used_at = '2025-01-01 00:00:02' WHERE id = ?`, [b.id]);

      const snippets = await repo.list();
      expect(snippets[0].id).toBe(b.id);
      expect(snippets[1].id).toBe(a.id);
    });

    it('should break ties among unused snippets by updated_at DESC', async () => {
      const older = await repo.create({ body: 'Older' });
      const newer = await repo.create({ body: 'Newer' });

      await dbRun(db, `UPDATE chat_snippets SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [older.id]);
      await dbRun(db, `UPDATE chat_snippets SET updated_at = '2025-01-01 00:00:00' WHERE id = ?`, [newer.id]);

      const snippets = await repo.list();
      expect(snippets[0].id).toBe(newer.id);
      expect(snippets[1].id).toBe(older.id);
    });
  });

  describe('update', () => {
    it('should update the body and return true', async () => {
      const created = await repo.create({ body: 'Original' });
      const result = await repo.update(created.id, { body: 'Changed' });
      expect(result).toBe(true);

      const snippet = await repo.getById(created.id);
      expect(snippet.body).toBe('Changed');
    });

    it('should bump updated_at', async () => {
      const created = await repo.create({ body: 'Original' });

      // Backdate so the CURRENT_TIMESTAMP write (1s resolution) is guaranteed
      // to differ — no sleep needed
      await dbRun(db, `UPDATE chat_snippets SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [created.id]);
      const before = await repo.getById(created.id);

      await repo.update(created.id, { body: 'Changed' });
      const after = await repo.getById(created.id);

      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
    });

    it('should return false for a non-existent id', async () => {
      const result = await repo.update(99999, { body: 'Nope' });
      expect(result).toBe(false);
    });

    it('should reject an empty body', async () => {
      const created = await repo.create({ body: 'Original' });
      await expect(repo.update(created.id, { body: '' })).rejects.toThrow('body is required');
    });
  });

  describe('touchLastUsedAt', () => {
    it('should set last_used_at and return true for an existing snippet', async () => {
      const created = await repo.create({ body: 'Touch me' });

      const result = await repo.touchLastUsedAt(created.id);
      expect(result).toBe(true);

      const snippet = await repo.getById(created.id);
      expect(snippet.last_used_at).not.toBeNull();
    });

    it('should return false for a non-existent snippet', async () => {
      const result = await repo.touchLastUsedAt(99999);
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete an existing snippet and return true', async () => {
      const created = await repo.create({ body: 'Delete me' });
      const result = await repo.delete(created.id);
      expect(result).toBe(true);

      const snippet = await repo.getById(created.id);
      expect(snippet).toBeNull();
    });

    it('should return false for a non-existent snippet', async () => {
      const result = await repo.delete(99999);
      expect(result).toBe(false);
    });
  });
});
