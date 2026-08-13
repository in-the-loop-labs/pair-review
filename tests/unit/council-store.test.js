// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for CouncilStore (src/councils/council-store.js) — the merged read
 * surface over DB councils and the read-only file overlay.
 *
 * A real in-memory database (createTestDatabase) plus the real
 * CouncilRepository provides the DB half; the file half is primed through
 * `_resetForTests` so nothing ever reads the developer's real config dir.
 * Every test resets the module cache afterwards — it is process-wide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const {
  CouncilStore,
  createCouncilStore,
  isFileCouncilId,
  FILE_ID_PREFIX,
  _resetForTests
} = require('../../src/councils/council-store.js');
const { CouncilRepository, run: dbRun } = require('../../src/database.js');

const sampleConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

function fileCouncil(stem, name, overrides = {}) {
  return {
    id: `${FILE_ID_PREFIX}${stem}`,
    name,
    type: 'council',
    config: { voices: [{ provider: 'claude', model: 'sonnet' }], levels: { '1': true } },
    description: null,
    last_used_at: null,
    created_at: null,
    updated_at: null,
    source: 'file',
    readOnly: true,
    filePath: `/councils/${stem}.council.json`,
    ...overrides
  };
}

describe('isFileCouncilId', () => {
  it('recognizes file ids', () => {
    expect(isFileCouncilId('file:dream-team')).toBe(true);
    expect(isFileCouncilId(FILE_ID_PREFIX)).toBe(true);
  });

  it('rejects DB ids and non-strings', () => {
    expect(isFileCouncilId('4f2c9d0e-1111-2222-3333-444455556666')).toBe(false);
    expect(isFileCouncilId('a-file:council')).toBe(false);
    expect(isFileCouncilId(null)).toBe(false);
    expect(isFileCouncilId(undefined)).toBe(false);
    expect(isFileCouncilId(42)).toBe(false);
    expect(isFileCouncilId({ id: 'file:x' })).toBe(false);
  });
});

describe('FILE_ID_PREFIX', () => {
  it('is "file:"', () => {
    expect(FILE_ID_PREFIX).toBe('file:');
  });
});

