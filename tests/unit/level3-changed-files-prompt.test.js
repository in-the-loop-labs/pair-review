// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Analyzer = require('../../src/ai/analyzer');
const promptIndex = require('../../src/ai/prompts/index');
const {
  formatValidFiles,
  formatLevel3ChangedFilesSection,
  level3ChangedFilesSection
} = require('../../src/ai/prompts/shared/valid-files');

const TIERS = ['fast', 'balanced', 'thorough'];
const RESTRICTION = /ONLY (?:create suggestions|suggest) for files in this list|Do NOT create suggestions for (?:any )?files not in this list/;
const PERMISSION = 'You may also create suggestions for files that are not in this list';

const prMetadata = {
  title: 'Change the API',
  description: 'Changes a function signature',
  base_sha: 'base',
  head_sha: 'head',
  base_branch: 'main',
  head_branch: 'feature'
};

describe('Level 3 changed files section', () => {
  it('lists the changed files and allows findings in other repository files', () => {
    const section = formatLevel3ChangedFilesSection(['src/api.js', 'src/utils.js']);

    expect(section).toContain('## Changed Files');
    expect(section).toContain('- src/api.js\n- src/utils.js');
    expect(section).toContain(PERMISSION);
    expect(section).toContain('Use the real path of a file that exists in the repository, relative to the repository root.');
    expect(section).toContain('"old_or_new": "NEW"');
    expect(section).not.toMatch(RESTRICTION);
  });

  it('keeps file names containing replacement patterns literal', () => {
    const section = formatLevel3ChangedFilesSection(['src/$&.js', "src/$'.js"]);
    expect(section).toContain("- src/$&.js\n- src/$'.js");
  });

  it('shows a placeholder when no files are given', () => {
    expect(formatLevel3ChangedFilesSection([])).toContain('(No files specified)');
    expect(formatLevel3ChangedFilesSection(null)).toContain('(No files specified)');
  });

  it('does not change the Level 1/2 file list format', () => {
    expect(formatValidFiles(['a.js', 'b.js'])).toBe('- a.js\n- b.js');
    expect(formatValidFiles([])).toBe('(No files specified)');
  });

  for (const tier of TIERS) {
    it(`level3/${tier} embeds the shared section text exactly`, async () => {
      const baseline = await import(`../../src/ai/prompts/baseline/level3/${tier}.js`);
      const section = baseline.parseSections().find(s => s.name === 'changed-files');
      expect(section.locked).toBe(true);
      expect(section.content.trim()).toBe(level3ChangedFilesSection.content);
    });

    it(`level3/${tier} built prompt has no changed-files-only restriction`, () => {
      const prompt = promptIndex.getPromptBuilder('level3', tier).build({ changedFiles: formatValidFiles(['src/api.js']) });
      expect(prompt).toContain('These files are changed in this review:\n- src/api.js');
      expect(prompt).toContain(PERMISSION);
      expect(prompt).not.toMatch(RESTRICTION);
    });

    for (const level of ['level1', 'level2']) {
      it(`${level}/${tier} keeps the changed-files-only restriction`, async () => {
        const baseline = await import(`../../src/ai/prompts/baseline/${level}/${tier}.js`);
        expect(baseline.taggedPrompt).toMatch(RESTRICTION);
        expect(baseline.taggedPrompt).not.toContain(PERMISSION);
      });
    }
  }
});

describe('Analyzer Level 3 prompt file scope', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer(null, 'sonnet', 'claude');
    vi.spyOn(analyzer, 'buildSparseCheckoutGuidanceSection').mockResolvedValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const tier of TIERS) {
    it(`buildLevel3Prompt (${tier}) lists changed files without restricting findings to them`, async () => {
      const prompt = await analyzer.buildLevel3Prompt(1, '/repo', prMetadata, null, [], null, ['src/api.js', 'src/utils.js'], tier);

      expect(prompt).toContain('These files are changed in this review:\n- src/api.js\n- src/utils.js');
      expect(prompt).toContain(PERMISSION);
      expect(prompt).not.toMatch(RESTRICTION);
    });
  }

  it('buildLevel3ChangedFilesSection (legacy Level 3 prompt) allows findings outside the changed files', () => {
    const section = analyzer.buildLevel3ChangedFilesSection(['src/api.js']);
    expect(section).toContain('These files are changed in this review:\n- src/api.js');
    expect(section).toContain(PERMISSION);
    expect(section).not.toMatch(RESTRICTION);
  });

  it('buildLevel3ChangedFilesSection is empty without changed files', () => {
    expect(analyzer.buildLevel3ChangedFilesSection([])).toBe('');
    expect(analyzer.buildLevel3ChangedFilesSection(null)).toBe('');
  });

  for (const tier of TIERS) {
    it(`buildLevel2Prompt (${tier}) still restricts findings to changed files`, () => {
      const prompt = analyzer.buildLevel2Prompt(1, '/repo', prMetadata, [], null, ['src/api.js'], tier);
      expect(prompt).toContain('- src/api.js');
      expect(prompt).toMatch(RESTRICTION);
      expect(prompt).not.toContain(PERMISSION);
    });
  }

  it('the legacy Level 2 changed files section still restricts findings', () => {
    const section = analyzer.buildChangedFilesSection(['src/api.js']);
    expect(section).toContain('Do NOT create suggestions for any files not in this list');
  });
});
