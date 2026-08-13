// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the file-council loader (src/councils/file-councils.js).
 *
 * These use a REAL temp directory (mkdtemp per file, per tests/CONVENTIONS.md)
 * because reading actual files off disk is exactly what the loader does; only
 * the logger is injected, to keep warnings assertable and off the console.
 * The fake-fs injection is reserved for the one case a real directory cannot
 * produce portably: a readdir failure that is not ENOENT.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const {
  loadFileCouncils,
  councilFileStem,
  defaultCouncilsDir
} = require('../../src/councils/file-councils.js');

const councilConfig = {
  voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }],
  levels: { '1': true, '2': false, '3': false }
};

const advancedConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
    '2': { enabled: false, voices: [] }
  }
};

function councilDoc(overrides = {}) {
  return {
    pair_review_council: 1,
    name: 'Dream Team',
    type: 'council',
    config: councilConfig,
    ...overrides
  };
}

let tmpRoot;
let logger;
let dirCounter = 0;

/**
 * Create a fresh directory containing the given files.
 * @param {Object<string, string|Object>} files - filename → contents (objects
 *   are JSON-stringified)
 * @returns {Promise<string>} the directory path
 */
async function makeCouncilDir(files) {
  const dir = path.join(tmpRoot, `dir-${dirCounter++}`);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
    await fs.writeFile(path.join(dir, name), text, 'utf-8');
  }
  return dir;
}

function load(dirs, extraDeps) {
  return loadFileCouncils({ dirs, _deps: { logger, ...extraDeps } });
}

