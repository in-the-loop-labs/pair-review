// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `pair-review council <verb>` (src/councils/cli.js).
 *
 * Everything the command touches outside the database is injected: the editor
 * spawn, the confirmation prompt, stdout/stderr, the temp-dir root, the
 * councils directory, and the id generator. The database half is a real
 * in-memory schema plus the real `CouncilRepository`, and the file overlay is
 * primed through the store's `_resetForTests` — so no test spawns an editor,
 * reads the developer's config dir, or writes outside its own mkdtemp roots.
 *
 * The fake editor is a callback that mutates the file the CLI handed it, which
 * is exactly what a real editor does: it lets a test script "user saved garbage,
 * then fixed it" without any interactive machinery. It also returns the
 * spawnSync RESULT, so a test can script a crashed or killed editor.
 *
 * The `events` log is shared across harnesses within a test: assertions about
 * what happens BEFORE the database opens need the order of the calls, not just
 * their counts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { PassThrough } from 'stream';
import { createTestDatabase } from '../utils/schema.js';

const {
  runCouncilCommand,
  parseCouncilArgs,
  buildTemplateDocument,
  resolveTemplateOrchestration,
  defaultPrompt,
  TEMPLATE_ORCHESTRATION_FALLBACK,
  _emitsDocumentOnStdout,
  COUNCIL_USAGE
} = require('../../src/councils/cli.js');
const { CouncilRepository } = require('../../src/database.js');
const { _resetForTests, FILE_ID_PREFIX } = require('../../src/councils/council-store.js');
const { normalizeAndValidateCouncilConfig } = require('../../src/councils/council-validation.js');
const { getProviderClass, getAllProvidersInfo } = require('../../src/ai/provider.js');
const { findCouncilNameCollision } = require('../../src/councils/resolve-council.js');

const ADVANCED_CONFIG = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet-5-xhigh', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

const VOICE_CONFIG = {
  voices: [{ provider: 'claude', model: 'sonnet-5-xhigh', tier: 'balanced' }],
  levels: { '1': true, '2': true, '3': true }
};

/** A council document that parses and validates, for a fake editor to save. */
const validDocument = (name, extra = {}) => ({
  pair_review_council: 1,
  name,
  type: 'council',
  config: VOICE_CONFIG,
  ...extra
});

/**
 * A file-overlay row shaped like the loader produces.
 */
