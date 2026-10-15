// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createExecutableProviderClass } = require('../../src/ai/executable-provider');

describe('native executable results', () => {
  let directory;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-review-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function providerFor(result, exitCode = 0) {
    const script = `const i = process.argv.indexOf('--output'); const out = i >= 0 ? process.argv[i + 1] : ${JSON.stringify(path.join(directory, 'review.json'))}; require('fs').writeFileSync(out, ${JSON.stringify(JSON.stringify(result))}); process.exit(${exitCode});`;
    const Provider = createExecutableProviderClass('native-test', {
      command: process.execPath, args: ['-e', script, '--'],
      context_args: { result_path: '--output' }, result_file: 'review.json',
      output_glob: 'review.json', output_format: 'pair-review',
    });
    const provider = new Provider();
    provider.mapOutputToSchema = vi.fn(async () => ({ suggestions: [], summary: 'raw fallback' }));
    return provider;
  }

  const result = { summary: '', suggestions: [{
    file: 'src/example.cc', line_start: 8, line_end: 8, old_or_new: 'NEW', type: 'bug',
    severity: 'critical', title: 'Null pointer', description: 'Guard the pointer.',
    suggestion: '', is_file_level: false,
  }] };

  it('passes a new result path and loads native output without model rewriting', async () => {
    const provider = providerFor(result);
    const response = await provider.execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 5000,
    });
    expect(response).toEqual({ success: true, data: result });
    expect(provider.mapOutputToSchema).not.toHaveBeenCalled();
  });

  it('rejects a failed process even when it writes a valid result', async () => {
    const provider = providerFor(result, 2);
    await expect(provider.execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 5000,
    })).rejects.toThrow(/exit|failed/i);
    expect(provider.mapOutputToSchema).not.toHaveBeenCalled();
  });

  it('retains incomplete-stage warnings separately from accepted suggestions', async () => {
    const partial = { ...result, warnings: ['Incident-memory verification did not complete.'] };
    const provider = providerFor(partial);
    const response = await provider.execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 5000,
    });
    expect(response.data).toEqual(partial);
    expect(response.data.summary).toBe('');
    expect(provider.mapOutputToSchema).not.toHaveBeenCalled();
  });

  it('rejects malformed output and never falls back to model extraction', async () => {
    const provider = providerFor({ comments: [{ body: 'raw private output' }] });
    await expect(provider.execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 5000,
    })).rejects.toThrow(/invalid native result/i);
    expect(provider.mapOutputToSchema).not.toHaveBeenCalled();
  });

  it('rejects output filenames outside the private output directory', async () => {
    const Provider = createExecutableProviderClass('invalid', {
      command: process.execPath, args: ['-e', 'process.exit(0)'],
      output_format: 'pair-review', result_file: '../escape.json',
    });
    await expect(new Provider().execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 5000,
    })).rejects.toThrow(/result_file/);
  });
});

describe('native result failures', () => {
  let directory;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-failure-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('rejects a stale result before spawning', async () => {
    await fs.writeFile(path.join(directory, 'review.json'), '{"summary":"stale","suggestions":[]}');
    const Provider = createExecutableProviderClass('stale', {
      command: process.execPath, args: ['-e', 'process.exit(0)'], output_format: 'pair-review'
    });
    await expect(new Provider().execute(null, {
      executableContext: { cwd: directory, outputDir: directory }
    })).rejects.toThrow(/exist|new/i);
  });

  it('discards valid output from a timed-out process', async () => {
    const Provider = createExecutableProviderClass('timeout', {
      command: process.execPath, output_format: 'pair-review',
      context_args: { result_path: '--output' },
      args: ['-e', "require('fs').writeFileSync(process.argv[2], '{\"summary\":\"\",\"suggestions\":[]}'); setInterval(() => {}, 1000);", '--']
    });
    const provider = new Provider();
    provider.mapOutputToSchema = vi.fn();
    await expect(provider.execute(null, {
      executableContext: { cwd: directory, outputDir: directory }, timeout: 100
    })).rejects.toThrow(/failed|timeout/i);
    expect(provider.mapOutputToSchema).not.toHaveBeenCalled();
  });
});
