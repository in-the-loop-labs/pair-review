// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for MuseProvider
 *
 * These tests focus on static methods, constructor behavior, arg construction,
 * and response parsing without requiring an actual Muse CLI process.
 *
 * All JSONL fixtures below mirror real `muse exec --json` output
 * (Muse Code 0.1.0): every record is an envelope whose discriminator is
 * `payload_type`, with the interesting fields under `payload`.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../../src/utils/logger');

// Spy on child_process.spawn BEFORE the provider is required, so the provider's
// destructured `spawn` reference resolves to the spy. vi.mock does not intercept
// CJS requires of Node built-in modules in vitest (see copilot-provider.test.js).
//
// The provider captures that reference once, at require time, so this spy can
// never be replaced — and `vi.restoreAllMocks()` only restores the property on
// `child_process`, leaving the captured spy holding the previous test's
// implementation and call history. beforeEach therefore re-arms it explicitly:
// call history cleared, implementation back to the real spawn (the ENOENT test
// wants a genuine spawn failure).
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.spyOn(childProcess, 'spawn');

const MuseProvider = require('../../src/ai/muse-provider');

/**
 * Silence the logger and make its output methods assertable.
 *
 * Deliberately NOT `vi.mock('../../src/utils/logger')`: both this file and the
 * provider reach the logger through CommonJS `require`, which resolves via
 * Node's loader and never enters vitest's module graph, so a `vi.mock` factory
 * is silently ignored — the real singleton is what both sides get. Spying on
 * that singleton is the only thing that actually intercepts the calls.
 *
 * `isStreamDebugEnabled`/`setStreamDebugEnabled` stay real so logStreamLine
 * reads the same flag the tests set.
 */
const SPIED_LOG_METHODS = ['info', 'warn', 'error', 'success', 'debug', 'streamDebug', 'section', 'log'];
function spyOnLogger() {
  for (const method of SPIED_LOG_METHODS) {
    vi.spyOn(logger, method).mockImplementation(() => {});
  }
}

/** Build one line of muse JSONL. */
function record(payloadType, payload, extra = {}) {
  return JSON.stringify({ payload_type: payloadType, payload, ...extra });
}

/**
 * The run's terminal record, named after its outcome.
 *
 * `attemptId` is the command UUID of the `muse exec` attempt the outcome
 * belongs to. Real records carry it in all three places attemptIdOf reads;
 * omitting it yields the older shape that names no attempt at all.
 */
function terminalRecord(terminal, text, reason = null, attemptId = null) {
  const payload = { kind: 'run_terminal', terminal, text, reason };
  const extra = {};
  if (attemptId) {
    payload.command_id = attemptId;
    payload.run_stream = { kind: 'run', id: attemptId };
    extra.causation_id = attemptId;
    extra.stream = { kind: 'session', id: 'session-1' };
  }
  return record(`run.terminal.${terminal}`, payload, extra);
}

/**
 * An output delta scoped to one `muse exec` attempt.
 *
 * The top-level `stream` is deliberately the SAME for every attempt: on stdout
 * it is the SESSION stream, so scoping by it would scope to nothing. Only the
 * command UUID distinguishes attempts.
 */
function deltaRecord(text, sequence, attemptId) {
  return record(
    'run.output.delta',
    { text, command_id: attemptId, run_stream: { kind: 'run', id: attemptId } },
    { sequence, causation_id: attemptId, stream: { kind: 'session', id: 'session-1' } }
  );
}

/**
 * Record every prompt directory execute() creates, so a test can assert on the
 * exact path instead of diffing os.tmpdir() (which other forks also write to).
 *
 * The provider calls `fs.mkdtempSync(...)` as a property of the same `fs`
 * module object this file requires, so spying on it intercepts the real call.
 *
 * @returns {string[]} live array of created directories
 */
function trackPromptDirs() {
  const created = [];
  const realMkdtemp = fs.mkdtempSync;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, ...rest) => {
    const dir = realMkdtemp.call(fs, prefix, ...rest);
    created.push(dir);
    return dir;
  });
  return created;
}

/**
 * Minimal stand-in for a spawned muse process: the exact surface execute() and
 * testAvailability() touch.
 *
 * `pid` is only defaulted when the caller omits the key entirely — passing
 * `{ pid: undefined }` really does produce a pidless child, which is what the
 * killChildSafely guard needs. A `pid = 4242` default parameter would silently
 * hand back a live pid instead.
 */
function makeFakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const stdin = new EventEmitter();
  stdin.end = vi.fn();
  child.stdin = stdin;

  child.pid = 'pid' in overrides ? overrides.pid : 4242;
  child.kill = vi.fn(() => true);
  return child;
}

/**
 * Assert execute() created exactly one prompt directory and removed it.
 *
 * The length check is not decoration: `fs.existsSync(undefined)` swallows the
 * error and returns false, so an empty tracking array would satisfy the removal
 * assertion on its own.
 */
function expectPromptDirRemoved(promptDirs) {
  expect(promptDirs).toHaveLength(1);
  expect(fs.existsSync(promptDirs[0])).toBe(false);
}

/** Settle a promise without letting a rejection escape as unhandled. */
function settledError(promise) {
  return promise.then(() => null, (err) => err);
}