function fileCouncil(stem, name, overrides = {}) {
  return {
    id: `${FILE_ID_PREFIX}${stem}`,
    name,
    type: 'council',
    config: JSON.parse(JSON.stringify(VOICE_CONFIG)),
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

/**
 * The file the CLI told the editor to open.
 *
 * Production hands `spawnSync` one shell command line — `<editor> <file>` with
 * the file quoted only when it needs it (see `_editorCommand`) — so the target
 * is the trailing argument, unwrapped from POSIX single quotes.
 *
 * Throws rather than returning a relative path: a fake editor is about to WRITE
 * to whatever comes back, and a changed call shape would otherwise have it
 * quietly creating files in the repo root.
 *
 * @param {string} command - The shell command line the CLI built
 * @returns {string} The file path the editor was pointed at
 */
function editorTargetOf(command) {
  const text = String(command);
  const quoted = /'((?:[^']|'\\'')*)'$/.exec(text);
  const target = quoted
    ? quoted[1].replace(/'\\''/g, "'")
    : text.slice(text.lastIndexOf(' ') + 1);
  if (!path.isAbsolute(target)) {
    throw new Error(`Editor command does not end in an absolute file path: ${text}`);
  }
  return target;
}

describe('council CLI', () => {
  let db;
  let repo;
  let tmpRoot;
  let councilsRoot;
  let harness;
  let events;
  // Ids must stay unique ACROSS harness replacements: two councils created in
  // one test with the same uuid means the second INSERT fails, which a test
  // that only checks side effects would never notice.
  let idCounter;

  /**
   * Build the injected dependencies plus the recorders the assertions read.
   *
   * @param {Object} [options]
   * @param {Function} [options.editor] - `(filePath, callCount) => spawnSync result`;
   *   write to `filePath` to simulate the user saving
   * @param {string[]} [options.answers] - Scripted prompt answers, consumed in order
   * @param {Object} [options.env] - Environment seen by the editor lookup
   * @param {Object} [options.config] - Effective config the opener hands back
   *   (what `defaultOpenDatabase` resolves in production); omitted entirely when
   *   not given, which is how an opener that predates the field behaves
   * @param {Object} [options.fs] - Overrides merged over the real fs/promises
   */
  function createMockDeps({ editor, answers = [], env = {}, config, fs: fsOverrides } = {}) {
    const logs = [];
    const errors = [];
    const prompts = [];
    const spawnCalls = [];
    const pendingAnswers = [...answers];

    return {
      logs,
      errors,
      prompts,
      spawnCalls,
      deps: {
        openDatabase: async () => {
          events.push('openDatabase');
          return { db, close: () => {}, ...(config ? { config } : {}) };
        },
        ...(fsOverrides ? { fs: { ...fs, ...fsOverrides } } : {}),
        log: (...args) => logs.push(args.join(' ')),
        error: (...args) => errors.push(args.join(' ')),
        prompt: async question => {
          prompts.push(question);
          // An exhausted script is EOF, not a bare Enter: '' means "retry" at
          // the editor prompt, so returning it here would spin forever.
          return pendingAnswers.length ? pendingAnswers.shift() : null;
        },
        spawnSync: (command, args, options) => {
          const filePath = editorTargetOf(command);
          spawnCalls.push({ command, args, options, filePath });
          return editor ? editor(filePath, spawnCalls.length) : { status: 0 };
        },
        env,
        // Never let a test reassign the worker's real console (the production
        // default redirects it) — record the call instead.
        quietStdout: () => { events.push('quietStdout'); },
        tmpdir: () => tmpRoot,
        councilsDir: () => councilsRoot,
        randomUUID: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`
      }
    };
  }

  /** Run the command with the harness's deps and return the exit code. */
  const run = (...argv) => runCouncilCommand(argv, harness.deps);

  /**
   * The scratch directories the CLI left behind under the temp root.
   *
   * Not "is tmpRoot empty": the file-council tests keep their council file
   * there, so the cleanup assertion has to name what it is looking for.
   */
  const scratchDirs = async () =>
    (await fs.readdir(tmpRoot)).filter(entry => entry.startsWith('pair-review-council-'));

  /** Editor callback that writes `content` (string or object) to the file. */
  const writes = content => filePath => {
    fsSync.writeFileSync(
      filePath,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
    return { status: 0 };
  };

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new CouncilRepository(db);
    // Two roots, not one nested in the other: the temp-document tests assert the
    // scratch root is EMPTY afterwards.
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-cli-test-'));
    councilsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-cli-councils-'));
    events = [];
    idCounter = 0;
    _resetForTests([]);
    harness = createMockDeps();
  });

  afterEach(async () => {
    _resetForTests();
    db.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(councilsRoot, { recursive: true, force: true });
  });

  describe('usage', () => {
    it('prints usage on stdout and exits 0 for --help', async () => {
      const code = await run('--help');

      expect(code).toBe(0);
      expect(harness.logs.join('\n')).toContain('pair-review council <command>');
      expect(harness.errors).toEqual([]);
    });

    it('prints usage on stderr and exits 1 when no verb is given', async () => {
      const code = await run();

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain(COUNCIL_USAGE);
    });

    it('exits 1 with usage on an unknown verb', async () => {
      const code = await run('frobnicate');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Unknown council command: frobnicate');
    });

    it('treats an Object.prototype member as an unknown verb, not a handler', async () => {
      for (const verb of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
        harness = createMockDeps();

        const code = await run(verb);

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain(`Unknown council command: ${verb}`);
      }
      // The unknown-verb guard runs before anything is opened.
      expect(events).toEqual([]);
    });

    it('exits 1 on an unknown flag', async () => {
      const code = await run('list', '--wat');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Unknown flag: --wat');
    });

    it('never opens the database for --help', async () => {
      const opened = vi.fn();
      const code = await runCouncilCommand(['--help'], { ...harness.deps, openDatabase: opened });

      expect(code).toBe(0);
      expect(opened).not.toHaveBeenCalled();
    });

    it('reserves stdout only for the verbs that print a document there', () => {
      expect(_emitsDocumentOnStdout('show', ['show', 'x'])).toBe(true);
      expect(_emitsDocumentOnStdout('export', ['export', 'x'])).toBe(true);
      expect(_emitsDocumentOnStdout('export', ['export', 'x', '-'])).toBe(true);
      expect(_emitsDocumentOnStdout('export', ['export', 'x', 'out.json'])).toBe(false);
      expect(_emitsDocumentOnStdout('list', ['list'])).toBe(false);
      expect(_emitsDocumentOnStdout('delete', ['delete', 'x'])).toBe(false);
    });

    it('silences narration BEFORE opening the database for a stdout document', async () => {
      await repo.create({ id: 'c1', name: 'Quiet', config: VOICE_CONFIG, type: 'council' });

      await run('show', 'Quiet');

      // Order, not count: opening the database narrates its schema version on
      // stdout, so a redirect that happens afterwards has already lost.
      expect(events).toEqual(['quietStdout', 'openDatabase']);

      events.length = 0;
      harness = createMockDeps();
      // `list` prints its table with console.log; keep it out of the run output.
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await run('list');
      } finally {
        consoleSpy.mockRestore();
      }

      expect(events).toEqual(['openDatabase']);
    });

    it('reports a database open failure as exit 1, not a crash', async () => {
      const code = await runCouncilCommand(['list'], {
        ...harness.deps,
        openDatabase: async () => { throw new Error('disk on fire'); }
      });

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Failed to open the pair-review database: disk on fire');
    });

    it('closes the database even when the verb fails', async () => {
      const close = vi.fn();
      const code = await runCouncilCommand(
        ['show', 'nope'],
        { ...harness.deps, openDatabase: async () => ({ db, close }) }
      );

      expect(code).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('operand counts', () => {
    it('refuses extra operands before opening the database, and deletes nothing', async () => {
      await repo.create({ id: 'c1', name: 'My Dream Team', config: VOICE_CONFIG, type: 'council' });

      // An unquoted name: the handle would be `My`, which the resolver's
      // fragment tier happily matches — and then deletes.
      const code = await run('delete', 'My', 'Dream', 'Team', '--yes');

      expect(code).toBe(1);
      expect(events).toEqual([]);
      expect(await repo.getById('c1')).not.toBeNull();
      expect(harness.errors.join('\n')).toContain('Too many arguments for `council delete`');
      expect(harness.errors.join('\n')).toContain('Quote names that contain spaces');
    });

    it('refuses extra operands for every verb that reads fewer', async () => {
      const tooMany = [
        ['list', 'extra'],
        ['show', 'a', 'b'],
        ['export', 'a', 'b', 'c'],
        ['rename', 'a', 'b', 'c'],
        ['duplicate', 'a', 'b', 'c'],
        ['new', 'a', 'b'],
        ['edit', 'a', 'b']
      ];

      for (const argv of tooMany) {
        harness = createMockDeps();

        const code = await run(...argv);

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain(`Too many arguments for \`council ${argv[0]}\``);
      }
      expect(events).toEqual([]);
    });

    it('still accepts every verb at its full operand count', async () => {
      await repo.create({ id: 'c1', name: 'Exported', config: VOICE_CONFIG, type: 'council' });

      const code = await run('export', 'Exported', path.join(tmpRoot, 'out.json'));

      expect(code).toBe(0);
    });
  });

  describe('parseCouncilArgs', () => {
    it('collects positionals and flags', () => {
      expect(parseCouncilArgs(['delete', 'abc', '--yes'])).toEqual({
        positionals: ['delete', 'abc'], yes: true, type: null, help: false
      });
      expect(parseCouncilArgs(['new', 'X', '--type', 'advanced']).type).toBe('advanced');
      expect(parseCouncilArgs(['new', 'X', '--type=advanced']).type).toBe('advanced');
      expect(parseCouncilArgs(['delete', 'abc', '-y']).yes).toBe(true);
    });

    it('treats a bare "-" as a positional (the export stdout target)', () => {
      expect(parseCouncilArgs(['export', 'abc', '-']).positionals).toEqual(['export', 'abc', '-']);
    });

    it('treats everything after "--" as a positional', () => {
      expect(parseCouncilArgs(['new', '--', '--weird-name']).positionals)
        .toEqual(['new', '--weird-name']);
    });

    it('throws on --type without a value', () => {
      expect(() => parseCouncilArgs(['new', 'X', '--type'])).toThrow(/--type requires a value/);
      expect(() => parseCouncilArgs(['new', 'X', '--type', '--yes'])).toThrow(/--type requires a value/);
    });
  });

  describe('defaultPrompt', () => {
    /** A stdin substitute that is already at EOF. */
    const endedInput = () => {
      const input = new PassThrough();
      input.end();
      return input;
    };

    /** A stdin substitute carrying exactly `text`, then EOF. */
    const inputCarrying = text => {
      const input = new PassThrough();
      input.write(text);
      input.end();
      return input;
    };

    it('resolves with the typed answer', async () => {
      const input = new PassThrough();
      const pending = defaultPrompt('Delete? [y/N] ', { input, output: new PassThrough() });
      input.write('yes\n');

      expect(await pending).toBe('yes');
    });

    it('resolves null on EOF instead of hanging', async () => {
      // readline emits `close` and NEVER calls the question callback when stdin
      // is closed or piped from an empty source. A promise that only settles
      // from that callback hangs the CLI here (this test would time out).
      expect(await defaultPrompt('Delete? [y/N] ', {
        input: endedInput(),
        output: new PassThrough()
      })).toBeNull();
    });

    it('distinguishes EOF from a bare Enter', async () => {
      // The retry prompt reads these as opposites — '' means "edit again",
      // null means there is nobody to edit again — so they must not collapse.
      const input = new PassThrough();
      const pending = defaultPrompt('Press Enter: ', { input, output: new PassThrough() });
      input.write('\n');

      expect(await pending).toBe('');
    });

    it('resolves null on a stream an earlier prompt already spent', async () => {
      const input = inputCarrying('\n');

      expect(await defaultPrompt('q1: ', { input, output: new PassThrough() })).toBe('');
      // readline never re-emits `close` on a spent stream and never delivers a
      // line to the question callback, so BOTH settle paths are dead here.
      // Without the up-front check this promise never settles — this assertion
      // fails as a TIMEOUT, which is exactly what the CLI used to do.
      expect(await defaultPrompt('q2: ', { input, output: new PassThrough() })).toBeNull();
    });

    it('aborts the editor retry loop at EOF instead of re-opening forever', async () => {
      // The regression this guards: EOF used to arrive as '', which the retry
      // prompt reads as "edit again". A non-interactive `council edit` on a
      // broken file therefore looped, then died silently with EXIT CODE 0 —
      // readline never re-emits `close` on an already-ended stream, so the
      // second prompt never settled and nothing kept the event loop alive. CI
      // read that as a successful repair. Two editor spawns would be the loop.
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      const broken = createMockDeps({ editor: writes('{ broken') });
      const deps = {
        ...broken.deps,
        prompt: question => defaultPrompt(question, {
          input: endedInput(),
          output: new PassThrough()
        })
      };

      const code = await runCouncilCommand(['edit', 'Editable'], deps);

      expect(code).toBe(1);
      expect(broken.spawnCalls).toHaveLength(1);
      expect(broken.errors.join('\n')).toContain('stdin is closed');
      expect((await repo.getById('c1')).config).toEqual(VOICE_CONFIG);
      expect(await scratchDirs()).toEqual([]);
    });

    it('aborts the retry loop when one piped line runs out mid-repair', async () => {
      // `printf '\n' | pair-review council edit Editable`. Prompt #1 gets a bare
      // Enter, which IS a retry, so the editor re-opens and prompt #2 faces a
      // spent stream. That second prompt used to hang — and since better-sqlite3
      // is synchronous and holds no libuv handle, nothing kept the process
      // alive: the loop drained and the command EXITED 0 having repaired
      // nothing, leaking its scratch directory. Two spawns, exit 1, no leak.
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      const broken = createMockDeps({ editor: writes('{ broken') });
      const input = inputCarrying('\n');
      const deps = {
        ...broken.deps,
        prompt: question => defaultPrompt(question, { input, output: new PassThrough() })
      };

      const code = await runCouncilCommand(['edit', 'Editable'], deps);

      expect(code).toBe(1);
      expect(broken.spawnCalls).toHaveLength(2);
      expect(broken.errors.join('\n')).toContain('stdin is closed');
      expect((await repo.getById('c1')).config).toEqual(VOICE_CONFIG);
      expect(await scratchDirs()).toEqual([]);
    });

    it('lets `delete` decline and exit cleanly when stdin is at EOF', async () => {
      await repo.create({ id: 'c1', name: 'Doomed', config: VOICE_CONFIG, type: 'council' });
      const deps = {
        ...harness.deps,
        prompt: question => defaultPrompt(question, {
          input: endedInput(),
          output: new PassThrough()
        })
      };

      const code = await runCouncilCommand(['delete', 'Doomed'], deps);

      expect(code).toBe(0);
      expect(harness.logs.join('\n')).toContain('Cancelled.');
      expect(await repo.getById('c1')).not.toBeNull();
    });
  });

  describe('list', () => {
    it('prints the council table', async () => {
      await repo.create({ id: 'c1', name: 'Listed Council', config: ADVANCED_CONFIG, type: 'advanced' });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const code = await run('list');
        const output = spy.mock.calls.map(c => c.join(' ')).join('\n');

        expect(code).toBe(0);
        expect(output).toContain('HANDLE');
        expect(output).toContain('Listed Council');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('show', () => {
    it('prints a council document for a saved council', async () => {
      await repo.create({ id: 'c1', name: 'Shown Council', config: VOICE_CONFIG, type: 'council' });

      const code = await run('show', 'Shown Council');
      const doc = JSON.parse(harness.logs.join('\n'));

      expect(code).toBe(0);
      expect(doc).toEqual({
        pair_review_council: 1,
        name: 'Shown Council',
        type: 'council',
        config: VOICE_CONFIG
      });
    });

    it('reports an untyped legacy council as advanced', async () => {
      await repo.create({ id: 'c1', name: 'Legacy', config: ADVANCED_CONFIG, type: null });

      const code = await run('show', 'Legacy');

      expect(code).toBe(0);
      expect(JSON.parse(harness.logs.join('\n')).type).toBe('advanced');
    });

    it('includes a file council description', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team', { description: 'From disk' })]);

      const code = await run('show', 'file:dream-team');

      expect(code).toBe(0);
      expect(JSON.parse(harness.logs.join('\n')).description).toBe('From disk');
    });

    it('exits 1 with the resolver error for an unknown handle', async () => {
      const code = await run('show', 'nope');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('No council matches "nope"');
    });

    it('exits 1 when the handle is missing', async () => {
      const code = await run('show');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Missing required argument: <handle>');
    });
  });

  describe('export', () => {
    it('writes the document to a file and prints the path', async () => {
      await repo.create({ id: 'c1', name: 'Exported', config: VOICE_CONFIG, type: 'council' });
      const target = path.join(tmpRoot, 'out.council.json');

      const code = await run('export', 'Exported', target);

      expect(code).toBe(0);
      expect(harness.logs.join('\n')).toContain(target);
      expect(JSON.parse(await fs.readFile(target, 'utf-8')).name).toBe('Exported');
    });

    it('prints to stdout when the target is "-"', async () => {
      await repo.create({ id: 'c1', name: 'Exported', config: VOICE_CONFIG, type: 'council' });

      const code = await run('export', 'Exported', '-');

      expect(code).toBe(0);
      expect(JSON.parse(harness.logs.join('\n')).name).toBe('Exported');
    });

    it('prints to stdout when no target is given', async () => {
      await repo.create({ id: 'c1', name: 'Exported', config: VOICE_CONFIG, type: 'council' });

      const code = await run('export', 'Exported');

      expect(code).toBe(0);
      expect(JSON.parse(harness.logs.join('\n')).pair_review_council).toBe(1);
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      await repo.create({ id: 'c1', name: 'Doomed', config: ADVANCED_CONFIG, type: 'advanced' });
    });

    it('deletes without prompting when --yes is given', async () => {
      const code = await run('delete', 'Doomed', '--yes');

      expect(code).toBe(0);
      expect(harness.prompts).toEqual([]);
      expect(await repo.getById('c1')).toBeNull();
    });

    it('deletes after a "y" confirmation', async () => {
      harness = createMockDeps({ answers: ['y'] });

      const code = await run('delete', 'Doomed');

      expect(code).toBe(0);
      expect(harness.prompts[0]).toContain('Delete council "Doomed"?');
      expect(await repo.getById('c1')).toBeNull();
    });

    it('keeps the council when the confirmation is declined', async () => {
      harness = createMockDeps({ answers: [''] });

      const code = await run('delete', 'Doomed');

      expect(code).toBe(0);
      expect(harness.logs.join('\n')).toContain('Cancelled.');
      expect(await repo.getById('c1')).not.toBeNull();
    });

    it('refuses a file council and points at the file', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team')]);

      const code = await run('delete', 'file:dream-team', '--yes');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain(
        'Council "Dream Team" is defined in /councils/dream-team.council.json'
      );
    });

    it('reports a council deleted while the confirmation was open', async () => {
      // The web UI is a live second writer, and the prompt blocks for as long as
      // the user takes. `CouncilRepository.delete()` returns false here.
      const deps = {
        ...harness.deps,
        prompt: async () => {
          await repo.delete('c1');
          return 'y';
        }
      };

      const code = await runCouncilCommand(['delete', 'Doomed'], deps);

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('no longer exists');
      expect(harness.logs.join('\n')).not.toContain('Deleted council');
    });
  });

  describe('rename', () => {
    beforeEach(async () => {
      await repo.create({ id: 'c1', name: 'Old Name', config: ADVANCED_CONFIG, type: 'advanced' });
    });

    it('renames a saved council', async () => {
      const code = await run('rename', 'Old Name', 'New Name');

      expect(code).toBe(0);
      expect((await repo.getById('c1')).name).toBe('New Name');
    });

    it('refuses a name another council already holds, case-insensitively', async () => {
      await repo.create({ id: 'c2', name: 'Taken', config: ADVANCED_CONFIG, type: 'advanced' });

      const code = await run('rename', 'Old Name', 'taken');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('A council named "Taken" (c2) already answers to "taken"');
      expect((await repo.getById('c1')).name).toBe('Old Name');
    });

    it('allows renaming a council to a different case of its own name', async () => {
      const code = await run('rename', 'c1', 'OLD NAME');

      expect(code).toBe(0);
      expect((await repo.getById('c1')).name).toBe('OLD NAME');
    });

    it('refuses a file council', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team')]);

      const code = await run('rename', 'file:dream-team', 'Anything');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('is defined in /councils/dream-team.council.json');
    });

    it('exits 1 when the new name is missing', async () => {
      const code = await run('rename', 'Old Name');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Missing required argument: <new-name>');
    });

    it('reports a council that vanished before the update landed', async () => {
      // The repository's "row is gone" answer is a `false` return, and nothing
      // else in the CLI can force it deterministically between resolve and write.
      const update = vi.spyOn(CouncilRepository.prototype, 'update').mockResolvedValue(false);
      try {
        const code = await run('rename', 'Old Name', 'New Name');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('no longer exists');
        expect(harness.logs.join('\n')).not.toContain('Renamed council');
      } finally {
        update.mockRestore();
      }
    });
  });

  describe('name collisions', () => {
    // `resolveCouncilHandle` matches the slugified name and a file council's
    // filename stem, not just the literal name — so uniqueness has to be
    // enforced in that same space or `--council <handle>` breaks for both
    // councils at once.
    it('refuses a slug-equivalent name for new, duplicate, and rename', async () => {
      await repo.create({ id: 'c1', name: 'Dream Team', config: VOICE_CONFIG, type: 'council' });
      await repo.create({ id: 'c2', name: 'Other', config: VOICE_CONFIG, type: 'council' });

      for (const argv of [['new', 'dream-team'], ['duplicate', 'Other', 'dream_team'], ['rename', 'Other', 'DREAM  TEAM']]) {
        harness = createMockDeps();

        const code = await run(...argv);

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('A council named "Dream Team" (c1) already answers to');
        expect(harness.spawnCalls).toEqual([]);
      }
      expect((await repo.list()).map(c => c.name).sort()).toEqual(['Dream Team', 'Other']);
    });

    it('refuses a name that collides with a council FILE\'s filename stem', async () => {
      // The stem is a promised handle regardless of the document's own name.
      _resetForTests([fileCouncil('my_security', 'Security Reviewers')]);

      const code = await run('new', 'My Security');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain(
        'A council named "Security Reviewers" (file:my_security) already answers to "My Security"'
      );
      expect(await repo.list()).toEqual([]);
    });

    it('refuses an editor rename into the slug space of a file council', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team')]);
      // Same slug, different literal — the post-edit re-check has to use the
      // same wide rule as the pre-edit one.
      harness = createMockDeps({ editor: writes(validDocument('dream-team')) });

      const code = await run('new', 'Unrelated Name');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('already answers to');
      expect(await repo.list()).toEqual([]);
    });
  });

  // The rule itself, straight from the helper the CLI shares with the resolver.
  // (Its integration with each verb is covered above.)
  describe('findCouncilNameCollision', () => {
    const all = [
      { id: 'c1', name: 'Dream Team' },
      { id: `${FILE_ID_PREFIX}my_security`, name: 'Security Reviewers' }
    ];

    it('matches an exact name, a slug-equivalent name, and a file stem', () => {
      expect(findCouncilNameCollision(all, 'dream team').id).toBe('c1');
      expect(findCouncilNameCollision(all, ' Dream-Team ').id).toBe('c1');
      expect(findCouncilNameCollision(all, 'My.Security').id).toBe(`${FILE_ID_PREFIX}my_security`);
      expect(findCouncilNameCollision(all, 'Security Reviewers').id).toBe(`${FILE_ID_PREFIX}my_security`);
    });

    it('leaves an unrelated name free, and lets a council keep its own', () => {
      expect(findCouncilNameCollision(all, 'Nightmare Team')).toBeNull();
      expect(findCouncilNameCollision(all, 'DREAM TEAM', 'c1')).toBeNull();
      expect(findCouncilNameCollision([], 'Anything')).toBeNull();
      expect(findCouncilNameCollision(undefined, 'Anything')).toBeNull();
    });
  });

  describe('new', () => {
    it('seeds a valid council template, opens it, and saves the result', async () => {
      let seeded = null;
      harness = createMockDeps({
        editor: filePath => {
          seeded = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
          return { status: 0 };
        },
        env: { EDITOR: 'my-editor' }
      });

      const code = await run('new', 'Fresh Council');
      const created = (await repo.list())[0];

      expect(code).toBe(0);
      // No config from the injected opener: the same "nothing configured"
      // resolution the ladder performs for a user with an empty config file.
      expect(seeded).toEqual(
        buildTemplateDocument('Fresh Council', 'council', resolveTemplateOrchestration({}))
      );
      expect(harness.spawnCalls[0].command.startsWith('my-editor ')).toBe(true);
      expect(created.name).toBe('Fresh Council');
      expect(created.type).toBe('council');
      expect(created.config.voices).toHaveLength(1);
      expect(harness.logs.join('\n')).toContain('Created council "Fresh Council"');
    });

    it('seeds the advanced template for --type advanced', async () => {
      let seeded = null;
      harness = createMockDeps({
        editor: filePath => {
          seeded = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
          return { status: 0 };
        }
      });

      const code = await run('new', 'Fresh Advanced', '--type', 'advanced');

      expect(code).toBe(0);
      expect(seeded.type).toBe('advanced');
      expect(seeded.config.levels['1'].voices).toHaveLength(1);
      expect((await repo.list())[0].type).toBe('advanced');
    });

    it('seeds the user\'s own global default provider, model and timeout', async () => {
      // A user whose default provider is Codex must not be handed a Claude
      // council. The config here is what `defaultOpenDatabase` resolves.
      const codex = getAllProvidersInfo().find(p => p.id === 'codex');
      let seeded = null;
      harness = createMockDeps({
        config: { default_provider: 'codex', default_model: codex.defaultModel },
        editor: filePath => {
          seeded = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
          return { status: 0 };
        }
      });

      const code = await run('new', 'Codex Council');

      expect(code).toBe(0);
      expect(seeded.config.voices).toEqual([{
        provider: 'codex',
        model: codex.defaultModel,
        tier: 'balanced',
        timeout: codex.defaultTimeout ?? TEMPLATE_ORCHESTRATION_FALLBACK.timeout
      }]);
      // Consolidation follows the same pair — it used to be hardcoded Claude.
      expect(seeded.config.consolidation).toEqual(seeded.config.voices[0]);
      expect((await repo.list())[0].config.voices[0].provider).toBe('codex');
    });

    it('seeds the advanced template from the global default too', async () => {
      let seeded = null;
      harness = createMockDeps({
        config: { default_provider: 'codex' },
        editor: filePath => {
          seeded = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
          return { status: 0 };
        }
      });

      const code = await run('new', 'Codex Advanced', '--type', 'advanced');

      expect(code).toBe(0);
      const voices = Object.values(seeded.config.levels).flatMap(l => l.voices);
      expect(voices.length).toBeGreaterThan(0);
      expect(voices.every(v => v.provider === 'codex')).toBe(true);
      expect(seeded.config.consolidation.provider).toBe('codex');
    });

    it('rejects an unknown --type before opening an editor', async () => {
      const code = await run('new', 'Bad Type', '--type', 'nonsense');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('--type must be "council" or "advanced"');
      expect(harness.spawnCalls).toEqual([]);
    });

    it('refuses a name that is already taken before opening an editor', async () => {
      await repo.create({ id: 'c1', name: 'Existing', config: ADVANCED_CONFIG, type: 'advanced' });

      const code = await run('new', 'existing');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('already answers to');
      expect(harness.spawnCalls).toEqual([]);
    });

    it('re-opens the editor after an invalid document, then saves the fix', async () => {
      harness = createMockDeps({
        answers: [''],
        editor: (filePath, call) => {
          if (call === 1) return writes('{ not json')(filePath);
          return writes(validDocument('Second Try'))(filePath);
        }
      });

      const code = await run('new', 'First Try');
      const created = (await repo.list())[0];

      expect(code).toBe(0);
      expect(harness.spawnCalls).toHaveLength(2);
      expect(harness.errors.join('\n')).toContain('not valid JSON');
      expect(harness.prompts[0]).toContain('Press Enter to edit again');
      expect(created.name).toBe('Second Try');
    });

    it('re-opens the editor when the config fails validation', async () => {
      harness = createMockDeps({
        answers: ['q'],
        editor: writes({
          pair_review_council: 1,
          name: 'Broken',
          type: 'council',
          config: { voices: [], levels: { '1': true } }
        })
      });

      const code = await run('new', 'Broken');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('config.voices must be a non-empty array');
      expect(await repo.list()).toEqual([]);
    });

    it('aborts without creating anything when the user answers "q"', async () => {
      harness = createMockDeps({ answers: ['q'], editor: writes('nonsense') });

      const code = await run('new', 'Never Saved');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Aborted; no council was created.');
      expect(await repo.list()).toEqual([]);
    });

    it('reopens the authored document when the editor\'s name collides', async () => {
      // The scratch file used to be deleted before the name check ran, so a
      // collision destroyed the document the user had just written. The check
      // now lives inside the retry loop: the user gets the message AND their
      // own text back.
      await repo.create({ id: 'c1', name: 'Taken', config: ADVANCED_CONFIG, type: 'advanced' });
      const reopened = [];
      harness = createMockDeps({
        answers: [''],
        editor: (filePath, call) => {
          reopened.push(fsSync.readFileSync(filePath, 'utf-8'));
          return call === 1
            ? writes(validDocument('Taken'))(filePath)
            : writes(validDocument('Free'))(filePath);
        }
      });

      const code = await run('new', 'Free');

      expect(code).toBe(0);
      expect(harness.errors.join('\n')).toContain('A council named "Taken" (c1) already answers to');
      expect(harness.spawnCalls).toHaveLength(2);
      // The seed was named "Free"; pass 2 opened what the USER wrote, not a
      // fresh template.
      expect(JSON.parse(reopened[0]).name).toBe('Free');
      expect(JSON.parse(reopened[1]).name).toBe('Taken');
      expect((await repo.list()).map(c => c.name).sort()).toEqual(['Free', 'Taken']);
      expect(await scratchDirs()).toEqual([]);
    });

    it('re-checks uniqueness when the editor changed the name', async () => {
      await repo.create({ id: 'c1', name: 'Taken', config: ADVANCED_CONFIG, type: 'advanced' });
      harness = createMockDeps({ editor: writes(validDocument('Taken')) });

      const code = await run('new', 'Not Taken Yet');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('A council named "Taken" (c1) already answers to');
      expect(await repo.list()).toHaveLength(1);
    });

    it('warns that a description cannot be saved, and still creates the council', async () => {
      harness = createMockDeps({
        editor: writes(validDocument('Described', { description: 'Why this council exists' }))
      });

      const code = await run('new', 'Described');

      expect(code).toBe(0);
      expect(harness.errors.join('\n')).toContain('the description for "Described" was dropped');
      expect(harness.errors.join('\n')).toContain('council files');
      expect((await repo.list())[0].name).toBe('Described');
    });

    it('creates the temp document in its own directory and removes it afterwards', async () => {
      let insideEditor = null;
      harness = createMockDeps({
        editor: filePath => {
          // Observed from INSIDE the editor: proves a scratch directory really
          // existed, so the cleanup assertion below cannot pass vacuously.
          insideEditor = { entries: fsSync.readdirSync(tmpRoot), exists: fsSync.existsSync(filePath) };
          return { status: 0 };
        }
      });

      const code = await run('new', 'Tidy Council');

      expect(code).toBe(0);
      expect(insideEditor.entries).toHaveLength(1);
      expect(insideEditor.exists).toBe(true);
      expect(await fs.readdir(tmpRoot)).toEqual([]);
    });

    it('removes the temp directory when the editor cannot be run', async () => {
      let insideEditor = null;
      harness = createMockDeps({
        editor: () => {
          insideEditor = fsSync.readdirSync(tmpRoot);
          return { error: new Error('spawn nope ENOENT') };
        },
        env: { VISUAL: 'nope' }
      });

      const code = await run('new', 'Doomed Editor');

      expect(code).toBe(1);
      expect(insideEditor).toHaveLength(1);
      expect(await fs.readdir(tmpRoot)).toEqual([]);
    });

    it('removes the temp directory when the user aborts', async () => {
      let insideEditor = null;
      harness = createMockDeps({
        answers: ['q'],
        editor: filePath => {
          insideEditor = fsSync.readdirSync(tmpRoot);
          return writes('nonsense')(filePath);
        }
      });

      const code = await run('new', 'Abandoned');

      expect(code).toBe(1);
      expect(insideEditor).toHaveLength(1);
      expect(await fs.readdir(tmpRoot)).toEqual([]);
    });

    it('aborts with a clear message when the editor cannot be run', async () => {
      harness = createMockDeps({
        editor: () => ({ error: new Error('spawn nope ENOENT') }),
        env: { VISUAL: 'nope' }
      });

      const code = await run('new', 'No Editor');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Failed to run editor "nope"');
      expect(harness.prompts).toEqual([]);
      expect(await repo.list()).toEqual([]);
    });

    it('treats a non-zero editor exit as an abort, not a save', async () => {
      // `:cq` out of vim. The starter template is already valid, so without this
      // the untouched template would be created as if the user had saved it.
      harness = createMockDeps({ editor: () => ({ status: 1 }), env: { EDITOR: 'vim' } });

      const code = await run('new', 'Quit With Error');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Editor "vim" exited with status 1');
      expect(harness.errors.join('\n')).toContain('Aborted; no council was created.');
      expect(harness.prompts).toEqual([]);
      expect(await repo.list()).toEqual([]);
    });

    it('treats a killed editor as an abort', async () => {
      harness = createMockDeps({
        editor: () => ({ status: null, signal: 'SIGINT' }),
        env: { EDITOR: 'vim' }
      });

      const code = await run('new', 'Killed Editor');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Editor "vim" was killed by SIGINT');
      expect(await repo.list()).toEqual([]);
    });

    it('runs a multi-word $EDITOR through a shell with the file as its own argument', async () => {
      // `code --wait` as argv[0] is ENOENT; it is a command line, not a binary.
      let opened = null;
      harness = createMockDeps({
        editor: filePath => {
          opened = filePath;
          return writes(validDocument('Multi Word Editor'))(filePath);
        },
        env: { EDITOR: 'code --wait' }
      });

      const code = await run('new', 'Multi Word Editor');

      expect(code).toBe(0);
      expect(harness.spawnCalls[0].command).toBe(`code --wait ${opened}`);
      expect(harness.spawnCalls[0].args).toEqual([]);
      expect(harness.spawnCalls[0].options.shell).toBe(true);
      expect(opened.endsWith('.council.json')).toBe(true);
      expect((await repo.list())[0].name).toBe('Multi Word Editor');
    });

    it('quotes a temp path containing a space and a quote so it arrives intact', async () => {
      const awkwardRoot = path.join(tmpRoot, "wei rd's dir");
      await fs.mkdir(awkwardRoot);
      let opened = null;
      harness = createMockDeps({
        editor: filePath => {
          opened = filePath;
          return writes(validDocument('Awkward Path'))(filePath);
        },
        env: { EDITOR: 'my-editor' }
      });
      harness.deps.tmpdir = () => awkwardRoot;

      const code = await run('new', 'Awkward Path');

      expect(code).toBe(0);
      // The fake editor read the path back out of the command line, wrote to it,
      // and the CLI parsed what it wrote — the round trip is the proof.
      expect(opened.startsWith(awkwardRoot)).toBe(true);
      expect(harness.spawnCalls[0].command).toBe(`my-editor '${opened.replace(/'/g, "'\\''")}'`);
      expect((await repo.list())[0].name).toBe('Awkward Path');
    });

    it('prefers VISUAL over EDITOR, and falls back to vi', async () => {
      harness = createMockDeps({
        editor: writes(validDocument('A')),
        env: { VISUAL: 'visual-ed', EDITOR: 'editor-ed' }
      });
      expect(await run('new', 'A')).toBe(0);
      expect(harness.spawnCalls[0].command.startsWith('visual-ed ')).toBe(true);

      harness = createMockDeps({ editor: writes(validDocument('B')), env: {} });
      expect(await run('new', 'B')).toBe(0);
      expect(harness.spawnCalls[0].command.startsWith('vi ')).toBe(true);

      // Both councils really landed: a shared id would have failed the second
      // insert while the exit codes above stayed 0.
      expect((await repo.list()).map(c => c.name).sort()).toEqual(['A', 'B']);
    });
  });

  describe('edit', () => {
    it('round-trips a saved council through the editor', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      let seeded = null;
      harness = createMockDeps({
        editor: filePath => {
          seeded = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
          return writes({
            pair_review_council: 1,
            name: 'Renamed By Editor',
            type: 'advanced',
            config: ADVANCED_CONFIG
          })(filePath);
        }
      });

      const code = await run('edit', 'Editable');
      const updated = await repo.getById('c1');

      expect(code).toBe(0);
      expect(seeded.name).toBe('Editable');
      expect(seeded.config).toEqual(VOICE_CONFIG);
      expect(updated.name).toBe('Renamed By Editor');
      expect(updated.type).toBe('advanced');
      expect(updated.config).toEqual(ADVANCED_CONFIG);
      expect(await fs.readdir(tmpRoot)).toEqual([]);
    });

    it('refuses an editor rename onto another council and leaves the row alone', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      await repo.create({ id: 'c2', name: 'Taken', config: ADVANCED_CONFIG, type: 'advanced' });
      harness = createMockDeps({ editor: writes(validDocument('Taken')) });

      const code = await run('edit', 'Editable');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('A council named "Taken" (c2) already answers to');
      expect((await repo.getById('c1')).name).toBe('Editable');
    });

    it('reopens the edited document when the new name collides', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      await repo.create({ id: 'c2', name: 'Taken', config: ADVANCED_CONFIG, type: 'advanced' });
      const reopened = [];
      harness = createMockDeps({
        answers: [''],
        editor: (filePath, call) => {
          reopened.push(fsSync.readFileSync(filePath, 'utf-8'));
          return call === 1
            ? writes(validDocument('Taken', { config: ADVANCED_CONFIG, type: 'advanced' }))(filePath)
            : writes(validDocument('Editable Renamed'))(filePath);
        }
      });

      const code = await run('edit', 'Editable');

      expect(code).toBe(0);
      expect(harness.errors.join('\n')).toContain('A council named "Taken" (c2) already answers to');
      // Pass 2 opened the user's rejected edit, not the council's stored document.
      expect(JSON.parse(reopened[1]).name).toBe('Taken');
      expect((await repo.getById('c1')).name).toBe('Editable Renamed');
      expect(await scratchDirs()).toEqual([]);
    });

    it('leaves the council unchanged when the user aborts', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      harness = createMockDeps({ answers: ['q'], editor: writes('broken') });

      const code = await run('edit', 'Editable');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('was not changed');
      expect((await repo.getById('c1')).config).toEqual(VOICE_CONFIG);
    });

    it('treats a non-zero editor exit as an abort and writes nothing', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      harness = createMockDeps({ editor: () => ({ status: 130 }), env: { EDITOR: 'vim' } });

      const code = await run('edit', 'Editable');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Editor "vim" exited with status 130');
      expect(harness.errors.join('\n')).toContain('council "Editable" was not changed');
      expect((await repo.getById('c1')).name).toBe('Editable');
    });

    it('warns that an edited description cannot be saved, and still updates', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      harness = createMockDeps({
        editor: writes(validDocument('Editable', { description: 'Added in the editor' }))
      });

      const code = await run('edit', 'Editable');

      expect(code).toBe(0);
      expect(harness.errors.join('\n')).toContain('the description for "Editable" was dropped');
      expect((await repo.getById('c1')).config).toEqual(VOICE_CONFIG);
    });

    it('reports a council deleted while the editor was open', async () => {
      await repo.create({ id: 'c1', name: 'Editable', config: VOICE_CONFIG, type: 'council' });
      harness = createMockDeps({
        // First pass saves garbage, so the retry prompt gives a deterministic
        // await for the concurrent delete; the second pass saves a valid doc.
        editor: (filePath, call) => (call === 1
          ? writes('{ not json')(filePath)
          : writes(validDocument('Editable'))(filePath))
      });
      const deps = {
        ...harness.deps,
        prompt: async () => {
          await repo.delete('c1');
          return '';
        }
      };

      const code = await runCouncilCommand(['edit', 'Editable'], deps);

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('no longer exists');
      expect(harness.logs.join('\n')).not.toContain('Updated council');
      // Editing cannot bring the row back, so the staged copy is kept rather
      // than cleaned: it is the only copy of what the user just wrote.
      const kept = harness.errors.join('\n').match(/Your edits were kept at (\S+)/);
      expect(kept).not.toBeNull();
      expect(JSON.parse(await fs.readFile(kept[1], 'utf-8')).name).toBe('Editable');
    });

    it('refuses an ambiguous handle instead of silently editing the council file', async () => {
      // A saved council and a council file that share a handle. `_findCouncilFile`
      // would happily match the stem, so the resolver's failure has to be told
      // apart by CODE: only a no-match may fall through to the file, or the user
      // edits the file council without ever choosing it.
      const councilFile = path.join(councilsRoot, 'dream-team.council.json');
      const before = `${JSON.stringify(validDocument('Dream Team'), null, 2)}\n`;
      await fs.writeFile(councilFile, before);
      _resetForTests([fileCouncil('dream-team', 'Dream Team', { filePath: councilFile })]);
      await repo.create({ id: 'c1', name: 'Dream Team', config: VOICE_CONFIG, type: 'council' });
      harness = createMockDeps({ editor: writes(validDocument('Hijacked')) });

      const code = await run('edit', 'dream-team');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('Ambiguous council "dream-team"');
      // Neither the create hint nor an editor: this handle names real councils.
      expect(harness.errors.join('\n')).not.toContain('council new');
      expect(harness.spawnCalls).toEqual([]);
      expect(await fs.readFile(councilFile, 'utf-8')).toBe(before);
      expect((await repo.getById('c1')).name).toBe('Dream Team');
    });

    it('suggests `council new` when the handle does not resolve', async () => {
      const code = await run('edit', 'ghost');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('No council matches "ghost"');
      expect(harness.errors.join('\n')).toContain('pair-review council new <name>');
    });

    describe('file councils', () => {
      let councilFile;

      beforeEach(async () => {
        councilFile = path.join(tmpRoot, 'dream-team.council.json');
        await fs.writeFile(councilFile, JSON.stringify(validDocument('Dream Team'), null, 2));
        _resetForTests([fileCouncil('dream-team', 'Dream Team', { filePath: councilFile })]);
      });

      it('edits a staged copy, writes it back, and never touches the database', async () => {
        let seeded = null;
        harness = createMockDeps({
          editor: filePath => {
            seeded = fsSync.readFileSync(filePath, 'utf-8');
            return writes({
              pair_review_council: 1,
              name: 'Dream Team',
              type: 'council',
              config: { ...VOICE_CONFIG, voices: [{ provider: 'claude', model: 'opus-5-xhigh' }] }
            })(filePath);
          }
        });
        const before = await fs.readFile(councilFile, 'utf-8');

        const code = await run('edit', 'file:dream-team');

        expect(code).toBe(0);
        // The editor is handed a COPY under the scratch root, not the council
        // file — and the copy carries the file's current contents.
        expect(harness.spawnCalls[0].filePath).not.toBe(councilFile);
        expect(harness.spawnCalls[0].filePath.startsWith(tmpRoot)).toBe(true);
        expect(seeded).toBe(before);
        expect(harness.logs.join('\n')).toContain(
          'Valid. Changes take effect the next time pair-review starts.'
        );
        expect(JSON.parse(await fs.readFile(councilFile, 'utf-8')).config.voices[0].model)
          .toBe('opus-5-xhigh');
        expect(await repo.list()).toEqual([]);
        expect(await scratchDirs()).toEqual([]);
      });

      it('writes back the editor\'s exact bytes rather than a re-serialized document', async () => {
        // `parseCouncilDocument` answers with a normalized subset, so
        // re-serializing would reflow the user's formatting and drop the extra
        // key. The file is theirs; validating it must not rewrite it.
        const authored = [
          '{',
          '    "pair_review_council": 1,',
          '    "name": "Dream Team",',
          '    "type": "council",',
          '    "notes": "kept by the format",',
          `    "config": ${JSON.stringify(VOICE_CONFIG)}`,
          '}',
          ''
        ].join('\n');
        harness = createMockDeps({ editor: writes(authored) });

        const code = await run('edit', 'file:dream-team');

        expect(code).toBe(0);
        expect(await fs.readFile(councilFile, 'utf-8')).toBe(authored);
      });

      it('leaves the file untouched when the user gives up on a broken edit', async () => {
        const before = await fs.readFile(councilFile, 'utf-8');
        harness = createMockDeps({
          answers: ['q'],
          editor: writes({ pair_review_council: 1, name: 'Dream Team', type: 'council', config: {} })
        });

        const code = await run('edit', 'file:dream-team');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('config.voices must be a non-empty array');
        expect(harness.errors.join('\n')).toContain(`Aborted; ${councilFile} was not changed.`);
        // The whole point: the invalid document the editor saved never reaches
        // the real file.
        expect(await fs.readFile(councilFile, 'utf-8')).toBe(before);
        expect(await repo.list()).toEqual([]);
        expect(await scratchDirs()).toEqual([]);
      });

      it('leaves the file untouched when the editor exits non-zero or is killed', async () => {
        const before = await fs.readFile(councilFile, 'utf-8');

        for (const result of [{ status: 1 }, { status: null, signal: 'SIGINT' }]) {
          harness = createMockDeps({
            env: { EDITOR: 'vim' },
            editor: filePath => {
              // `:cq` after mangling the buffer — the editor really did save.
              fsSync.writeFileSync(filePath, '{ half-written');
              return result;
            }
          });

          const code = await run('edit', 'file:dream-team');

          expect(code).toBe(1);
          expect(await fs.readFile(councilFile, 'utf-8')).toBe(before);
          expect(await scratchDirs()).toEqual([]);
        }
      });

      it('reports a write-back failure, keeps the original, and keeps the repair', async () => {
        const before = await fs.readFile(councilFile, 'utf-8');
        harness = createMockDeps({
          editor: writes(validDocument('Dream Team')),
          fs: {
            writeFile: async (target, ...rest) => {
              if (target === councilFile) throw new Error('EACCES: permission denied');
              return fs.writeFile(target, ...rest);
            }
          }
        });

        const code = await run('edit', 'file:dream-team');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain(`Could not save your edits to ${councilFile}`);
        expect(harness.errors.join('\n')).toContain('EACCES');
        expect(await fs.readFile(councilFile, 'utf-8')).toBe(before);
        // Editing cannot repair an unwritable file, so the staged copy is NOT
        // cleaned up: it is the only copy of what the user just wrote, and the
        // error has to say where it is.
        const kept = harness.errors.join('\n').match(/Your edits were kept at (\S+)/);
        expect(kept).not.toBeNull();
        expect(JSON.parse(await fs.readFile(kept[1], 'utf-8')).name).toBe('Dream Team');
        expect(await scratchDirs()).toHaveLength(1);
      });
    });

    describe('broken council files', () => {
      // The loader SKIPS a file it cannot parse or validate, so a broken file
      // never becomes a resolvable council — exactly the file that most needs an
      // edit-and-validate session.
      it('opens a copy of a council file the loader refused, and reports it valid once fixed', async () => {
        const brokenFile = path.join(councilsRoot, 'broken.council.json');
        await fs.writeFile(brokenFile, '{ not json at all');
        let seeded = null;
        harness = createMockDeps({
          editor: filePath => {
            seeded = fsSync.readFileSync(filePath, 'utf-8');
            return writes(validDocument('Repaired'))(filePath);
          }
        });

        const code = await run('edit', 'file:broken');

        // A broken file cannot be parsed into a document first, so the staging
        // copy is the raw bytes — which is what makes the session useful: the
        // user opens their own broken JSON and fixes it.
        expect(code).toBe(0);
        expect(harness.spawnCalls[0].filePath).not.toBe(brokenFile);
        expect(path.basename(harness.spawnCalls[0].filePath)).toBe('broken.council.json');
        expect(seeded).toBe('{ not json at all');
        expect(harness.logs.join('\n')).toContain('Valid.');
        // The create hint would be misleading: the council file exists.
        expect(harness.errors.join('\n')).not.toContain('council new');
        expect(JSON.parse(await fs.readFile(brokenFile, 'utf-8')).name).toBe('Repaired');
        expect(await repo.list()).toEqual([]);
      });

      it('accepts a bare stem and the plain .json filename shape', async () => {
        const brokenFile = path.join(councilsRoot, 'legacy.json');
        await fs.writeFile(brokenFile, JSON.stringify({ pair_review_council: 1, name: 'L' }));
        harness = createMockDeps({ editor: writes(validDocument('Legacy Fixed')) });

        const code = await run('edit', 'legacy');

        expect(code).toBe(0);
        expect(path.basename(harness.spawnCalls[0].filePath)).toBe('legacy.json');
        expect(JSON.parse(await fs.readFile(brokenFile, 'utf-8')).name).toBe('Legacy Fixed');
      });

      it('leaves a broken file exactly as it was when the user gives up', async () => {
        // The regression that matters most: abandoning a repair must not damage
        // the file further, and `q` used to leave whatever the editor wrote.
        const brokenFile = path.join(councilsRoot, 'broken.council.json');
        await fs.writeFile(brokenFile, '{ not json at all');
        harness = createMockDeps({
          answers: ['q'],
          editor: writes('{ "even": "worse", ')
        });

        const code = await run('edit', 'file:broken');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain(`Aborted; ${brokenFile} was not changed.`);
        expect(await fs.readFile(brokenFile, 'utf-8')).toBe('{ not json at all');
        expect(await scratchDirs()).toEqual([]);
      });

      it('reports a council file it cannot read, before spawning an editor', async () => {
        const brokenFile = path.join(councilsRoot, 'broken.council.json');
        await fs.writeFile(brokenFile, '{ not json at all');
        harness = createMockDeps({
          fs: {
            readFile: async (target, ...rest) => {
              if (target === brokenFile) throw new Error('EACCES: permission denied');
              return fs.readFile(target, ...rest);
            }
          }
        });

        const code = await run('edit', 'file:broken');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain(`Could not read ${brokenFile}`);
        expect(harness.spawnCalls).toEqual([]);
      });

      it('still errors with the create hint for a stem with no file behind it', async () => {
        const code = await run('edit', 'file:absent');

        expect(code).toBe(1);
        expect(harness.errors.join('\n')).toContain('pair-review council new <name>');
        expect(harness.spawnCalls).toEqual([]);
      });
    });
  });

  describe('duplicate', () => {
    it('copies a file council into an editable saved council', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team')]);

      const code = await run('duplicate', 'file:dream-team', 'My Dream Team');
      const councils = await repo.list();

      expect(code).toBe(0);
      expect(councils).toHaveLength(1);
      expect(councils[0].name).toBe('My Dream Team');
      expect(councils[0].type).toBe('council');
      expect(councils[0].config).toEqual(VOICE_CONFIG);
      expect(harness.logs.join('\n')).toContain('Created council "My Dream Team"');
    });

    it('copies a saved council, defaulting an untyped row to advanced', async () => {
      await repo.create({ id: 'c1', name: 'Legacy', config: ADVANCED_CONFIG, type: null });

      const code = await run('duplicate', 'Legacy', 'Legacy Copy');
      const copy = (await repo.list()).find(c => c.name === 'Legacy Copy');

      expect(code).toBe(0);
      expect(copy.type).toBe('advanced');
    });

    it('refuses a name that is already taken', async () => {
      await repo.create({ id: 'c1', name: 'Original', config: ADVANCED_CONFIG, type: 'advanced' });

      const code = await run('duplicate', 'Original', 'original');

      expect(code).toBe(1);
      expect(harness.errors.join('\n')).toContain('already answers to');
      expect(await repo.list()).toHaveLength(1);
    });

    it('warns that a file council\'s description cannot come along', async () => {
      _resetForTests([fileCouncil('dream-team', 'Dream Team', { description: 'Kept in the file' })]);

      const code = await run('duplicate', 'file:dream-team', 'My Copy');

      expect(code).toBe(0);
      expect(harness.errors.join('\n')).toContain('the description for "My Copy" was dropped');
      expect((await repo.list())[0].name).toBe('My Copy');
    });
  });

  describe('buildTemplateDocument', () => {
    /** Every voice the template seeds, whatever the type's shape. */
    const seededVoices = doc => {
      const voices = doc.config.voices || Object.values(doc.config.levels).flatMap(l => l.voices || []);
      return [...voices, doc.config.consolidation].filter(Boolean);
    };

    it('produces documents that pass the runtime validator', () => {
      for (const type of ['council', 'advanced']) {
        const doc = buildTemplateDocument('Template Check', type);

        expect(doc.pair_review_council).toBe(1);
        expect(doc.name).toBe('Template Check');
        expect(normalizeAndValidateCouncilConfig(doc.config, doc.type).error).toBeNull();
      }
    });

    it('still validates for EVERY registered provider, executable or not', () => {
      // `validateCouncilFormat` only imposes the "at least one level enabled"
      // rule on non-executable providers, and `validateAdvancedFormat` rejects
      // an enabled level with no voices — a template seeded for someone else's
      // default provider has to clear both.
      const providers = getAllProvidersInfo();
      expect(providers.length).toBeGreaterThan(1);

      for (const provider of providers) {
        const orchestration = resolveTemplateOrchestration({ default_provider: provider.id });
        for (const type of ['council', 'advanced']) {
          const doc = buildTemplateDocument('Template Check', type, orchestration);
          const { error } = normalizeAndValidateCouncilConfig(doc.config, doc.type);
          expect(error, `${provider.id}/${type}: ${error}`).toBeNull();
        }
      }
    });

    it('gives every voice AND the consolidation the same pair, tier and timeout', () => {
      // Both config tabs' `_defaultConfig()` seed one pair at tier 'balanced'
      // across reviewers and consolidation alike; `tier` picks the PROMPT set,
      // not a model class, and 'balanced' is also the analyzer's own fallback
      // for both. The CLI template must not invent a different convention.
      const orchestration = { provider: 'codex', model: 'gpt-5.6-sol-high', timeout: 12345 };

      for (const type of ['council', 'advanced']) {
        const voices = seededVoices(buildTemplateDocument('Template Check', type, orchestration));
        expect(voices.length).toBeGreaterThan(0);

        for (const voice of voices) {
          expect(voice).toEqual({ ...orchestration, tier: 'balanced' });
        }
      }
    });

    it('seeds fresh voice objects rather than one shared reference', () => {
      const doc = buildTemplateDocument('Template Check', 'advanced');
      const voices = seededVoices(doc);

      voices[0].model = 'mutated';
      expect(voices.slice(1).every(v => v.model !== 'mutated')).toBe(true);
    });

    it('keeps its registry-less fallback pair real', () => {
      // Only reachable with an EMPTY provider registry, and still the seed for
      // a two-argument call: an id the catalog does not know falls through
      // `_resolveModelConfig` to a raw `--model <string>`, losing the entry's
      // effort-level env and extra_args.
      const catalog = getProviderClass(TEMPLATE_ORCHESTRATION_FALLBACK.provider).getModels();
      const model = catalog.find(m => m.id === TEMPLATE_ORCHESTRATION_FALLBACK.model);

      expect(model, `${TEMPLATE_ORCHESTRATION_FALLBACK.model} is not a canonical model id`).toBeTruthy();
      expect(typeof TEMPLATE_ORCHESTRATION_FALLBACK.timeout).toBe('number');
    });
  });

  describe('resolveTemplateOrchestration', () => {
    /** The provider payload the resolver reads, by id. */
    const providerInfo = id => getAllProvidersInfo().find(p => p.id === id);

    it('follows the configured global default provider, model and timeout', () => {
      const pi = providerInfo('pi');
      expect(pi).toBeTruthy();

      const resolved = resolveTemplateOrchestration({
        default_provider: 'pi',
        default_model: pi.defaultModel
      });

      expect(resolved.provider).toBe('pi');
      expect(resolved.model).toBe(pi.defaultModel);
      // NOT a Claude constant: pi declares its own defaultTimeout.
      expect(resolved.timeout).toBe(pi.defaultTimeout);
      expect(resolved.timeout).not.toBe(TEMPLATE_ORCHESTRATION_FALLBACK.timeout);
    });

    it('ranks the in-app /settings override above the config file', () => {
      const resolved = resolveTemplateOrchestration({
        default_provider: 'claude',
        default_model: 'opus',
        _globalOverrides: { default_provider: 'codex' }
      });

      expect(resolved.provider).toBe('codex');
      // The claude model does not survive the provider switch.
      expect(resolved.model).toBe(providerInfo('codex').defaultModel);
    });

    it('falls back to the legacy provider/model keys, then to claude', () => {
      expect(resolveTemplateOrchestration({ provider: 'codex' }).provider).toBe('codex');
      expect(resolveTemplateOrchestration({}).provider).toBe('claude');
      expect(resolveTemplateOrchestration(undefined).provider).toBe('claude');
    });

    it('canonicalizes an alias, and refuses a model the provider does not offer', () => {
      // `opus` IS a Claude alias; `sonnet` is not an alias at all (the alias
      // hole this template used to write straight through).
      const claudeDefault = providerInfo('claude').defaultModel;

      expect(resolveTemplateOrchestration({ default_model: 'opus' }).model).toBe(claudeDefault);
      expect(resolveTemplateOrchestration({ default_model: 'sonnet' }).model).toBe(claudeDefault);
      expect(getProviderClass('claude').getModels().some(m => m.id === claudeDefault)).toBe(true);
    });

    it('ignores a model that belongs to a different provider', () => {
      const resolved = resolveTemplateOrchestration({
        default_provider: 'codex',
        default_model: 'opus-4.8-xhigh'
      });

      expect(resolved.provider).toBe('codex');
      expect(resolved.model).toBe(providerInfo('codex').defaultModel);
    });

    it('keeps an unknown provider out of the seed', () => {
      // Nothing can be seeded for a provider the registry never heard of: the
      // model `<select>` in the settings UI would offer nothing for it either.
      const resolved = resolveTemplateOrchestration({ default_provider: 'nonesuch-provider' });

      expect(getAllProvidersInfo().some(p => p.id === resolved.provider)).toBe(true);
      expect(resolved.model).toBeTruthy();
    });
  });
});