describe('CouncilStore', () => {
  let db;
  let repo;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new CouncilRepository(db);
  });

  afterEach(() => {
    _resetForTests();
    if (db) db.close();
  });

  describe('list', () => {
    it('returns DB rows in repository MRU order, then file rows sorted by name', async () => {
      await repo.create({ id: 'db-old', name: 'Older DB Council', config: sampleConfig });
      await repo.create({ id: 'db-new', name: 'Newer DB Council', config: sampleConfig });
      await repo.touchLastUsedAt('db-new');

      const store = new CouncilStore(db, [
        fileCouncil('zeta', 'Zeta Squad'),
        fileCouncil('alpha', 'Alpha Squad')
      ]);

      const councils = await store.list();

      expect(councils.map(c => c.id)).toEqual([
        'db-new',   // touched → MRU first
        'db-old',
        'file:alpha',
        'file:zeta'
      ]);
    });

    it('stamps source on both kinds of row', async () => {
      await repo.create({ id: 'db-1', name: 'DB Council', config: sampleConfig });
      const store = new CouncilStore(db, [fileCouncil('team', 'File Council')]);

      const councils = await store.list();

      expect(councils.find(c => c.id === 'db-1').source).toBe('db');
      expect(councils.find(c => c.id === 'file:team').source).toBe('file');
      expect(councils.find(c => c.id === 'file:team').readOnly).toBe(true);
      expect(councils.find(c => c.id === 'db-1').readOnly).toBeUndefined();
    });

    it('sorts file rows case-insensitively by name via localeCompare', async () => {
      const store = new CouncilStore(db, [
        fileCouncil('b', 'banana'),
        fileCouncil('a', 'Apple'),
        fileCouncil('c', 'Cherry')
      ]);

      expect((await store.list()).map(c => c.name)).toEqual(['Apple', 'banana', 'Cherry']);
    });

    it('does not mutate or expose the overlay array', async () => {
      const overlay = [fileCouncil('two', 'Two'), fileCouncil('one', 'One')];
      const store = new CouncilStore(db, overlay);

      const councils = await store.list();
      councils[0].name = 'MUTATED';

      expect(overlay.map(c => c.id)).toEqual(['file:two', 'file:one']);
      expect(overlay.find(c => c.id === 'file:one').name).toBe('One');
    });

    it('returns only DB rows when the overlay is empty', async () => {
      await repo.create({ id: 'db-only', name: 'DB Only', config: sampleConfig });
      const store = new CouncilStore(db, []);

      expect((await store.list()).map(c => c.id)).toEqual(['db-only']);
    });

    it('returns only file rows when the database has none', async () => {
      const store = new CouncilStore(db, [fileCouncil('solo', 'Solo')]);

      expect((await store.list()).map(c => c.id)).toEqual(['file:solo']);
    });

    it('tolerates a non-array overlay', async () => {
      await repo.create({ id: 'db-x', name: 'X', config: sampleConfig });

      expect((await new CouncilStore(db, undefined).list()).map(c => c.id)).toEqual(['db-x']);
      expect((await new CouncilStore(db, null).list()).map(c => c.id)).toEqual(['db-x']);
    });
  });

  describe('getById', () => {
    it('returns a DB council stamped source: db', async () => {
      await repo.create({ id: 'db-get', name: 'Fetch Me', config: sampleConfig, type: 'advanced' });
      const store = new CouncilStore(db, [fileCouncil('team', 'File Council')]);

      const council = await store.getById('db-get');

      expect(council.id).toBe('db-get');
      expect(council.name).toBe('Fetch Me');
      expect(council.config).toEqual(sampleConfig);
      expect(council.source).toBe('db');
    });

    it('returns a file council from the overlay', async () => {
      const store = new CouncilStore(db, [fileCouncil('team', 'File Council')]);

      const council = await store.getById('file:team');

      expect(council.name).toBe('File Council');
      expect(council.source).toBe('file');
      expect(council.readOnly).toBe(true);
      expect(council.filePath).toBe('/councils/team.council.json');
      expect(council.last_used_at).toBeNull();
    });

    it('returns a copy so callers cannot corrupt the overlay', async () => {
      const overlay = [fileCouncil('team', 'File Council')];
      const store = new CouncilStore(db, overlay);

      (await store.getById('file:team')).name = 'MUTATED';

      expect(overlay[0].name).toBe('File Council');
    });

    it('returns null for an unknown DB id', async () => {
      const store = new CouncilStore(db, [fileCouncil('team', 'File Council')]);

      expect(await store.getById('no-such-council')).toBeNull();
    });

    it('returns null for an unknown file id without touching the database', async () => {
      // A DB row whose id IS the queried `file:` id: if getById fell through to
      // the repository this row would come back instead of null.
      await repo.create({ id: 'file:missing', name: 'Not It', config: sampleConfig });
      const store = new CouncilStore(db, [fileCouncil('team', 'File Council')]);

      expect(await store.getById('file:missing')).toBeNull();
    });

    it('deep-copies the config so a caller cannot poison the process-wide overlay', async () => {
      const overlay = [fileCouncil('team', 'File Council')];
      const store = new CouncilStore(db, overlay);

      const first = await store.getById('file:team');
      first.config.levels['1'] = 'MUTATED';

      expect((await store.getById('file:team')).config.levels['1']).toBe(true);
      expect(overlay[0].config.levels['1']).toBe(true);
    });

    it('deep-copies list() configs too', async () => {
      const overlay = [fileCouncil('team', 'File Council')];
      const store = new CouncilStore(db, overlay);

      (await store.list())[0].config.levels['1'] = 'MUTATED';

      expect((await store.list())[0].config.levels['1']).toBe(true);
      expect(overlay[0].config.levels['1']).toBe(true);
    });
  });
});

describe('createCouncilStore', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(() => {
    _resetForTests();
    if (db) db.close();
  });

  it('builds a store over the primed overlay', async () => {
    _resetForTests([fileCouncil('primed', 'Primed Council')]);
    await new CouncilRepository(db).create({ id: 'db-1', name: 'DB One', config: sampleConfig });

    const store = await createCouncilStore(db);

    expect(store).toBeInstanceOf(CouncilStore);
    expect((await store.list()).map(c => c.id)).toEqual(['db-1', 'file:primed']);
    expect((await store.getById('file:primed')).name).toBe('Primed Council');
  });

  it('reuses the primed overlay across stores (cached once per process)', async () => {
    _resetForTests([fileCouncil('cached', 'Cached Council')]);

    const first = await createCouncilStore(db);
    const second = await createCouncilStore(db);

    expect(first.fileCouncils).toBe(second.fileCouncils);
  });

  it('falls back to an empty overlay once the cache is cleared (PAIR_REVIEW_NO_FILE_COUNCILS)', async () => {
    expect(process.env.PAIR_REVIEW_NO_FILE_COUNCILS).toBe('1');
    _resetForTests([fileCouncil('primed', 'Primed Council')]);
    _resetForTests();

    const store = await createCouncilStore(db);

    expect(store.fileCouncils).toEqual([]);
    expect(await store.getById('file:primed')).toBeNull();
  });

  it('keeps the DB half live: a council created after the store still lists', async () => {
    _resetForTests([]);
    const store = await createCouncilStore(db);
    expect(await store.list()).toEqual([]);

    await dbRun(
      db,
      `INSERT INTO councils (id, name, type, config) VALUES (?, ?, ?, ?)`,
      ['late', 'Late Arrival', 'council', JSON.stringify(sampleConfig)]
    );

    expect((await store.list()).map(c => c.id)).toEqual(['late']);
  });
});