describe('MuseProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spyOnLogger();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((...args) => realSpawn.apply(childProcess, args));
    delete process.env.PAIR_REVIEW_MUSE_CMD;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('returns the correct provider name', () => {
      expect(MuseProvider.getProviderName()).toBe('Muse');
    });

    it('returns the correct provider ID', () => {
      expect(MuseProvider.getProviderId()).toBe('muse');
    });

    it('returns muse-spark-1.2-high as the default model', () => {
      expect(MuseProvider.getDefaultModel()).toBe('muse-spark-1.2-high');
    });

    it('returns models with the expected structure', () => {
      const models = MuseProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('tier');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('description');
        expect(['fast', 'balanced', 'thorough']).toContain(model.tier);
      }
    });

    it('gives every model a real cli_model and reasoning effort', () => {
      for (const model of MuseProvider.getModels()) {
        expect(['muse-spark-1.2', 'muse-spark-1.2-contributor']).toContain(model.cli_model);
        expect(model.extra_args[0]).toBe('--reasoning-effort');
        expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'])
          .toContain(model.extra_args[1]);
      }
    });

    it('marks exactly one model as the default and it is not a contributor model', () => {
      const defaults = MuseProvider.getModels().filter(m => m.default === true);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(MuseProvider.getDefaultModel());
      // Reviews carry potentially proprietary source, so the data-sharing tier
      // must never be the silent default even though muse's own CLI default is
      // the contributor model.
      expect(defaults[0].cli_model).toBe('muse-spark-1.2');
    });

    it('warns in the description of every contributor model that Meta may use the content', () => {
      const contributors = MuseProvider.getModels()
        .filter(m => m.cli_model === 'muse-spark-1.2-contributor');
      expect(contributors.length).toBeGreaterThan(0);
      for (const model of contributors) {
        expect(model.description).toMatch(/used by Meta for product improvement/i);
      }
    });

    it('orders the fast tier so the non-contributor model is picked for extraction', () => {
      // getFastTierModel() takes the FIRST fast-tier model; it must not resolve
      // to the data-sharing tier. Adding models must never disturb this order.
      const firstFast = MuseProvider.getModels().find(m => m.tier === 'fast');
      expect(firstFast.cli_model).toBe('muse-spark-1.2');
      expect(new MuseProvider().getFastTierModel()).toBe('muse-spark-1.2-low');
    });

    it('offers a contributor counterpart at every reasoning effort it exposes', () => {
      const models = MuseProvider.getModels();
      const effortOf = (m) => m.extra_args[1];
      const efforts = new Set(models.filter(m => m.cli_model === 'muse-spark-1.2').map(effortOf));
      const contributorEfforts = new Set(
        models.filter(m => m.cli_model === 'muse-spark-1.2-contributor').map(effortOf)
      );

      expect([...efforts].sort()).toEqual(['high', 'low', 'ultra', 'xhigh']);
      expect([...contributorEfforts].sort()).toEqual(['high', 'low', 'ultra', 'xhigh']);
      expect(models).toHaveLength(8);
    });

    it('pairs each contributor variant right after its non-contributor twin', () => {
      // Display order, and the invariant getFastTierModel() depends on: the
      // non-data-sharing model always comes first within a pairing.
      expect(MuseProvider.getModels().map(m => m.id)).toEqual([
        'muse-spark-1.2-ultra',
        'muse-spark-1.2-contributor-ultra',
        'muse-spark-1.2-xhigh',
        'muse-spark-1.2-contributor-xhigh',
        'muse-spark-1.2-high',
        'muse-spark-1.2-contributor-high',
        'muse-spark-1.2-low',
        'muse-spark-1.2-contributor-low'
      ]);
    });

    it('gives the new thorough contributor variants the thorough tier and shares-data badge', () => {
      const byId = Object.fromEntries(MuseProvider.getModels().map(m => [m.id, m]));

      for (const id of ['muse-spark-1.2-contributor-ultra', 'muse-spark-1.2-contributor-xhigh']) {
        expect(byId[id].tier).toBe('thorough');
        expect(byId[id].badge).toBe('Shares Data');
        expect(byId[id].badgeClass).toBe('badge-power');
      }
      expect(byId['muse-spark-1.2-contributor-ultra'].extra_args).toEqual(['--reasoning-effort', 'ultra']);
      expect(byId['muse-spark-1.2-contributor-xhigh'].extra_args).toEqual(['--reasoning-effort', 'xhigh']);
    });

    it('provides real install instructions naming the launcher and muse login', () => {
      const instructions = MuseProvider.getInstallInstructions();
      expect(instructions).toContain('api.meta.ai/muse-launcher.sh');
      expect(instructions).toContain('muse login');
      // Muse is not distributed on npm; never suggest a package name.
      expect(instructions).not.toMatch(/npm install/i);
    });
  });

  describe('constructor', () => {
    it('defaults to the muse command', () => {
      expect(new MuseProvider().museCmd).toBe('muse');
    });

    it('prefers the config command over the default', () => {
      expect(new MuseProvider('muse-spark-1.2-high', { command: '/opt/muse' }).museCmd)
        .toBe('/opt/muse');
    });

    it('prefers PAIR_REVIEW_MUSE_CMD over the config command', () => {
      process.env.PAIR_REVIEW_MUSE_CMD = '/env/muse';
      expect(new MuseProvider('muse-spark-1.2-high', { command: '/opt/muse' }).museCmd)
        .toBe('/env/muse');
    });

    it('does not use shell mode for a single-word command', () => {
      expect(new MuseProvider().useShell).toBe(false);
    });

    it('strips a trailing exec subcommand so neither spawn path builds `exec exec`', () => {
      // The provider supplies `exec` itself on BOTH paths, so a command
      // configured as `muse exec` would spawn `muse exec exec --json …`, which
      // muse rejects. Normalizing in the constructor is what keeps the analysis
      // and extraction paths from disagreeing about whether it is already there.
      const provider = new MuseProvider('muse-spark-1.2-high', { command: 'muse exec' });

      expect(provider.museCmd).toBe('muse');
      expect(provider.baseArgs.filter(a => a === 'exec')).toHaveLength(1);
      expect(provider.buildArgsForModel('muse-spark-1.2-low').filter(a => a === 'exec')).toHaveLength(1);

      const extraction = provider.getExtractionConfig('muse-spark-1.2-low');
      expect(extraction.command).toBe('muse');
      expect(extraction.args.filter(a => a === 'exec')).toHaveLength(1);

      // Nothing is swallowed silently: the user still learns their config is wrong.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('`exec` subcommand'));
    });

    it('stops a stripped command from needlessly going through a shell', () => {
      // `useShell` is derived AFTER stripping, so `muse exec` is single-word
      // again by the time the flag is computed.
      expect(new MuseProvider('muse-spark-1.2-high', { command: 'muse exec' }).useShell).toBe(false);
    });

    it('strips a trailing exec from the environment override too', () => {
      process.env.PAIR_REVIEW_MUSE_CMD = '/opt/muse exec';
      expect(new MuseProvider().museCmd).toBe('/opt/muse');
    });

    it.each([
      ['docker exec container muse'],
      ['kubectl exec -it pod -- muse']
    ])('leaves the container-exec wrapper %s untouched', (command) => {
      // Only a bare TRAILING `exec` is removed. A container-exec invocation can
      // never end with `exec` — the container and the command to run follow it.
      const provider = new MuseProvider('muse-spark-1.2-high', { command });
      expect(provider.museCmd).toBe(command);
      expect(provider.useShell).toBe(true);
    });

    it('does not strip an exec that sits inside a quoted path', () => {
      // A quoted trailing token ends with the quote character, so the pattern
      // cannot reach inside it.
      const provider = new MuseProvider('muse-spark-1.2-high', { command: '"/opt/my exec"' });
      expect(provider.museCmd).toBe('"/opt/my exec"');
      expect(provider.getExtractionConfig('muse-spark-1.2-low').command).toBe('/opt/my exec');
    });

    it('uses shell mode for a multi-word command', () => {
      expect(new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' }).useShell)
        .toBe(true);
    });

    it('builds baseArgs with exec, --json, --model, the safety flag and the reasoning effort', () => {
      expect(new MuseProvider('muse-spark-1.2-high').baseArgs).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--reasoning-effort', 'high'
      ]);
    });

    it('maps each effort variant onto the right cli model', () => {
      expect(new MuseProvider('muse-spark-1.2-ultra').baseArgs)
        .toEqual(['exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--reasoning-effort', 'ultra']);
      expect(new MuseProvider('muse-spark-1.2-contributor-low').baseArgs)
        .toEqual(['exec', '--json', '--model', 'muse-spark-1.2-contributor', '--disable-write', '--reasoning-effort', 'low']);
    });

    it('never bakes a --prompt-file pair into baseArgs', () => {
      // The temp path only exists during a run; execute() appends the pair.
      expect(new MuseProvider().baseArgs).not.toContain('--prompt-file');
    });

    it('does not set command or args (the prompt path is per-run)', () => {
      const provider = new MuseProvider();
      expect(provider.command).toBeUndefined();
      expect(provider.args).toBeUndefined();
    });

    it.each([
      ['muse-spark-1.2'],
      ['muse-spark']
    ])('resolves the alias %s to the high-effort variant', (alias) => {
      expect(new MuseProvider(alias).baseArgs).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--reasoning-effort', 'high'
      ]);
    });

    it('passes --disable-write but no approval or sandbox flags outside yolo mode', () => {
      // `muse exec` already auto-approves tools by policy when run headlessly, so
      // no approval flag is needed. `--approval-mode never` would DENY every tool
      // (no tool runs, no terminal record emitted), so it must never appear.
      // `--disable-write` blocks the write_file tool; shell stays enabled because
      // analysis needs grep/find and the bundled git-diff-lines helper.
      const args = new MuseProvider('muse-spark-1.2-high').baseArgs;
      expect(args).toContain('--disable-write');
      expect(args).not.toContain('--yolo');
      expect(args).not.toContain('--approval-mode');
      expect(args).not.toContain('--sandbox');
      // Disabling shell would break git-diff-lines and Level 3 exploration.
      expect(args).not.toContain('--disable-shell');
    });

    it('passes --yolo instead of --disable-write in yolo mode', () => {
      const args = new MuseProvider('muse-spark-1.2-high', { yolo: true }).baseArgs;
      expect(args).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--yolo', '--reasoning-effort', 'high'
      ]);
      expect(args).not.toContain('--disable-write');
    });

    it('fully locks down the extraction path, which needs no tools', () => {
      // Unlike analysis, extraction only reformats captured text into JSON, so it
      // gets no filesystem and no shell — mirroring Codex's read-only extraction.
      const args = new MuseProvider('muse-spark-1.2-high').buildArgsForModel('muse-spark-1.2-low');
      expect(args).toContain('--disable-write');
      expect(args).toContain('--disable-shell');
    });

    it('omits --model entirely when cli_model is explicitly null', () => {
      const provider = new MuseProvider('custom', {
        models: [{ id: 'custom', tier: 'fast', cli_model: null, extra_args: ['--reasoning-effort', 'minimal'] }]
      });
      // Dropping --model must not drop the safety flag with it.
      expect(provider.baseArgs).toEqual(['exec', '--json', '--disable-write', '--reasoning-effort', 'minimal']);
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('falls back to the model id as cli_model for an unknown model', () => {
      expect(new MuseProvider('some-future-model').baseArgs)
        .toEqual(['exec', '--json', '--model', 'some-future-model', '--disable-write']);
    });

    it('appends provider-level extra_args exactly once', () => {
      // Regression: _resolveModelConfig already merges provider extra_args, so
      // splicing configOverrides.extra_args separately duplicated every flag.
      const provider = new MuseProvider('muse-spark-1.2-high', {
        extra_args: ['--disable-web-tools']
      });
      const occurrences = provider.baseArgs.filter(a => a === '--disable-web-tools');
      expect(occurrences).toHaveLength(1);
      expect(provider.baseArgs).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write',
        '--reasoning-effort', 'high', '--disable-web-tools'
      ]);
    });

    it('merges extra_args from built-in, provider config, and per-model config in order', () => {
      const provider = new MuseProvider('muse-spark-1.2-high', {
        extra_args: ['--provider-flag'],
        models: [{ id: 'muse-spark-1.2-high', tier: 'balanced', extra_args: ['--model-flag'] }]
      });
      expect(provider.baseArgs).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write',
        '--reasoning-effort', 'high', '--provider-flag', '--model-flag'
      ]);
    });

    it('lets a per-model cli_model override the built-in one', () => {
      const provider = new MuseProvider('muse-spark-1.2-high', {
        models: [{ id: 'muse-spark-1.2-high', tier: 'balanced', cli_model: 'muse-spark-1.2-contributor' }]
      });
      expect(provider.baseArgs).toContain('muse-spark-1.2-contributor');
    });

    it('merges env with per-model config winning over provider config', () => {
      const provider = new MuseProvider('muse-spark-1.2-high', {
        env: { SHARED: 'provider', ONLY_PROVIDER: 'yes' },
        models: [{ id: 'muse-spark-1.2-high', tier: 'balanced', env: { SHARED: 'model' } }]
      });
      expect(provider.extraEnv).toEqual({ SHARED: 'model', ONLY_PROVIDER: 'yes' });
    });

    it('defaults extraEnv to an empty object', () => {
      expect(new MuseProvider().extraEnv).toEqual({});
    });
  });

  describe('getAnalysisSpawnConfig', () => {
    it('returns the bare command and args in non-shell mode', () => {
      expect(new MuseProvider('muse-spark-1.2-high').getAnalysisSpawnConfig()).toEqual({
        command: 'muse',
        args: ['exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--reasoning-effort', 'high'],
        useShell: false
      });
    });

    it('appends trailing args last so no configured extra_args can displace the prompt', () => {
      // Both extra_args tiers must be populated: with none configured,
      // `[...baseArgs, ...trailingArgs]` trivially satisfies the invariant even
      // if merged args could land after the pair. These are the args that could
      // realistically be appended too late.
      const provider = new MuseProvider('muse-spark-1.2-high', {
        extra_args: ['--provider-flag', 'pv'],
        models: [{
          id: 'muse-spark-1.2-high',
          tier: 'balanced',
          extra_args: ['--model-flag', 'mv']
        }]
      });
      const { args } = provider.getAnalysisSpawnConfig(['--prompt-file', '/tmp/x/prompt.txt']);

      expect(args.slice(-2)).toEqual(['--prompt-file', '/tmp/x/prompt.txt']);
      // The flags really are present, so the invariant above was under load.
      expect(args).toContain('--provider-flag');
      expect(args).toContain('--model-flag');
      expect(args.indexOf('--provider-flag')).toBeLessThan(args.indexOf('--prompt-file'));
      expect(args.indexOf('--model-flag')).toBeLessThan(args.indexOf('--prompt-file'));
      // ...and only the trailing pair carries the prompt path.
      expect(args.filter(a => a === '--prompt-file')).toHaveLength(1);
    });

    it('accepts a positional prompt as the trailing arg', () => {
      // `muse exec [OPTIONS] [PROMPT]` — used by the permissions verify script,
      // which has no per-run temp file.
      const { args } = new MuseProvider().getAnalysisSpawnConfig(['review this']);
      expect(args[args.length - 1]).toBe('review this');
    });

    it('folds args into the command string in shell mode', () => {
      const result = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .getAnalysisSpawnConfig(['--prompt-file', '/tmp/x/prompt.txt']);
      expect(result.useShell).toBe(true);
      expect(result.args).toEqual([]);
      // quoteShellArgs only quotes args carrying shell-special characters, so a
      // plain path stays bare; the space-bearing case is covered below.
      expect(result.command).toBe(
        'devx muse -- exec --json --model muse-spark-1.2 --disable-write --reasoning-effort high --prompt-file /tmp/x/prompt.txt'
      );
    });

    it('shell-quotes paths containing spaces', () => {
      const { command } = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .getAnalysisSpawnConfig(['--prompt-file', '/tmp/a b/prompt.txt']);
      expect(command).toContain("'/tmp/a b/prompt.txt'");
    });

    it('shell-quotes a positional prompt containing an apostrophe', () => {
      const { command } = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .getAnalysisSpawnConfig(["it's a prompt"]);
      expect(command).toContain("'it'\\''s a prompt'");
    });

    it('does not mutate baseArgs', () => {
      const provider = new MuseProvider();
      const before = [...provider.baseArgs];
      provider.getAnalysisSpawnConfig(['--prompt-file', '/tmp/x']);
      expect(provider.baseArgs).toEqual(before);
    });
  });

  describe('buildArgsForModel', () => {
    it('locks the same model down harder than the analysis path does', () => {
      // Identical model, deliberately different safety posture: analysis keeps
      // shell so the model can run grep/find and git-diff-lines, while
      // extraction only reformats captured text and so gets no tools at all.
      const provider = new MuseProvider('muse-spark-1.2-high');
      expect(provider.baseArgs).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--reasoning-effort', 'high'
      ]);
      expect(provider.buildArgsForModel('muse-spark-1.2-high')).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--disable-shell', '--reasoning-effort', 'high'
      ]);
    });

    it('resolves a different extraction model', () => {
      expect(new MuseProvider('muse-spark-1.2-ultra').buildArgsForModel('muse-spark-1.2-low'))
        .toEqual(['exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--disable-shell', '--reasoning-effort', 'low']);
    });

    it('carries yolo through to extraction', () => {
      expect(new MuseProvider('muse-spark-1.2-high', { yolo: true }).buildArgsForModel('muse-spark-1.2-low'))
        .toContain('--yolo');
    });

    it('never appends a prompt marker', () => {
      const args = new MuseProvider().buildArgsForModel('muse-spark-1.2-low');
      expect(args).not.toContain('--prompt-file');
      expect(args).not.toContain('-');
    });
  });

  describe('getExtractionConfig', () => {
    it('delivers the prompt through --prompt-file, not argv, stdin, or @file', () => {
      // Extraction input is a whole malformed model response: on argv a large
      // one fails the spawn with E2BIG. `muse exec` never reads stdin (exits 2
      // with "missing prompt"), and the helper's promptViaFile mode appends
      // Pi's `@<path>` syntax, which muse would read as literal prompt text.
      const config = new MuseProvider().getExtractionConfig('muse-spark-1.2-low');
      expect(config.promptFileArg).toBe('--prompt-file');
      expect(config.promptViaStdin).toBe(false);
      expect(config.promptViaFile).toBeUndefined();
    });

    it('returns the command and args for non-shell mode', () => {
      const config = new MuseProvider().getExtractionConfig('muse-spark-1.2-low');
      expect(config.command).toBe('muse');
      expect(config.useShell).toBe(false);
      expect(config.args).toEqual([
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--disable-shell', '--reasoning-effort', 'low'
      ]);
    });

    it('splits a multi-word command into argv instead of folding it into a shell string', () => {
      // SECURITY REGRESSION: this used to return a prebuilt command string with
      // useShell: true, back when the prompt was a trailing argv element — Node
      // joined everything UNQUOTED into `/bin/sh -c`, so the multi-KB prompt was
      // re-parsed as shell syntax. The prompt now goes via --prompt-file, but
      // shell mode must STAY off: this spawn is not detached, so a cancel would
      // kill only the shell wrapper and orphan the CLI.
      const config = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .getExtractionConfig('muse-spark-1.2-low');

      expect(config.useShell).toBe(false);
      expect(config.command).toBe('devx');
      expect(config.args).toEqual([
        'muse', '--',
        'exec', '--json', '--model', 'muse-spark-1.2', '--disable-write', '--disable-shell',
        '--reasoning-effort', 'low'
      ]);
      expect(config.promptViaStdin).toBe(false);
      // No element may be a space-joined command line: that is the shape a shell
      // would have to re-parse.
      for (const arg of config.args) {
        expect(arg).not.toContain(' ');
      }
    });

    it('splits a plain multi-word command into a leading command plus argv words', () => {
      const config = new MuseProvider('muse-spark-1.2-high', { command: 'docker exec container muse' })
        .getExtractionConfig('muse-spark-1.2-low');
      expect(config.useShell).toBe(false);
      expect(config.command).toBe('docker');
      expect(config.args.slice(0, 3)).toEqual(['exec', 'container', 'muse']);
      expect(config.args.slice(3, 5)).toEqual(['exec', '--json']);
    });

    it('keeps a quoted path containing spaces as a single argv word', () => {
      // Quote grouping is the one shell nicety splitCommandWords honours, so an
      // installed-app path survives as one word rather than three. The trailing
      // word is deliberately NOT `exec`: the constructor strips that, which
      // would leave `args[0] === 'exec'` true no matter how the split behaved.
      const config = new MuseProvider('muse-spark-1.2-high', {
        command: '"/Applications/My Tools/muse" --workspace-trust'
      }).getExtractionConfig('muse-spark-1.2-low');
      expect(config.command).toBe('/Applications/My Tools/muse');
      expect(config.args[0]).toBe('--workspace-trust');
      expect(config.args[1]).toBe('exec');
      expect(config.args).not.toContain('"/Applications/My');
    });

    it('drops empty quoted words instead of emitting them as argv elements', () => {
      // An empty argv element reaches muse as an empty positional prompt, and a
      // leading one would become spawn('').
      const config = new MuseProvider('muse-spark-1.2-high', { command: 'devx "" muse' })
        .getExtractionConfig('muse-spark-1.2-low');
      expect(config.command).toBe('devx');
      expect(config.args.slice(0, 2)).toEqual(['muse', 'exec']);
      expect(config.args).not.toContain('');
    });

    it.each([
      ['devx "muse --', 'double'],
      ["devx 'muse --", 'single']
    ])('throws a named error for the unterminated %s quote rather than gluing the words together', (command, kind) => {
      const provider = new MuseProvider('muse-spark-1.2-high', { command });
      expect(() => provider.getExtractionConfig('muse-spark-1.2-low'))
        .toThrow(new RegExp(`unterminated ${kind} quote`));
    });

    it('throws rather than spawning an empty command name when only quotes were configured', () => {
      const provider = new MuseProvider('muse-spark-1.2-high', { command: '""' });
      expect(() => provider.getExtractionConfig('muse-spark-1.2-low'))
        .toThrow(/Muse command is empty/);
    });

    it('still spawns a single-word command directly, with no argv prefix', () => {
      const config = new MuseProvider('muse-spark-1.2-high', { command: '/opt/muse' })
        .getExtractionConfig('muse-spark-1.2-low');
      expect(config.command).toBe('/opt/muse');
      expect(config.args[0]).toBe('exec');
    });

    it('surfaces the merged env for the extraction model', () => {
      const config = new MuseProvider('muse-spark-1.2-high', { env: { TOKEN: 'x' } })
        .getExtractionConfig('muse-spark-1.2-low');
      expect(config.env).toEqual({ TOKEN: 'x' });
    });

    it('honours a custom command from the environment', () => {
      process.env.PAIR_REVIEW_MUSE_CMD = '/env/muse';
      expect(new MuseProvider().getExtractionConfig('muse-spark-1.2-low').command).toBe('/env/muse');
    });

    // End to end through the shared helper: config fields alone can't prove the
    // prompt actually leaves argv.
    it('spawns extraction with the prompt in a file and cleans it up afterwards', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const promise = new MuseProvider().extractJSONWithLLM('garbage {"findings": []} garbage');

      const [command, args] = mockSpawn.mock.calls[0];
      expect(command).toBe('muse');
      const flagIndex = args.indexOf('--prompt-file');
      expect(flagIndex).toBeGreaterThan(-1);

      const promptPath = args[flagIndex + 1];
      expect(fs.readFileSync(promptPath, 'utf8')).toContain('Extract the JSON object');
      // The prompt text itself never becomes an argv word — that is the E2BIG fix.
      expect(args.some(a => a.includes('Extract the JSON object'))).toBe(false);
      // Extraction runs on the fast, non-data-sharing model.
      expect(args[args.indexOf('--model') + 1]).toBe('muse-spark-1.2');

      child.stdout.emit('data', Buffer.from('{"findings": []}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { findings: [] } });

      expect(fs.existsSync(promptPath)).toBe(false);
    });
  });

  describe('extractTerminalRecord', () => {
    it('returns null for empty output', () => {
      expect(new MuseProvider().extractTerminalRecord('')).toBeNull();
      expect(new MuseProvider().extractTerminalRecord('   ')).toBeNull();
    });

    it('returns null when no terminal record is present', () => {
      const stdout = [record('run.lifecycle.started', {}), record('run.output.delta', { text: 'hi' })].join('\n');
      expect(new MuseProvider().extractTerminalRecord(stdout)).toBeNull();
    });

    it('finds a completed terminal record', () => {
      const stdout = [record('run.output.delta', { text: 'hi' }), terminalRecord('completed', '{"a":1}')].join('\n');
      expect(new MuseProvider().extractTerminalRecord(stdout))
        .toEqual({ terminal: 'completed', text: '{"a":1}', reason: null, attemptId: null });
    });

    it('finds a failed terminal record via the payload kind, not the payload_type', () => {
      // Muse names the record after its outcome (run.terminal.failed), so
      // matching only run.terminal.completed would silently miss failures.
      const stdout = terminalRecord('failed', '', 'server_error: The model failed to generate a response.');
      expect(new MuseProvider().extractTerminalRecord(stdout)).toEqual({
        terminal: 'failed',
        text: '',
        reason: 'server_error: The model failed to generate a response.',
        attemptId: null
      });
    });

    it('finds a cancelled terminal record', () => {
      expect(new MuseProvider().extractTerminalRecord(terminalRecord('cancelled', '')).terminal)
        .toBe('cancelled');
    });

    it('skips malformed lines', () => {
      const stdout = ['{not json', '', terminalRecord('completed', 'ok')].join('\n');
      expect(new MuseProvider().extractTerminalRecord(stdout).text).toBe('ok');
    });

    it('keeps the last terminal record when more than one is present', () => {
      const stdout = [terminalRecord('failed', '', 'first'), terminalRecord('completed', 'second')].join('\n');
      expect(new MuseProvider().extractTerminalRecord(stdout).text).toBe('second');
    });

    it('reports the attempt the outcome belongs to', () => {
      const record = terminalRecord('completed', 'done', null, 'cmd-uuid-2');
      expect(new MuseProvider().extractTerminalRecord(record).attemptId).toBe('cmd-uuid-2');
    });

    it.each([
      ['run_stream.id', { run_stream: { kind: 'run', id: 'from-run-stream' }, command_id: 'from-command-id' }, { causation_id: 'from-causation' }, 'from-run-stream'],
      ['command_id', { command_id: 'from-command-id' }, { causation_id: 'from-causation' }, 'from-command-id'],
      ['causation_id', {}, { causation_id: 'from-causation' }, 'from-causation']
    ])('falls back to %s when the richer fields are absent', (_label, idFields, extra, expected) => {
      // Belt and braces against a future record that carries only one of the
      // three, so the delta scoping never silently degrades to "no attempt".
      const line = record(
        'run.terminal.completed',
        { kind: 'run_terminal', terminal: 'completed', text: 'done', ...idFields },
        extra
      );
      expect(new MuseProvider().extractTerminalRecord(line).attemptId).toBe(expected);
    });

    it('never reads the session stream as the attempt', () => {
      // On stdout the top-level `stream` is the SESSION stream and is identical
      // for every attempt, so scoping by it would scope to nothing.
      const line = record(
        'run.terminal.completed',
        { kind: 'run_terminal', terminal: 'completed', text: 'done' },
        { stream: { kind: 'session', id: 'session-1' }, sequence: 42 }
      );
      expect(new MuseProvider().extractTerminalRecord(line).attemptId).toBeNull();
    });
  });

  describe('parseMuseResponse', () => {
    it('parses JSON from the terminal record text', () => {
      const stdout = terminalRecord('completed', '{"suggestions":[{"line":1}]}');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(1);
    });

    it('falls back to concatenating output deltas when the terminal text is empty', () => {
      const stdout = [
        record('run.output.delta', { text: '{"suggestions":' }, { sequence: 10 }),
        record('run.output.delta', { text: '[]}' }, { sequence: 11 }),
        terminalRecord('completed', '')
      ].join('\n');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
    });

    it('orders delta fallback text by sequence, not arrival order', () => {
      const stdout = [
        record('run.output.delta', { text: '[]}' }, { sequence: 11 }),
        record('run.output.delta', { text: '{"suggestions":' }, { sequence: 10 })
      ].join('\n');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
    });

    it('never resurrects a superseded attempt when the finishing attempt produced no text', () => {
      // A resumed/retried run is a new `turn.submit` command, so its records
      // carry a new UUID. Reading the terminal record and the deltas with
      // different scoping rules is what let an unscoped concatenation present an
      // EARLIER attempt's review as the answer of the attempt that finished.
      const stdout = [
        deltaRecord('{"suggestions":[{"line":1,"body":"stale"}]}', 10, 'attempt-a'),
        terminalRecord('completed', '', null, 'attempt-b')
      ].join('\n');

      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      // Nothing safe to forward: the run really did produce no answer.
      expect(result.textContent).toBeUndefined();
      expect(result.error).toContain('no assistant text');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('earlier Muse attempts'));
    });

    it('concatenates only the finishing attempt deltas in a multi-attempt transcript', () => {
      const stdout = [
        deltaRecord('{"suggestions":[{"line":1,"body":"stale"}]}', 10, 'attempt-a'),
        deltaRecord('{"suggestions":', 11, 'attempt-b'),
        deltaRecord('[]}', 12, 'attempt-b'),
        terminalRecord('completed', '', null, 'attempt-b')
      ].join('\n');

      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
    });

    it('scopes to the last delta attempt when the transcript ends before any terminal record', () => {
      // Mirrors "keep the last terminal record" for a run that was cut off.
      const stdout = [
        deltaRecord('{"suggestions":[{"line":1,"body":"stale"}]}', 10, 'attempt-a'),
        deltaRecord('{"suggestions":[]}', 11, 'attempt-b')
      ].join('\n');

      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
    });

    it('treats a transcript that names no attempt at all as one attempt', () => {
      // Older record shapes and hand-written fixtures collapse to a single null
      // scope, i.e. the pre-scoping behaviour, rather than being filtered away.
      const stdout = [
        record('run.output.delta', { text: '{"suggestions":' }, { sequence: 10 }),
        record('run.output.delta', { text: '[]}' }, { sequence: 11 }),
        terminalRecord('completed', '')
      ].join('\n');

      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('earlier Muse attempts'));
    });

    it('prefers the terminal record text over the deltas', () => {
      const stdout = [
        record('run.output.delta', { text: '{"from":"delta"}' }, { sequence: 1 }),
        terminalRecord('completed', '{"from":"terminal"}')
      ].join('\n');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.data).toEqual({ from: 'terminal' });
    });

    it('returns the assistant text as textContent when it is not JSON', () => {
      const stdout = terminalRecord('completed', 'I could not analyse this diff.');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(false);
      // The LLM fallback must receive the assistant text, never the raw JSONL.
      expect(result.textContent).toBe('I could not analyse this diff.');
      expect(result.textContent).not.toContain('payload_type');
    });

    it('extracts JSON wrapped in markdown fences', () => {
      const stdout = terminalRecord('completed', '```json\n{"suggestions":[]}\n```');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ suggestions: [] });
    });

    it('skips malformed JSONL lines while collecting deltas', () => {
      const stdout = [
        '{not json',
        record('run.output.delta', { text: '{"ok":true}' }, { sequence: 1 })
      ].join('\n');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ ok: true });
    });

    it('falls back to extracting JSON from raw stdout when there is no assistant text', () => {
      const result = new MuseProvider().parseMuseResponse('{"suggestions":[]}', 1, '[Level 1]');
      expect(result.success).toBe(true);
    });

    it('reports failure for empty stdout', () => {
      expect(new MuseProvider().parseMuseResponse('', 1, '[Level 1]').success).toBe(false);
    });

    it('never mines muse transport envelopes for a payload when there is no assistant text', () => {
      // Every muse record is itself valid JSON, so handing raw JSONL to the
      // generic extractor would return a lifecycle/terminal frame as though it
      // were the review — turning a failed run into a false success.
      const stdout = [
        record('run.lifecycle.started', { kind: 'run_started', run_id: 'r1' }),
        record('run.model.configured', { model_id: 'muse-spark-1.2' }),
        terminalRecord('failed', '', 'server_error: The model failed to generate a response.')
      ].join('\n');

      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      // A missing textContent is what stops the LLM extraction fallback from
      // being fed the transport frames.
      expect(result.textContent).toBeUndefined();
      expect(result.error).toContain('no assistant text');
      expect(result.error).toContain('failed');
      expect(result.error).toContain('server_error');
    });

    it('reports an empty but successful run as a failure rather than a false success', () => {
      const stdout = [
        record('run.lifecycle.started', { kind: 'run_started' }),
        terminalRecord('completed', '')
      ].join('\n');
      const result = new MuseProvider().parseMuseResponse(stdout, 1, '[Level 1]');
      expect(result.success).toBe(false);
      expect(result.textContent).toBeUndefined();
      expect(result.error).toContain('no assistant text');
    });

    it('still forwards genuinely non-JSONL output to the extraction fallback', () => {
      // The envelope guard must not swallow output from a wrapper that printed
      // plain text: with no envelopes at all, the whole output is model text.
      const result = new MuseProvider().parseMuseResponse('I could not analyse this.', 1, '[Level 1]');
      expect(result.success).toBe(false);
      expect(result.textContent).toBe('I could not analyse this.');
    });
  });

  describe('isAuthError', () => {
    it.each([
      'still unauthorized after a token refresh; run `muse login` again',
      'no login to refresh a key from; run `muse login` or set META_API_KEY',
      'starting logged out (run `muse login`)',
      'HTTP error: 401',
      '401 Unauthorized'
    ])('detects %s', (stderr) => {
      expect(new MuseProvider().isAuthError(stderr)).toBe(true);
    });

    it('does not treat an unrelated failure as an auth error', () => {
      const provider = new MuseProvider();
      expect(provider.isAuthError('server_error: The model failed to generate a response.')).toBe(false);
      expect(provider.isAuthError('')).toBe(false);
      expect(provider.isAuthError(undefined)).toBe(false);
    });
  });

  describe('isUnknownModelError', () => {
    it('detects a model missing from the catalog', () => {
      expect(new MuseProvider().isUnknownModelError('model `nope` is not in the catalog')).toBe(true);
    });

    it('detects a hidden model', () => {
      expect(new MuseProvider().isUnknownModelError('model is hidden in the catalog')).toBe(true);
    });

    it('ignores unrelated errors', () => {
      expect(new MuseProvider().isUnknownModelError('some other failure')).toBe(false);
      expect(new MuseProvider().isUnknownModelError(undefined)).toBe(false);
    });
  });

  describe('createExitError', () => {
    it('produces an actionable message for an auth failure', () => {
      const error = new MuseProvider().createExitError(
        1, 'still unauthorized after a token refresh; run `muse login` again', '[Level 1]'
      );
      expect(error.message).toContain('authentication failed');
      expect(error.message).toContain('muse login');
    });

    it('produces an actionable message for an unknown model', () => {
      const error = new MuseProvider('muse-spark-1.2-high').createExitError(
        1, 'model `totally-not-a-model` is not in the catalog', '[Level 1]'
      );
      expect(error.message).toContain('unknown');
      expect(error.message).toContain('muse-spark-1.2-high');
    });

    it('surfaces the terminal reason when stderr is unhelpful', () => {
      // On failure muse's stderr says only "run ended with Failed"; the real
      // reason exists nowhere but the JSONL terminal record.
      const error = new MuseProvider().createExitError(
        1, 'run ended with Failed', '[Level 1]', 'server_error: The model failed to generate a response.'
      );
      expect(error.message).toContain('server_error: The model failed to generate a response.');
    });

    it('classifies an auth failure reported only in the terminal reason', () => {
      const error = new MuseProvider().createExitError(
        1, 'run ended with Failed', '[Level 1]', 'still unauthorized after a token refresh; run `muse login` again'
      );
      expect(error.message).toContain('authentication failed');
    });

    it('includes the exit code for a generic failure', () => {
      const error = new MuseProvider().createExitError(3, 'something broke', '[Level 1]');
      expect(error.message).toContain('exited with code 3');
      expect(error.message).toContain('something broke');
    });

    it('handles empty stderr without producing a dangling message', () => {
      expect(new MuseProvider().createExitError(1, '', '[Level 1]').message)
        .toContain('(no error output)');
    });
  });

  describe('logStreamLine', () => {
    afterEach(() => {
      logger.setStreamDebugEnabled(false);
    });

    it('logs the terminal record at info level even without stream debug', () => {
      logger.setStreamDebugEnabled(false);
      new MuseProvider().logStreamLine(terminalRecord('completed', 'done'), 1, '[Level 1]');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('run.terminal'));
    });

    it('states that Muse reports no token usage', () => {
      // Muse emits no usage anywhere; counts must never be fabricated.
      new MuseProvider().logStreamLine(terminalRecord('completed', 'done'), 1, '[Level 1]');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('tokens not reported'));
    });

    it('includes the failure reason in the terminal log line', () => {
      new MuseProvider().logStreamLine(terminalRecord('failed', '', 'server_error'), 1, '[Level 1]');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('server_error'));
    });

    it('stays silent for non-terminal records when stream debug is off', () => {
      logger.setStreamDebugEnabled(false);
      new MuseProvider().logStreamLine(record('run.output.delta', { text: 'hi' }), 1, '[Level 1]');
      expect(logger.streamDebug).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs output deltas when stream debug is on', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(record('run.output.delta', { text: 'thinking' }), 2, '[Level 1]');
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('output.delta'));
    });

    it('logs a side_effect_intent with its policy decision', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('task.lifecycle.side_effect_intent', {
          event: { operation: 'tool:read_file', policy_decision: 'allow:policy' }
        }), 3, '[Level 1]'
      );
      expect(logger.streamDebug).toHaveBeenCalledWith(
        expect.stringContaining('tool:read_file')
      );
      expect(logger.streamDebug).toHaveBeenCalledWith(
        expect.stringContaining('allow:policy')
      );
    });

    it('marks a skip_if_running rejection as benign and never as an error', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('task.lifecycle.rejected', { event: { reason: 'skip_if_running' } }), 4, '[Level 1]'
      );
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('benign'));
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns on a rejection whose reason is not the benign skip_if_running', () => {
      // Only `skip_if_running` (an internal reminder-task reminder) is benign.
      // Every other reason is a real tool/policy rejection and must be visible
      // rather than buried under the "benign" label.
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('task.lifecycle.rejected', { event: { reason: 'policy_denied' } }), 4, '[Level 1]'
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('task.rejected'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('policy_denied'));
      expect(logger.streamDebug).not.toHaveBeenCalledWith(expect.stringContaining('benign'));
    });

    it('reports an unknown rejection reason rather than silently dropping it', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('task.lifecycle.rejected', { event: {} }), 5, '[Level 1]'
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    });

    it('does not escalate a background task failure', () => {
      // A reminder-plugin task can fail while the run as a whole succeeds; only
      // the exit code and terminal record are authoritative.
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('task.lifecycle.failed', { event: { reason: 'provider does not support base instructions' } }),
        5, '[Level 1]'
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs the configured model', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('run.model.configured', { model_id: 'muse-spark-1.2', display_label: 'muse-spark-1.2' }),
        6, '[Level 1]'
      );
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('muse-spark-1.2'));
    });

    it('logs a tool result with its outcome', () => {
      logger.setStreamDebugEnabled(true);
      new MuseProvider().logStreamLine(
        record('tool.result', {
          call_id: 'call_0123456789abcdef',
          text: 'Read text file `sample.js`.',
          correlation_facts: { tool_name: 'read_file', outcome: 'success' }
        }), 7, '[Level 1]'
      );
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('read_file'));
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('success'));
    });

    it('does not throw on malformed JSON', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => new MuseProvider().logStreamLine('{not json', 8, '[Level 1]')).not.toThrow();
      expect(logger.streamDebug).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    });

    it('does not throw on a record with no payload_type', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => new MuseProvider().logStreamLine('{"payload":{}}', 9, '[Level 1]')).not.toThrow();
    });
  });

  describe('testAvailability', () => {
    // Load-bearing contract: this probe gates provider selection, so it must
    // RESOLVE on every failure mode. A rejection here would surface as an
    // unhandled failure in the availability sweep rather than "not installed".

    it('resolves true when the version probe exits 0', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider().testAvailability(10000);

      const [command, args, options] = mockSpawn.mock.lastCall;
      expect(command).toBe('muse');
      expect(args).toEqual(['--version']);
      expect(options.shell).toBe(false);

      child.stdout.emit('data', 'muse 0.1.0\n');
      child.emit('close', 0);
      await expect(promise).resolves.toBe(true);
    });

    it('probes a multi-word command through a shell', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .testAvailability(10000);

      const [command, args, options] = mockSpawn.mock.lastCall;
      expect(command).toBe('devx muse -- --version');
      expect(args).toEqual([]);
      expect(options.shell).toBe(true);

      child.emit('close', 0);
      await expect(promise).resolves.toBe(true);
    });

    it('applies the merged provider env to the probe', async () => {
      // A setup whose muse only runs with `providers.muse.env` (or per-model
      // env) set would otherwise be reported unavailable while the real
      // invocation works fine.
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider('muse-spark-1.2-high', {
        env: { META_API_KEY: 'provider-key' },
        models: [{ id: 'muse-spark-1.2-high', tier: 'balanced', env: { MUSE_ENDPOINT: 'internal' } }]
      }).testAvailability(10000);

      const [, , options] = mockSpawn.mock.lastCall;
      expect(options.env.META_API_KEY).toBe('provider-key');
      expect(options.env.MUSE_ENDPOINT).toBe('internal');
      // The bin dir still has to lead PATH for the bundled helpers.
      expect(options.env.PATH.startsWith(path.join(__dirname, '..', '..', 'bin'))).toBe(true);

      child.emit('close', 0);
      await expect(promise).resolves.toBe(true);
    });

    it('resolves false, rather than rejecting, on a non-zero exit', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider().testAvailability(10000);
      child.stderr.emit('data', 'unrecognized option --version\n');
      child.emit('close', 2);

      await expect(promise).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exit code 2'));
    });

    it('resolves false, rather than rejecting, when the spawn itself fails', async () => {
      const child = makeFakeChild({ pid: undefined });
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider().testAvailability(10000);
      const spawnError = new Error('spawn muse ENOENT');
      spawnError.code = 'ENOENT';
      child.emit('error', spawnError);

      await expect(promise).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('spawn muse ENOENT'));
    });

    it('kills the child and resolves false when the probe exceeds timeoutMs', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      // Fake timers must be released in `finally`: a failing assertion would
      // otherwise leak them into every later test in this file.
      vi.useFakeTimers();
      try {
        const promise = new MuseProvider().testAvailability(5000);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(promise).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('signals nothing on timeout when a failed spawn left the child pidless', async () => {
      // Node coerces an undefined pid to 0, and kill(0, SIGTERM) signals OUR own
      // process group — pair-review would terminate itself. Uses the default
      // 10s timeout, so that parameter is exercised too.
      const child = makeFakeChild({ pid: undefined });
      mockSpawn.mockReturnValue(child);

      vi.useFakeTimers();
      try {
        const promise = new MuseProvider().testAvailability();
        await vi.advanceTimersByTimeAsync(10000);
        await expect(promise).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }

      expect(child.kill).not.toHaveBeenCalled();
    });

    it('ignores a close that arrives after the timeout already resolved', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      vi.useFakeTimers();
      try {
        const promise = new MuseProvider().testAvailability(5000);
        await vi.advanceTimersByTimeAsync(5000);
        // The killed child reports its exit afterwards; the settled guard must
        // absorb it rather than settling twice.
        child.emit('close', 0);
        await expect(promise).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }

      // The promise itself cannot catch a missing guard (a second resolve is a
      // no-op), but the log can: without it, a timed-out probe would announce
      // the CLI as available.
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Muse CLI available'));
    });
  });

  describe('execute', () => {
    it('resolves the parsed payload, passes --prompt-file last, and removes the prompt dir', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider('muse-spark-1.2-high')
        .execute('analyse this diff', { level: 1, timeout: 300000 });

      expect(promptDirs).toHaveLength(1);
      const promptFile = path.join(promptDirs[0], 'prompt.txt');
      expect(fs.readFileSync(promptFile, 'utf8')).toBe('analyse this diff');

      const [, spawnArgs] = mockSpawn.mock.lastCall;
      expect(spawnArgs.slice(-2)).toEqual(['--prompt-file', promptFile]);

      child.stdout.emit('data', terminalRecord('completed', '{"suggestions":[{"line":1}]}') + '\n');
      child.emit('close', 0);

      await expect(promise).resolves.toEqual({ suggestions: [{ line: 1 }] });
      expectPromptDirRemoved(promptDirs);
    });

    it('rejects with the terminal reason and removes the prompt dir on a non-zero exit', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const promise = new MuseProvider('muse-spark-1.2-high').execute('prompt', { level: 1, timeout: 300000 });

      // muse's stderr only says the run failed; the reason lives in the JSONL.
      child.stderr.emit('data', 'run ended with Failed\n');
      child.stdout.emit('data',
        terminalRecord('failed', '', 'server_error: The model failed to generate a response.') + '\n');
      child.emit('close', 1);

      const error = await settledError(promise);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('exited with code 1');
      expect(error.message).toContain('server_error: The model failed to generate a response.');
      expectPromptDirRemoved(promptDirs);
    });

    it('kills the child, rejects, and removes the prompt dir when the run times out', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      vi.useFakeTimers();
      try {
        const promise = new MuseProvider('muse-spark-1.2-high').execute('prompt', { level: 1, timeout: 1000 });
        // Attach the rejection handler BEFORE advancing, so the rejection is
        // never momentarily unhandled.
        const failure = settledError(promise);
        await vi.advanceTimersByTimeAsync(1000);

        const error = await failure;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/Muse CLI timed out after 1000ms/);
      } finally {
        vi.useRealTimers();
      }

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expectPromptDirRemoved(promptDirs);
    });

    it('reports install instructions and cleans up the temp file when the CLI is missing', async () => {
      const promptDirs = trackPromptDirs();
      // Deliberately a real spawn: this exercises Node's own ENOENT path.
      const provider = new MuseProvider('muse-spark-1.2-high', {
        command: '/nonexistent/definitely-not-muse'
      });

      const error = await settledError(provider.execute('prompt', { level: 1, timeout: 10000 }));
      expect(error.message).toMatch(/Muse CLI not found/);
      // A plain failure, NOT a cancellation — the abort test below relies on
      // these two being distinguishable.
      expect(error.name).toBe('Error');
      expect(error.isCancellation).toBeUndefined();

      // The prompt file must be removed on every exit path, including spawn errors.
      expectPromptDirRemoved(promptDirs);
    });

    it('rejects a pre-aborted run before writing a prompt or spawning anything', async () => {
      // The early return sits ahead of mkdtempSync, so it cannot leak a temp dir
      // — there is nothing yet to clean up. Asserting that NO directory was
      // created is what pins that ordering: moved below the write, this would
      // leak a directory with no child process around to remove it.
      //
      // The error identity matters too. This test used to spawn
      // '/nonexistent/definitely-not-muse', so ENOENT rejected it before abort
      // semantics settled anything and a bare `.rejects.toThrow()` passed either
      // way — deleting the pre-aborted branch entirely would have kept it green.
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const error = await settledError(
        new MuseProvider('muse-spark-1.2-high').execute('prompt', {
          level: 1,
          timeout: 300000,
          abortSignal: AbortSignal.abort()
        })
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('AbortError');
      expect(error.isCancellation).toBe(true);
      expect(error.message).toMatch(/Cancelled by user/);
      expect(error.message).not.toMatch(/not found/);
      // No prompt written, no process spawned, nothing to SIGTERM.
      expect(promptDirs).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('removes the temp directory when the prompt write fails after mkdtemp succeeded', async () => {
      // mkdtempSync creates the directory first, so a failing writeFileSync
      // (ENOSPC/EACCES/EIO/quota) used to leak an empty directory with no child
      // process around to clean it up.
      const promptDirs = trackPromptDirs();
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        const err = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      });

      const error = await settledError(
        new MuseProvider('muse-spark-1.2-high').execute('prompt', { level: 1, timeout: 300000 })
      );

      expect(error.message).toMatch(/Failed to write Muse prompt file/);
      expect(error.message).toContain('no space left on device');
      expect(mockSpawn).not.toHaveBeenCalled();
      expectPromptDirRemoved(promptDirs);
    });

    it('reports failure instead of returning transport envelopes when muse emits no assistant text', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const provider = new MuseProvider('muse-spark-1.2-high');
      const llmFallback = vi.spyOn(provider, 'extractJSONWithLLM');

      const promise = provider.execute('prompt', { level: 1, timeout: 300000 });
      const stdout = [
        record('run.lifecycle.started', { kind: 'run_started', run_id: 'r1' }),
        record('run.model.configured', { model_id: 'muse-spark-1.2' }),
        terminalRecord('completed', '')
      ].join('\n') + '\n';
      child.stdout.emit('data', stdout);
      child.emit('close', 0);

      const result = await promise;
      expect(result.parsed).toBe(false);
      expect(result.raw).toBe(stdout);
      // None of muse's own envelope fields may masquerade as review findings.
      expect(result.suggestions).toBeUndefined();
      expect(result.payload).toBeUndefined();
      expect(result.payload_type).toBeUndefined();
      expect(result.kind).toBeUndefined();
      // The envelopes must not reach the extraction fallback either.
      expect(llmFallback).not.toHaveBeenCalled();
      expectPromptDirRemoved(promptDirs);
    });

    /**
     * Drive execute() to the LLM-extraction fallback: muse exits 0 having
     * emitted assistant text that is not JSON.
     *
     * @param {Object} child - Fake child returned by the spawn spy
     * @param {string} [text='I could not analyse this diff.'] - Assistant text
     */
    function reachExtractionFallback(child, text = 'I could not analyse this diff.') {
      child.stdout.emit('data', terminalRecord('completed', text) + '\n');
      child.emit('close', 0);
    }

    it('forwards the abort signal so the extraction spawn can be killed, not merely abandoned', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const provider = new MuseProvider('muse-spark-1.2-high');
      const llmFallback = vi.spyOn(provider, 'extractJSONWithLLM')
        .mockResolvedValue({ success: true, data: { suggestions: [] } });
      const controller = new AbortController();

      const promise = provider.execute('prompt', {
        level: 1,
        timeout: 300000,
        analysisId: 'analysis-1',
        abortSignal: controller.signal
      });
      reachExtractionFallback(child);

      await expect(promise).resolves.toEqual({ suggestions: [] });
      expect(llmFallback).toHaveBeenCalledWith(
        'I could not analyse this diff.',
        expect.objectContaining({ abortSignal: controller.signal })
      );
      expectPromptDirRemoved(promptDirs);
    });

    it('reports a cancel that lands while the extraction fallback is still running', async () => {
      // By this point the muse child has already exited, so the abort wiring
      // only kills something already dead. Without the post-await re-check a
      // cancelled analysis would settle with a normal result.
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const provider = new MuseProvider('muse-spark-1.2-high');
      const controller = new AbortController();
      vi.spyOn(provider, 'extractJSONWithLLM').mockImplementation(async () => {
        controller.abort();
        return { success: true, data: { suggestions: [{ line: 1 }] } };
      });

      const promise = provider.execute('prompt', {
        level: 1,
        timeout: 300000,
        abortSignal: controller.signal
      });
      const failure = settledError(promise);
      reachExtractionFallback(child);

      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('AbortError');
      expect(error.isCancellation).toBe(true);
      expect(error.message).toMatch(/Cancelled by user/);
      expectPromptDirRemoved(promptDirs);
    });

    it('treats an abort that kills the extraction spawn as a cancel, not a parse failure', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const provider = new MuseProvider('muse-spark-1.2-high');
      const controller = new AbortController();
      vi.spyOn(provider, 'extractJSONWithLLM').mockImplementation(async () => {
        controller.abort();
        throw new Error('spawn terminated by SIGTERM');
      });

      const promise = provider.execute('prompt', {
        level: 1,
        timeout: 300000,
        abortSignal: controller.signal
      });
      const failure = settledError(promise);
      reachExtractionFallback(child);

      const error = await failure;
      expect(error.name).toBe('AbortError');
      expect(error.isCancellation).toBe(true);
      expectPromptDirRemoved(promptDirs);
    });

    it('degrades to raw text when the extraction fallback throws without a cancel', async () => {
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const provider = new MuseProvider('muse-spark-1.2-high');
      vi.spyOn(provider, 'extractJSONWithLLM').mockRejectedValue(new Error('extraction CLI blew up'));

      const promise = provider.execute('prompt', { level: 1, timeout: 300000 });
      reachExtractionFallback(child);

      // Never the raw JSONL: only the assistant text the model actually wrote.
      await expect(promise).resolves.toEqual({
        raw: 'I could not analyse this diff.',
        parsed: false
      });
      expectPromptDirRemoved(promptDirs);
    });
  });

  // execute() passes `shell: this.useShell` to both wireAbortToChild and the
  // timeout killChildSafely. Every other execute() test builds the provider with
  // the default single-word `muse`, so useShell is false and
  // `expect(child.kill).toHaveBeenCalledWith('SIGTERM')` would pass VACUOUSLY in
  // shell mode — where the real CLI is the shell's grandchild and child.kill is
  // never reached. These pin the group-kill path so a dropped or inverted flag
  // cannot silently leak the CLI behind its wrapper.
  describe('execute in shell mode', () => {
    let origPlatform;
    let origKill;

    beforeEach(() => {
      origPlatform = process.platform;
      origKill = process.kill;
      // The POSIX branch is the one under test; Windows taskkill is covered in
      // tests/unit/abort-signal-wiring.test.js.
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.kill = origKill;
    });

    it('group-kills the whole shell process group when the run times out', async () => {
      const groupKill = vi.fn();
      process.kill = groupKill;
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const provider = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' });
      expect(provider.useShell).toBe(true);

      vi.useFakeTimers();
      try {
        const promise = provider.execute('prompt', { level: 1, timeout: 1000 });
        const failure = settledError(promise);

        // Detached at spawn time, or there is no process group to signal and
        // process.kill(-pid) would fail with ESRCH.
        const [, , options] = mockSpawn.mock.lastCall;
        expect(options.shell).toBe(true);
        expect(options.detached).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);
        const error = await failure;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/Muse CLI timed out after 1000ms/);
      } finally {
        vi.useRealTimers();
      }

      expect(groupKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      // Killing only the wrapper would leave the real CLI running and burning
      // tokens after this promise has already rejected.
      expect(child.kill).not.toHaveBeenCalled();
      expectPromptDirRemoved(promptDirs);
    });

    it('group-kills the whole shell process group when an abort arrives mid-run', async () => {
      const groupKill = vi.fn();
      process.kill = groupKill;
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      // Deliberately NOT a pre-aborted signal: execute() returns before spawning
      // for that, so no kill of any kind would be dispatched.
      const controller = new AbortController();
      const promise = new MuseProvider('muse-spark-1.2-high', { command: 'devx muse --' })
        .execute('prompt', { level: 1, timeout: 300000, abortSignal: controller.signal });
      const failure = settledError(promise);

      controller.abort();

      expect(groupKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('close', 143);
      const error = await failure;
      expect(error.name).toBe('AbortError');
      expect(error.isCancellation).toBe(true);
      expectPromptDirRemoved(promptDirs);
    });

    it('signals only the child, never a process group, for a single-word command', async () => {
      // The counterpart that makes the two assertions above non-vacuous: an
      // inverted flag would show up here as a group-kill of a child that was
      // never detached.
      const groupKill = vi.fn();
      process.kill = groupKill;
      const promptDirs = trackPromptDirs();
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const controller = new AbortController();
      const promise = new MuseProvider('muse-spark-1.2-high')
        .execute('prompt', { level: 1, timeout: 300000, abortSignal: controller.signal });
      const failure = settledError(promise);

      const [, , options] = mockSpawn.mock.lastCall;
      expect(options.shell).toBe(false);
      expect(options.detached).toBe(false);

      controller.abort();

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(groupKill).not.toHaveBeenCalled();

      child.emit('close', 143);
      expect((await failure).name).toBe('AbortError');
      expectPromptDirRemoved(promptDirs);
    });
  });

  describe('provider registration', () => {
    it('registers itself under the muse id on import', () => {
      const { getProviderClass, getRegisteredProviderIds } = require('../../src/ai/provider');
      expect(getRegisteredProviderIds()).toContain('muse');
      expect(getProviderClass('muse')).toBe(MuseProvider);
    });

    it('exports the class directly rather than under a named key', () => {
      expect(typeof MuseProvider).toBe('function');
      expect(MuseProvider.name).toBe('MuseProvider');
    });
  });
});
