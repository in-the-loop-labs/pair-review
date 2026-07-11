// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared CouncilCard component
 * (public/js/components/CouncilCard.js) — the council composition preview shared
 * by the repo settings page and the global settings page.
 */

import { describe, it, expect, afterEach } from 'vitest';

const { CouncilCard } = require('../../public/js/components/CouncilCard.js');

// A resolver that makes provider/model ids obvious in the output.
const resolveModelDisplay = (p, m) => ({ providerName: `P:${p}`, modelName: `M:${m}` });

function mount() {
  document.body.innerHTML = '<div id="card"></div>';
  return document.getElementById('card');
}

afterEach(() => { document.body.innerHTML = ''; });

const voiceCouncil = {
  id: 'v1',
  name: 'Speed Council',
  type: 'council',
  config: {
    voices: [
      { provider: 'claude', model: 'sonnet', tier: 'balanced' },
      { provider: 'antigravity', model: 'gemini' }
    ],
    levels: { '1': true, '2': true, '3': false },
    consolidation: { provider: 'claude', model: 'opus', tier: 'thorough' }
  }
};

const advancedCouncil = {
  id: 'a1',
  name: 'Deep Review',
  type: 'advanced',
  config: {
    levels: {
      '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
      '2': { enabled: false, voices: [{ provider: 'x', model: 'y' }] },
      '3': { enabled: true, voices: [{ provider: 'codex', model: 'gpt' }] }
    },
    consolidation: { provider: 'antigravity', model: 'gemini' }
  }
};

describe('CouncilCard.render dispatch', () => {
  it('clears the container for a falsy council', () => {
    const container = mount();
    container.innerHTML = 'stale';
    new CouncilCard({ container, resolveModelDisplay }).render(null);
    expect(container.innerHTML).toBe('');
  });

  it('renders a voice council (name, level summary, reviewers, consolidation)', () => {
    const container = mount();
    new CouncilCard({ container, resolveModelDisplay }).render(voiceCouncil);
    expect(container.querySelector('.council-card-name').textContent).toContain('Speed Council');
    expect(container.querySelector('.council-card-summary').textContent).toBe('Levels 1, 2');
    const reviewers = container.querySelectorAll('.council-card-reviewers > .council-card-reviewer');
    expect(reviewers).toHaveLength(2);
    expect(reviewers[0].textContent).toContain('P:claude / M:sonnet');
    expect(reviewers[0].querySelector('.council-card-tier').textContent).toBe('balanced');
    // Consolidation section present with its own label + reviewer.
    expect(container.querySelector('.council-card-consolidation-label').textContent).toBe('Consolidation');
    expect(container.querySelector('.council-card-consolidation').textContent).toContain('P:claude / M:opus');
  });

  it('renders "No levels configured" when a voice council has no enabled levels', () => {
    const container = mount();
    new CouncilCard({ container, resolveModelDisplay })
      .render({ name: 'None', type: 'council', config: { voices: [], levels: { '1': false } } });
    expect(container.querySelector('.council-card-summary').textContent).toBe('No levels configured');
  });

  it('renders an advanced council with level headers, an Advanced badge, and only enabled levels', () => {
    const container = mount();
    new CouncilCard({ container, resolveModelDisplay }).render(advancedCouncil);
    expect(container.querySelector('.council-card-badge-advanced').textContent).toBe('Advanced');
    const headers = [...container.querySelectorAll('.council-card-level-header')].map(h => h.textContent);
    // Levels 1 and 3 are enabled; level 2 is skipped.
    expect(headers.some(h => /Level 1 — Isolation/.test(h))).toBe(true);
    expect(headers.some(h => /Level 3 — Codebase/.test(h))).toBe(true);
    expect(headers.some(h => /File Context/.test(h))).toBe(false);
    expect(container.textContent).toContain('P:codex / M:gpt');
    // Advanced consolidation is labelled "Orchestration".
    expect(container.querySelector('.council-card-consolidation-label').textContent).toBe('Orchestration');
  });

  it('escapes the council name', () => {
    const container = mount();
    new CouncilCard({ container, resolveModelDisplay })
      .render({ name: '<img src=x>', type: 'council', config: { voices: [], levels: {} } });
    expect(container.innerHTML).not.toContain('<img src=x>');
    expect(container.innerHTML).toContain('&lt;img');
  });

  it('falls back to raw ids when no resolver is provided', () => {
    const container = mount();
    new CouncilCard({ container }).render({
      name: 'Raw', type: 'council',
      config: { voices: [{ provider: 'prov', model: 'mod' }], levels: {} }
    });
    expect(container.textContent).toContain('prov / mod');
  });
});