beforeEach(async () => {
  if (!tmpRoot) {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-file-councils-'));
  }
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

describe('councilFileStem', () => {
  it('strips .council.json', () => {
    expect(councilFileStem('dream-team.council.json')).toBe('dream-team');
  });

  it('strips a plain .json', () => {
    expect(councilFileStem('dream-team.json')).toBe('dream-team');
  });

  it('only strips the trailing .council.json, not an inner one', () => {
    expect(councilFileStem('my.council.json.json')).toBe('my.council.json');
  });
});

describe('defaultCouncilsDir', () => {
  it('is a councils/ subdirectory of the config dir', () => {
    const dir = defaultCouncilsDir();
    expect(path.basename(dir)).toBe('councils');
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

describe('loadFileCouncils', () => {
  it('loads a valid council document with the full overlay row shape', async () => {
    const dir = await makeCouncilDir({
      'dream-team.council.json': councilDoc({ description: 'The good one' })
    });

    const councils = await load([dir]);

    expect(councils).toHaveLength(1);
    expect(councils[0]).toEqual({
      id: 'file:dream-team',
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: 'The good one',
      last_used_at: null,
      created_at: null,
      updated_at: null,
      source: 'file',
      readOnly: true,
      filePath: path.join(dir, 'dream-team.council.json')
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('loads a valid advanced document, including the legacy orchestration key', async () => {
    const dir = await makeCouncilDir({
      'deep.council.json': councilDoc({
        name: 'Deep Review',
        type: 'advanced',
        config: {
          ...advancedConfig,
          orchestration: { provider: 'claude', model: 'opus' }
        }
      })
    });

    const councils = await load([dir]);

    expect(councils).toHaveLength(1);
    expect(councils[0].type).toBe('advanced');
    expect(councils[0].config.orchestration).toEqual({ provider: 'claude', model: 'opus' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns the ORIGINAL config, not the normalized one', async () => {
    // A voice-centric council whose config is authored in the level-centric
    // shape: normalization rewrites it to { voices, levels: booleans } before
    // validating, but the row must carry what the file said.
    const dir = await makeCouncilDir({
      'authored.council.json': councilDoc({ config: advancedConfig })
    });

    const councils = await load([dir]);

    expect(councils).toHaveLength(1);
    expect(councils[0].config).toEqual(advancedConfig);
    expect(councils[0].config.voices).toBeUndefined();
    expect(councils[0].config.levels['1']).toEqual(advancedConfig.levels['1']);
  });

  it('sets description to null when the document has none', async () => {
    const dir = await makeCouncilDir({ 'plain.council.json': councilDoc() });

    const [council] = await load([dir]);

    expect(council.description).toBeNull();
  });

  it('sets description to null when the document has a blank one', async () => {
    const dir = await makeCouncilDir({
      'blank.council.json': councilDoc({ description: '   ' })
    });

    const [council] = await load([dir]);

    expect(council.description).toBeNull();
  });

  it('skips a file that is not valid JSON and warns', async () => {
    const dir = await makeCouncilDir({
      'broken.council.json': '{ not json at all',
      'good.council.json': councilDoc()
    });

    const councils = await load([dir]);

    expect(councils.map(c => c.id)).toEqual(['file:good']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      `Skipping invalid council file ${path.join(dir, 'broken.council.json')}`
    );
    expect(logger.warn.mock.calls[0][0]).toMatch(/not valid JSON/i);
  });

  it('skips a document with an unsupported version and warns', async () => {
    const dir = await makeCouncilDir({
      'future.council.json': councilDoc({ pair_review_council: 2 })
    });

    const councils = await load([dir]);

    expect(councils).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('Unsupported council document version');
  });

  it('skips a JSON file that is not a council document at all', async () => {
    const dir = await makeCouncilDir({ 'settings.json': { theme: 'dark' } });

    const councils = await load([dir]);

    expect(councils).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('missing "pair_review_council" version field');
  });

  it('skips a document with no name and warns', async () => {
    const dir = await makeCouncilDir({
      'nameless.council.json': councilDoc({ name: '   ' })
    });

    const councils = await load([dir]);

    expect(councils).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('missing a "name"');
  });

  it('skips a document whose config fails validation and warns', async () => {
    const dir = await makeCouncilDir({
      'novoices.council.json': councilDoc({ config: { voices: [], levels: { '1': true } } })
    });

    const councils = await load([dir]);

    expect(councils).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('config.voices must be a non-empty array');
  });

  it('skips an advanced document with no levels and warns', async () => {
    const dir = await makeCouncilDir({
      'empty.council.json': councilDoc({ type: 'advanced', config: {} })
    });

    const councils = await load([dir]);

    expect(councils).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('config.levels is required');
  });

  it('ignores files that do not end in .json', async () => {
    const dir = await makeCouncilDir({
      'notes.txt': 'hello',
      'backup.json.bak': JSON.stringify(councilDoc()),
      'README.md': '# councils',
      'real.council.json': councilDoc()
    });

    const councils = await load([dir]);

    expect(councils.map(c => c.id)).toEqual(['file:real']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns an empty array (silently) when the directory does not exist', async () => {
    const councils = await load([path.join(tmpRoot, 'no-such-dir')]);

    expect(councils).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and skips a directory whose readdir fails for a non-ENOENT reason', async () => {
    const good = await makeCouncilDir({ 'ok.council.json': councilDoc() });
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const realFs = require('fs').promises;
    const fakeFs = {
      readdir: vi.fn(async (dir) => {
        if (dir === '/denied') throw denied;
        return realFs.readdir(dir);
      }),
      readFile: (...args) => realFs.readFile(...args)
    };

    const councils = await loadFileCouncils({
      dirs: ['/denied', good],
      _deps: { logger, fs: fakeFs }
    });

    // The failing directory is skipped, the healthy one still loads.
    expect(councils.map(c => c.id)).toEqual(['file:ok']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe(
      'Failed to read councils directory /denied: permission denied'
    );
  });

  it('reads files in alphabetical order', async () => {
    const dir = await makeCouncilDir({
      'charlie.council.json': councilDoc({ name: 'Charlie' }),
      'alpha.council.json': councilDoc({ name: 'Alpha' }),
      'bravo.json': councilDoc({ name: 'Bravo' })
    });

    const councils = await load([dir]);

    expect(councils.map(c => c.id)).toEqual(['file:alpha', 'file:bravo', 'file:charlie']);
  });

  it('derives the same stem from .council.json and .json', async () => {
    const suffixed = await makeCouncilDir({ 'team.council.json': councilDoc() });
    const plain = await makeCouncilDir({ 'team.json': councilDoc() });

    const [fromSuffixed] = await load([suffixed]);
    const [fromPlain] = await load([plain]);

    expect(fromSuffixed.id).toBe('file:team');
    expect(fromPlain.id).toBe('file:team');
  });

  it('keeps the alphabetically first file when two files share a stem', async () => {
    const dir = await makeCouncilDir({
      'team.council.json': councilDoc({ name: 'Suffixed Wins' }),
      'team.json': councilDoc({ name: 'Plain Loses' })
    });

    const councils = await load([dir]);

    expect(councils).toHaveLength(1);
    expect(councils[0].name).toBe('Suffixed Wins');
    expect(councils[0].filePath).toBe(path.join(dir, 'team.council.json'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe(
      `Skipping council file ${path.join(dir, 'team.json')}: another file already defines "file:team"`
    );
  });

  it('keeps the first directory\'s council when a stem repeats across directories', async () => {
    const first = await makeCouncilDir({ 'team.council.json': councilDoc({ name: 'First Dir' }) });
    const second = await makeCouncilDir({ 'team.council.json': councilDoc({ name: 'Second Dir' }) });

    const councils = await load([first, second]);

    expect(councils).toHaveLength(1);
    expect(councils[0].name).toBe('First Dir');
    expect(councils[0].filePath).toBe(path.join(first, 'team.council.json'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('another file already defines "file:team"');
  });

  it('loads councils from every directory given, in order', async () => {
    const first = await makeCouncilDir({ 'one.council.json': councilDoc({ name: 'One' }) });
    const second = await makeCouncilDir({ 'two.council.json': councilDoc({ name: 'Two' }) });

    const councils = await load([first, second]);

    expect(councils.map(c => c.id)).toEqual(['file:one', 'file:two']);
  });

  it('returns an empty array for an empty directory list', async () => {
    expect(await load([])).toEqual([]);
  });

  it('skips a file whose stem would not survive a URL round-trip', async () => {
    const dir = await makeCouncilDir({
      'security & perf.council.json': councilDoc({ name: 'Security And Perf' }),
      'fine.council.json': councilDoc({ name: 'Fine' })
    });

    const councils = await load([dir]);

    expect(councils.map(c => c.id)).toEqual(['file:fine']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe(
      `Skipping council file ${path.join(dir, 'security & perf.council.json')}: ` +
      'filename must be URL-safe and non-empty'
    );
  });

  it('skips a file whose name is nothing but the extension (empty stem)', async () => {
    const bare = await makeCouncilDir({ '.json': councilDoc() });
    const bareSuffixed = await makeCouncilDir({ '.council.json': councilDoc() });

    expect(await load([bare])).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('URL-safe and non-empty');

    logger.warn.mockClear();
    expect(await load([bareSuffixed])).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toContain('URL-safe and non-empty');
  });

  describe('provider registry lookup', () => {
    // A voice-centric council with every level disabled is only legal when all
    // of its voices are executable providers — which the loader can only know by
    // asking the registry. The lookup is injected so the outcome does not depend
    // on whether this process happened to load `src/ai`.
    const allLevelsDisabled = councilDoc({
      name: 'Executable Only',
      config: {
        voices: [{ provider: 'my-script', model: 'default' }],
        levels: { '1': false, '2': false, '3': false }
      }
    });

    it('loads it when the injected lookup reports an executable provider', async () => {
      const dir = await makeCouncilDir({ 'exec.council.json': allLevelsDisabled });

      const councils = await load([dir], {
        getProviderClass: vi.fn(() => class { static isExecutable = true; })
      });

      expect(councils.map(c => c.id)).toEqual(['file:exec']);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('skips it when the lookup does not know the provider', async () => {
      const dir = await makeCouncilDir({ 'exec.council.json': allLevelsDisabled });

      const councils = await load([dir], { getProviderClass: vi.fn(() => undefined) });

      expect(councils).toEqual([]);
      expect(logger.warn.mock.calls[0][0]).toContain(
        'At least one level (1, 2, or 3) must be enabled for non-executable providers'
      );
    });
  });
});
