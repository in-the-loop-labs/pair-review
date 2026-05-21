// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  buildTourPrompt,
  TOUR_PROMPT_MIN_STOPS,
  TOUR_PERSIST_MIN_STOPS,
  TOUR_MAX_STOPS,
  TOUR_TITLE_MAX,
  TOUR_DESCRIPTION_MAX
} = require('../../src/ai/prompts/tour.js');

const SCRIPT = 'git-diff-lines --cwd "/x"';

describe('buildTourPrompt input validation', () => {
  it('throws TypeError when scriptCommand is missing', () => {
    expect(() => buildTourPrompt({ changedFiles: ['a.js'] })).toThrow(TypeError);
  });

  it('throws TypeError when scriptCommand is empty/whitespace', () => {
    expect(() => buildTourPrompt({ scriptCommand: '   ', changedFiles: ['a.js'] })).toThrow(TypeError);
  });

  it('throws TypeError when changedFiles is missing', () => {
    expect(() => buildTourPrompt({ scriptCommand: 'git-diff-lines' })).toThrow(TypeError);
  });

  it('throws TypeError when changedFiles is not an array', () => {
    expect(() => buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: 'not-an-array'
    })).toThrow(TypeError);
  });
});

describe('buildTourPrompt output', () => {
  it('returns a non-empty string for minimal valid args', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('lists changed files in a section', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['src/a.js', 'src/b.js']
    });
    expect(out).toContain('Changed files in this diff:');
    expect(out).toContain('- src/a.js');
    expect(out).toContain('- src/b.js');
  });

  it('shows (none) placeholder when changedFiles is empty', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: []
    });
    expect(out).toContain('Changed files in this diff:');
    expect(out).toContain('(none)');
  });

  it('embeds the line-number guidance script command verbatim', () => {
    const out = buildTourPrompt({ scriptCommand: SCRIPT, changedFiles: ['a.js'] });
    expect(out).toContain(SCRIPT);
  });

  it('does not reference per-hunk summary hints (tour is decoupled from summaries)', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['a.js']
    });
    expect(out).not.toContain('Per-hunk hints');
    expect(out).not.toMatch(/summaries are hints/i);
    expect(out).not.toMatch(/use to plan exploration/i);
  });

  it('ignores any extra summariesByFile field passed in (decoupled — no error, no inclusion)', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['src/a.js'],
      summariesByFile: [
        { filePath: 'src/a.js', summaries: [{ summary: 'Adds helper.' }] }
      ]
    });
    expect(out).not.toContain('Adds helper.');
    expect(out).not.toContain('Per-hunk hints');
  });

  it('omits author-intent section when both prTitle and prDescription are empty/whitespace', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['a.js'],
      prTitle: '   ',
      prDescription: ''
    });
    expect(out).not.toContain("Author's stated intent");
  });

  it('includes prTitle when only title is provided', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['a.js'],
      prTitle: 'Refactor X'
    });
    expect(out).toContain("Author's stated intent");
    expect(out).toContain('Title: Refactor X');
    expect(out).not.toContain('Description:');
  });

  it('includes both prTitle and prDescription when provided', () => {
    const out = buildTourPrompt({
      scriptCommand: 'git-diff-lines',
      changedFiles: ['a.js'],
      prTitle: 'Refactor X',
      prDescription: 'Cleans up X module'
    });
    expect(out).toContain("Author's stated intent");
    expect(out).toContain('Title: Refactor X');
    expect(out).toContain('Description: Cleans up X module');
  });

  it('does NOT instruct the model to emit context stops (gap-expansion not yet supported)', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    // The is_context field has been removed from the schema until the
    // frontend renderer can expand collapsed/unrendered gaps.
    expect(out).not.toContain('is_context');
    // Replacement guidance — stops must intersect changed lines.
    expect(out).toMatch(/MUST point at lines that actually changed/);
  });

  it('mentions both LEFT and RIGHT for side semantics', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).toContain('LEFT');
    expect(out).toContain('RIGHT');
  });
});

describe('exported constants', () => {
  it('exposes the documented constants', () => {
    expect(TOUR_PROMPT_MIN_STOPS).toBe(1);
    expect(TOUR_PERSIST_MIN_STOPS).toBe(2);
    expect(TOUR_MAX_STOPS).toBe(12);
    expect(TOUR_TITLE_MAX).toBe(60);
    expect(TOUR_DESCRIPTION_MAX).toBe(280);
  });
});

describe('buildTourPrompt prompt copy', () => {
  it('frames the tour around accelerated reviewer understanding', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).toMatch(/accelerated understanding/);
    expect(out).toMatch(/Audience: a reviewer/);
    expect(out).toMatch(/NOT a changelog/);
  });

  it('does not pad-prompt the model with a hard MIN floor', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    // The old "3-10" / "3 <= stops.length" framing is gone.
    expect(out).not.toMatch(/3\s*[-–]\s*10/);
    expect(out).not.toMatch(/3 <= stops\.length/);
    // MAX bound remains visible.
    expect(out).toContain('12');
  });

  it('warns the model that stops must not overlap', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).toMatch(/Stops must not overlap/);
  });

  it('does not mention is_context anywhere (field removed from schema)', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).not.toMatch(/is_context/);
  });

  it('requires stops to live in the changed-files list', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).toMatch(/MUST be in one of the files above/);
    expect(out).toMatch(/will be rejected/);
  });

  it('keeps the final-output rules trimmed to JSON-only and validation', () => {
    const out = buildTourPrompt({ scriptCommand: 'git-diff-lines', changedFiles: ['a.js'] });
    expect(out).toContain('Final output rules');
    expect(out).toMatch(/JSON only/);
    expect(out).toMatch(/Validate every range against file bounds/);
  });
});
