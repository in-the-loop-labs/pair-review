// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the Global Settings page (public/js/settings.js).
 *
 * These import the actual SettingsPage class from production code and exercise
 * its pure rendering / value-extraction logic without running init() (no
 * network). Instances are built via Object.create so the constructor's
 * data-loading side effects never fire.
 */

import { describe, it, expect, vi } from 'vitest';

const { SettingsPage, SOURCE_DISPLAY, PROVIDER_KEYS, CHAT_PROVIDER_KEYS } = require('../../public/js/settings.js');

/**
 * Build a SettingsPage instance without invoking the constructor/init.
 * @param {Array} providers - provider definitions used by provider selects
 */
function createPage(providers = []) {
  const page = Object.create(SettingsPage.prototype);
  page.providers = providers;
  page.chatProviders = [];
  page.settingsByKey = {};
  page._seq = {};
  return page;
}

/** Minimal fetch Response stand-in with an async json() body. */
function makeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function baseSetting(overrides = {}) {
  return {
    key: 'summaries.enabled',
    label: 'Enable summaries',
    description: 'Generate PR summaries.',
    group: 'summaries',
    type: 'boolean',
    values: undefined,
    default: false,
    editable: true,
    restartRequired: false,
    sensitive: false,
    value: false,
    source: 'default',
    overrideValue: undefined,
    ...overrides
  };
}

describe('SOURCE_DISPLAY map', () => {
  it('maps every API source enum to a label + class', () => {
    const expected = ['app', 'env', 'project.local', 'project', 'config.local', 'config', 'managed', 'default'];
    for (const src of expected) {
      expect(SOURCE_DISPLAY[src]).toBeTruthy();
      expect(typeof SOURCE_DISPLAY[src].label).toBe('string');
      expect(typeof SOURCE_DISPLAY[src].cls).toBe('string');
    }
  });

  it('renders default as the muted "not set" badge and app as in-app', () => {
    expect(SOURCE_DISPLAY.default).toEqual({ label: 'default', cls: 'default' });
    expect(SOURCE_DISPLAY.app).toEqual({ label: 'in-app', cls: 'app' });
  });
});

describe('PROVIDER_KEYS', () => {
  it('includes the analysis-provider-valued string settings', () => {
    expect(PROVIDER_KEYS.has('default_provider')).toBe(true);
    expect(PROVIDER_KEYS.has('tours.provider')).toBe(true);
    expect(PROVIDER_KEYS.has('summaries.provider')).toBe(true);
    expect(PROVIDER_KEYS.has('default_model')).toBe(false);
  });

  it('does NOT include chat_provider — chat is a separate provider namespace', () => {
    expect(PROVIDER_KEYS.has('chat_provider')).toBe(false);
    expect(CHAT_PROVIDER_KEYS.has('chat_provider')).toBe(true);
  });
});

describe('rowInnerHtml — badge, reset, restart note', () => {
  it('default source: muted badge, no reset, no restart note', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({ source: 'default' }));
    expect(html).toContain('source-badge--default');
    expect(html).toContain('>default<');
    // Reset button present in markup but hidden.
    expect(html).toMatch(/data-role="reset"\s+hidden/);
    expect(html).toMatch(/data-role="restart"\s+hidden/);
  });

  it('in-app source on editable setting: shows reset, in-app badge', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({ source: 'app', value: true }));
    expect(html).toContain('source-badge--app');
    expect(html).toContain('>in-app<');
    // Reset visible (no hidden attribute right after data-role="reset").
    expect(html).toMatch(/data-role="reset"(?!\s+hidden)/);
  });

  it('restart-required override shows the persistent restart note', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({
      key: 'dev_mode', group: 'advanced', source: 'app', restartRequired: true, value: true
    }));
    // restart note is NOT hidden when overridden.
    expect(html).toMatch(/data-role="restart"(?!\s+hidden)/);
  });

  it('env source: env badge, no reset (not an in-app override)', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({ source: 'env', value: true }));
    expect(html).toContain('source-badge--env');
    expect(html).toMatch(/data-role="reset"\s+hidden/);
  });
});

describe('controlHtml — control by type', () => {
  it('boolean renders a checkbox reflecting the value', () => {
    const page = createPage();
    expect(page.controlHtml(baseSetting({ value: true }))).toMatch(/type="checkbox"[^>]*checked/);
    expect(page.controlHtml(baseSetting({ value: false }))).not.toContain('checked');
  });

  it('integer renders a number input with the value', () => {
    const page = createPage();
    const html = page.controlHtml(baseSetting({ key: 'summaries.max_files', type: 'integer', value: 50 }));
    expect(html).toContain('type="number"');
    expect(html).toContain('value="50"');
    expect(html).toContain('min="0"');
  });

  it('integer with null value renders an empty field (not "null")', () => {
    const page = createPage();
    const html = page.controlHtml(baseSetting({ type: 'integer', value: null }));
    expect(html).toContain('value=""');
  });

  it('enum renders a select with the matching option selected', () => {
    const page = createPage();
    const html = page.controlHtml(baseSetting({
      key: 'theme', type: 'enum', values: ['light', 'dark'], value: 'dark'
    }));
    expect(html).toContain('<select');
    expect(html).toMatch(/<option value="dark"\s+selected>dark<\/option>/);
    expect(html).toMatch(/<option value="light">light<\/option>/);
  });

  it('string renders a text input with the value and default placeholder', () => {
    const page = createPage();
    const html = page.controlHtml(baseSetting({
      key: 'assisted_by_url', type: 'string', value: 'https://example.com', default: 'https://default'
    }));
    expect(html).toContain('type="text"');
    expect(html).toContain('value="https://example.com"');
    expect(html).toContain('placeholder="https://default"');
  });
});

describe('providerSelectHtml', () => {
  const providers = [
    { id: 'claude', name: 'Claude', models: [{ id: 'opus' }] },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt' }] }
  ];

  it('includes an inherit option when default is empty and selects it', () => {
    const page = createPage(providers);
    const html = page.providerSelectHtml(baseSetting({
      key: 'summaries.provider', type: 'string', default: '', value: ''
    }));
    expect(html).toMatch(/<option value=""\s+selected>Default \(inherit\)<\/option>/);
    expect(html).toContain('>Claude<');
    expect(html).toContain('>Codex<');
  });

  it('omits the inherit option when default is a concrete provider', () => {
    const page = createPage(providers);
    const html = page.providerSelectHtml(baseSetting({
      key: 'default_provider', type: 'string', default: 'claude', value: 'claude'
    }));
    expect(html).not.toContain('Default (inherit)');
    expect(html).toMatch(/<option value="claude"\s+selected>Claude<\/option>/);
  });

  it('preserves a configured-but-unavailable provider as an option', () => {
    const page = createPage(providers);
    const html = page.providerSelectHtml(baseSetting({
      key: 'default_provider', type: 'string', default: 'claude', value: 'ghost'
    }));
    expect(html).toMatch(/<option value="ghost"\s+selected>ghost \(unavailable\)<\/option>/);
  });
});

describe('readonlyValueHtml', () => {
  it('sensitive: shows Configured / Not configured, never the value', () => {
    const page = createPage();
    expect(page.readonlyValueHtml(baseSetting({ sensitive: true, configured: true, value: null })))
      .toContain('Configured');
    const notSet = page.readonlyValueHtml(baseSetting({ sensitive: true, configured: false, value: null }));
    expect(notSet).toContain('Not configured');
  });

  it('object value: shows entry count with correct pluralization', () => {
    const page = createPage();
    expect(page.readonlyValueHtml(baseSetting({ value: { count: 3 } }))).toContain('3 entries');
    expect(page.readonlyValueHtml(baseSetting({ value: { count: 1 } }))).toContain('1 entry');
  });

  it('empty/null value: shows Not set', () => {
    const page = createPage();
    expect(page.readonlyValueHtml(baseSetting({ value: null }))).toContain('Not set');
    expect(page.readonlyValueHtml(baseSetting({ value: '' }))).toContain('Not set');
  });

  it('plain value: shows the value', () => {
    const page = createPage();
    expect(page.readonlyValueHtml(baseSetting({ value: 7247 }))).toContain('7247');
  });
});

describe('readControlValue', () => {
  it('boolean reads checked state', () => {
    const page = createPage();
    expect(page.readControlValue({ checked: true }, baseSetting({ type: 'boolean' }))).toBe(true);
    expect(page.readControlValue({ checked: false }, baseSetting({ type: 'boolean' }))).toBe(false);
  });

  it('integer parses a trimmed number, returns undefined when blank', () => {
    const page = createPage();
    const s = baseSetting({ type: 'integer' });
    expect(page.readControlValue({ value: ' 12 ' }, s)).toBe(12);
    expect(page.readControlValue({ value: '' }, s)).toBeUndefined();
    expect(page.readControlValue({ value: 'abc' }, s)).toBeUndefined();
  });

  it('string/enum returns the raw value (including empty and falsy strings)', () => {
    const page = createPage();
    expect(page.readControlValue({ value: 'dark' }, baseSetting({ type: 'enum' }))).toBe('dark');
    expect(page.readControlValue({ value: '' }, baseSetting({ type: 'string' }))).toBe('');
  });
});

describe('renderRepos', () => {
  it('renders configured + known badges and links', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="repos-list"></div>';
    page.renderRepos([
      { repository: 'a/b', hasDbSettings: true, hasFileConfig: false, localPath: '/x', updatedAt: null },
      { repository: 'c/d', hasDbSettings: false, hasFileConfig: false, localPath: '/y', updatedAt: null }
    ]);
    const html = document.getElementById('repos-list').innerHTML;
    expect(html).toContain('href="/settings/a/b"');
    expect(html).toContain('repo-badge--configured');
    expect(html).toContain('href="/settings/c/d"');
    expect(html).toContain('repo-badge--known');
  });

  it('shows an empty state when there are no repos', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="repos-list"></div>';
    page.renderRepos([]);
    expect(document.getElementById('repos-list').innerHTML).toContain('No repositories configured');
  });
});

describe('computeSections', () => {
  it('returns only non-empty groups, in SETTINGS_GROUPS order, with stable ids', () => {
    const page = createPage();
    const sections = page.computeSections([
      baseSetting({ key: 'a', group: 'summaries' }),
      baseSetting({ key: 'b', group: 'general' }),
      baseSetting({ key: 'c', group: 'general' })
    ]);
    // general precedes summaries in SETTINGS_GROUPS regardless of input order.
    expect(sections.map(s => s.groupKey)).toEqual(['general', 'summaries']);
    expect(sections[0].id).toBe('section-general');
    expect(sections[0].title).toBe('General');
    expect(sections[1].id).toBe('section-summaries');
    // Each section carries its settings so the renderer and nav share one source.
    expect(sections[0].settings).toHaveLength(2);
  });

  it('skips groups with no settings and unknown groups', () => {
    const page = createPage();
    // advanced/ai/etc. absent -> skipped; "nope" is not a known group -> skipped.
    const sections = page.computeSections([
      baseSetting({ key: 'a', group: 'general' }),
      baseSetting({ key: 'z', group: 'nope' })
    ]);
    expect(sections.map(s => s.groupKey)).toEqual(['general']);
  });

  it('returns an empty array for empty/undefined input', () => {
    const page = createPage();
    expect(page.computeSections([])).toEqual([]);
    expect(page.computeSections(undefined)).toEqual([]);
  });
});

describe('navItems', () => {
  it('maps rendered sections to id + title', () => {
    const page = createPage();
    const items = page.navItems(
      [{ id: 'section-general', title: 'General' }, { id: 'section-chat', title: 'Chat' }],
      false
    );
    expect(items).toEqual([
      { id: 'section-general', title: 'General' },
      { id: 'section-chat', title: 'Chat' }
    ]);
  });

  it('appends the Repositories item only when includeRepos is true', () => {
    const page = createPage();
    const withRepos = page.navItems([{ id: 'section-general', title: 'General' }], true);
    expect(withRepos[withRepos.length - 1]).toEqual({ id: 'repos-section', title: 'Repositories' });

    const withoutRepos = page.navItems([{ id: 'section-general', title: 'General' }], false);
    expect(withoutRepos.some(i => i.id === 'repos-section')).toBe(false);
  });

  it('returns just Repositories when there are no sections but repos are visible', () => {
    const page = createPage();
    expect(page.navItems([], true)).toEqual([{ id: 'repos-section', title: 'Repositories' }]);
    expect(page.navItems([], false)).toEqual([]);
  });
});

describe('renderNav', () => {
  it('renders one anchor per item with matching href and data-target', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="settings-nav-list"></div>';
    page.renderNav([
      { id: 'section-general', title: 'General' },
      { id: 'repos-section', title: 'Repositories' }
    ]);
    const html = document.getElementById('settings-nav-list').innerHTML;
    expect(html).toContain('href="#section-general"');
    expect(html).toContain('data-target="section-general"');
    expect(html).toContain('>General<');
    expect(html).toContain('href="#repos-section"');
    expect(html).toContain('>Repositories<');
    expect(document.querySelectorAll('.settings-nav-item')).toHaveLength(2);
  });

  it('clears the list when there are no items', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="settings-nav-list">stale</div>';
    page.renderNav([]);
    expect(document.getElementById('settings-nav-list').innerHTML).toBe('');
  });
});

describe('setActiveNav', () => {
  it('marks exactly one item active and sets aria-current', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="settings-nav-list"></div>';
    page.renderNav([
      { id: 'section-general', title: 'General' },
      { id: 'repos-section', title: 'Repositories' }
    ]);

    page.setActiveNav('repos-section');
    const active = document.querySelectorAll('.settings-nav-item.is-active');
    expect(active).toHaveLength(1);
    expect(active[0].dataset.target).toBe('repos-section');
    expect(active[0].getAttribute('aria-current')).toBe('true');

    // Switching active moves the highlight and clears the old aria-current.
    page.setActiveNav('section-general');
    const nowActive = document.querySelectorAll('.settings-nav-item.is-active');
    expect(nowActive).toHaveLength(1);
    expect(nowActive[0].dataset.target).toBe('section-general');
    expect(document.querySelector('[data-target="repos-section"]').hasAttribute('aria-current')).toBe(false);
  });
});

// ─── Phase 2: sections payload, badges, final ────────────────────────────────

describe('computeSections with API sections payload', () => {
  it('uses the payload order, titles, descriptions, and badges', () => {
    const page = createPage();
    const apiSections = [
      { id: 'tours', title: 'Tours', description: 'Tour stuff', badge: 'beta' },
      { id: 'general', title: 'General Prefs', description: 'gen', badge: null }
    ];
    const sections = page.computeSections([
      baseSetting({ key: 'a', group: 'general' }),
      baseSetting({ key: 'b', group: 'tours' })
    ], apiSections);

    // Order/titles come from the payload, NOT SETTINGS_GROUPS.
    expect(sections.map(s => s.groupKey)).toEqual(['tours', 'general']);
    expect(sections[0].title).toBe('Tours');
    expect(sections[0].description).toBe('Tour stuff');
    expect(sections[0].badge).toBe('beta');
    expect(sections[1].title).toBe('General Prefs');
    expect(sections[1].badge).toBe(null);
  });

  it('omits payload sections that have no visible settings', () => {
    const page = createPage();
    const apiSections = [
      { id: 'general', title: 'General', badge: null },
      { id: 'tours', title: 'Tours', badge: 'beta' }
    ];
    const sections = page.computeSections([
      baseSetting({ key: 'a', group: 'general' })
    ], apiSections);
    expect(sections.map(s => s.groupKey)).toEqual(['general']);
  });

  it('falls back to SETTINGS_GROUPS derivation when the payload is missing or empty', () => {
    const page = createPage();
    const settings = [baseSetting({ key: 'a', group: 'general' })];
    expect(page.computeSections(settings, null).map(s => s.title)).toEqual(['General']);
    expect(page.computeSections(settings, []).map(s => s.title)).toEqual(['General']);
    // Fallback sections carry a null badge.
    expect(page.computeSections(settings, null)[0].badge).toBe(null);
  });
});

describe('badgePillHtml', () => {
  it('renders new/beta as styled feature pills', () => {
    const page = createPage();
    expect(page.badgePillHtml('new')).toContain('feature-badge--new');
    expect(page.badgePillHtml('new')).toContain('>new<');
    expect(page.badgePillHtml('beta')).toContain('feature-badge--beta');
    expect(page.badgePillHtml('beta')).toContain('>beta<');
  });

  it('renders unknown badge strings verbatim with beta styling', () => {
    const page = createPage();
    const html = page.badgePillHtml('alpha');
    expect(html).toContain('feature-badge--beta');
    expect(html).toContain('>alpha<');
  });

  it('returns an empty string for null / undefined / empty', () => {
    const page = createPage();
    expect(page.badgePillHtml(null)).toBe('');
    expect(page.badgePillHtml(undefined)).toBe('');
    expect(page.badgePillHtml('')).toBe('');
  });
});

describe('renderSections — section-header badge', () => {
  it('renders the section badge pill in the header', () => {
    const page = createPage();
    page.apiSections = [{ id: 'tours', title: 'Tours', badge: 'beta' }];
    document.body.innerHTML = '<div id="settings-sections"></div>';
    page.renderSections([baseSetting({ key: 'tours.enabled', group: 'tours' })]);

    const header = document.querySelector('#section-tours .section-header h2');
    expect(header).toBeTruthy();
    expect(header.innerHTML).toContain('feature-badge--beta');
    expect(header.textContent).toContain('Tours');
    expect(header.textContent).toContain('beta');
  });
});

describe('navItems — badge propagation', () => {
  it('carries a badge when the section has one and omits the key otherwise', () => {
    const page = createPage();
    const items = page.navItems([
      { id: 'section-tours', title: 'Tours', badge: 'beta' },
      { id: 'section-general', title: 'General', badge: null }
    ], false);
    expect(items[0]).toEqual({ id: 'section-tours', title: 'Tours', badge: 'beta' });
    expect(items[1]).toEqual({ id: 'section-general', title: 'General' });
  });
});

describe('renderNav — badge pill', () => {
  it('renders a badge pill after a nav item title', () => {
    const page = createPage();
    document.body.innerHTML = '<div id="settings-nav-list"></div>';
    page.renderNav([{ id: 'section-tours', title: 'Tours', badge: 'beta' }]);

    const item = document.querySelector('.settings-nav-item[data-target="section-tours"]');
    expect(item.innerHTML).toContain('feature-badge--beta');
    expect(item.textContent).toContain('Tours');
  });
});

describe('rowInnerHtml — per-setting badge + final lock', () => {
  it('renders a per-setting feature badge when descriptor.badge is set', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({ badge: 'new' }));
    expect(html).toContain('feature-badge--new');
    expect(html).toContain('>new<');
  });

  it('final setting: lock badge, disabled control, no reset even when source is app', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({
      key: 'default_model', group: 'ai', type: 'string',
      final: true, source: 'app', value: 'opus'
    }));
    // Lock badge with its tooltip.
    expect(html).toContain('data-role="final-badge"');
    expect(html).toContain('Locked by configuration');
    // Control is disabled.
    expect(html).toMatch(/data-role="control"[^>]*disabled/);
    // Reset button stays hidden despite the app source.
    expect(html).toMatch(/data-role="reset"\s+hidden/);
  });

  it('non-final setting renders no lock badge', () => {
    const page = createPage();
    const html = page.rowInnerHtml(baseSetting({ source: 'app', value: true }));
    expect(html).not.toContain('data-role="final-badge"');
  });
});

describe('controlHtml — final disables the control', () => {
  it('boolean / integer / enum / string all render disabled when final', () => {
    const page = createPage();
    expect(page.controlHtml(baseSetting({ type: 'boolean', final: true })))
      .toMatch(/type="checkbox"[^>]*disabled/);
    expect(page.controlHtml(baseSetting({ type: 'integer', final: true })))
      .toMatch(/data-role="control"[^>]*disabled/);
    expect(page.controlHtml(baseSetting({ type: 'enum', values: ['a', 'b'], final: true })))
      .toMatch(/<select[^>]*disabled/);
    expect(page.controlHtml(baseSetting({ key: 'assisted_by_url', type: 'string', final: true })))
      .toMatch(/data-role="control"[^>]*disabled/);
  });

  it('provider select renders disabled when final', () => {
    const page = createPage([{ id: 'claude', name: 'Claude', models: [{ id: 'opus' }] }]);
    const html = page.providerSelectHtml(baseSetting({
      key: 'default_provider', type: 'string', final: true, default: 'claude', value: 'claude'
    }));
    expect(html).toMatch(/<select[^>]*disabled/);
  });

  it('non-final controls are not disabled', () => {
    const page = createPage();
    expect(page.controlHtml(baseSetting({ type: 'boolean' }))).not.toContain('disabled');
    expect(page.controlHtml(baseSetting({ type: 'string', key: 'assisted_by_url' }))).not.toContain('disabled');
  });
});

// ─── Bug fixes: escapeHtml quotes, chat_provider list, mutation race guard ────

describe('escapeHtml — attribute-safe escaping', () => {
  it('escapes ampersands, angle brackets, AND both quote types', () => {
    const page = createPage();
    // Output lands in double-quoted attributes, so " and ' must be escaped too.
    expect(page.escapeHtml(`a & b < c > d " e ' f`))
      .toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });

  it('cannot break out of a double-quoted attribute context', () => {
    const page = createPage();
    const html = `<input value="${page.escapeHtml('x" onx="alert(1)')}">`;
    // The injected closing quote is neutralised — only the real attribute quotes remain.
    expect(html).toBe('<input value="x&quot; onx=&quot;alert(1)">');
    expect(html).not.toContain('onx="');
  });

  it('returns empty string for null and undefined (unchanged behavior)', () => {
    const page = createPage();
    expect(page.escapeHtml(null)).toBe('');
    expect(page.escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-string input', () => {
    const page = createPage();
    expect(page.escapeHtml(42)).toBe('42');
    expect(page.escapeHtml(false)).toBe('false');
  });
});

describe('chat_provider dropdown — sourced from chat providers, not analysis providers', () => {
  const analysisProviders = [
    { id: 'claude', name: 'Claude', models: [{ id: 'opus' }] },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt' }] }
  ];
  const chatProviders = [
    { id: 'pi', name: 'Pi', type: 'builtin', available: true },
    { id: 'copilot-acp', name: 'Copilot (ACP)', type: 'acp', available: false }
  ];

  function chatSetting(overrides = {}) {
    return baseSetting({
      key: 'chat_provider', group: 'chat', type: 'string', default: 'pi', value: 'pi', ...overrides
    });
  }

  it('renders the chat provider list, never the analysis provider list', () => {
    const page = createPage(analysisProviders);
    page.chatProviders = chatProviders;
    const html = page.controlHtml(chatSetting());
    expect(html).toContain('>Pi<');
    expect(html).toContain('>Copilot (ACP)<');
    // Analysis providers must NOT leak into the chat dropdown.
    expect(html).not.toContain('>Claude<');
    expect(html).not.toContain('>Codex<');
  });

  it('omits the inherit option (default is a concrete provider) and selects the current', () => {
    const page = createPage(analysisProviders);
    page.chatProviders = chatProviders;
    const html = page.controlHtml(chatSetting({ value: 'pi' }));
    expect(html).not.toContain('Default (inherit)');
    expect(html).toMatch(/<option value="pi"\s+selected>Pi<\/option>/);
  });

  it('preserves a configured-but-unknown chat provider as an "(unavailable)" option', () => {
    const page = createPage(analysisProviders);
    page.chatProviders = chatProviders;
    const html = page.controlHtml(chatSetting({ value: 'ghost' }));
    expect(html).toMatch(/<option value="ghost"\s+selected>ghost \(unavailable\)<\/option>/);
  });

  it('loadChatProviders populates chatProviders from GET /api/config', async () => {
    const page = createPage();
    global.fetch = vi.fn(async () => makeResponse({ chat_providers: chatProviders }));
    await page.loadChatProviders();
    expect(page.chatProviders).toEqual(chatProviders);
    expect(global.fetch).toHaveBeenCalledWith('/api/config');
  });

  it('loadChatProviders defaults to an empty list on failure', async () => {
    const page = createPage();
    page.chatProviders = [{ id: 'stale' }];
    global.fetch = vi.fn(async () => makeResponse({}, { ok: false, status: 500 }));
    await page.loadChatProviders();
    expect(page.chatProviders).toEqual([]);
  });
});

describe('mutation race guard — updateSetting / resetSetting serialize per key', () => {
  // A controllable fetch: each call returns a promise resolved manually via the
  // returned deferred, so we can land responses out of order deterministically.
  function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  }

  function instrument(page) {
    const applied = [];
    page.rerenderRow = (s) => applied.push(s.value);
    page.showToast = () => {};
    return applied;
  }

  it('applies only the latest updateSetting when responses resolve out of order', async () => {
    const page = createPage();
    page.settingsByKey = { theme: baseSetting({ key: 'theme', value: 'light' }) };
    const applied = instrument(page);

    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1.promise, d2.promise];
    let i = 0;
    global.fetch = vi.fn(() => calls[i++]);

    const p1 = page.updateSetting('theme', 'dark');   // seq 1 (stale)
    const p2 = page.updateSetting('theme', 'light');  // seq 2 (winner)

    // Latest response lands FIRST, stale one SECOND.
    d2.resolve(makeResponse({ setting: baseSetting({ key: 'theme', label: 'Theme', value: 'light' }) }));
    await p2;
    d1.resolve(makeResponse({ setting: baseSetting({ key: 'theme', label: 'Theme', value: 'dark' }) }));
    await p1;

    // Only the winning mutation applied; the stale 'dark' response was ignored.
    expect(applied).toEqual(['light']);
    expect(page.settingsByKey.theme.value).toBe('light');
  });

  it('a Reset issued while a PUT is in flight wins; the stale PUT response is ignored', async () => {
    const page = createPage();
    page.settingsByKey = { theme: baseSetting({ key: 'theme', source: 'app', value: 'dark' }) };
    const applied = instrument(page);

    const dPut = deferred();
    const dDel = deferred();
    const calls = [dPut.promise, dDel.promise];
    let i = 0;
    global.fetch = vi.fn(() => calls[i++]);

    const put = page.updateSetting('theme', 'light');  // seq 1 (stale)
    const del = page.resetSetting('theme');            // seq 2 (winner)

    dDel.resolve(makeResponse({ setting: baseSetting({ key: 'theme', label: 'Theme', source: 'default', value: 'light' }) }));
    await del;
    dPut.resolve(makeResponse({ setting: baseSetting({ key: 'theme', label: 'Theme', source: 'app', value: 'light' }) }));
    await put;

    // Reset's descriptor (source 'default') is the final state, not the PUT's.
    expect(applied).toEqual(['light']);
    expect(page.settingsByKey.theme.source).toBe('default');
  });

  it('a superseded PUT error does not revert state set by a newer mutation', async () => {
    const page = createPage();
    page.settingsByKey = { theme: baseSetting({ key: 'theme', value: 'light' }) };
    const applied = instrument(page);

    const dFail = deferred();
    const dOk = deferred();
    const calls = [dFail.promise, dOk.promise];
    let i = 0;
    global.fetch = vi.fn(() => calls[i++]);

    const failing = page.updateSetting('theme', 'dark');   // seq 1 — will error
    const winner = page.updateSetting('theme', 'blue');    // seq 2 — succeeds

    dOk.resolve(makeResponse({ setting: baseSetting({ key: 'theme', label: 'Theme', value: 'blue' }) }));
    await winner;
    // The stale request fails (e.g. 500). Its catch must NOT revert to known-good.
    dFail.resolve(makeResponse({ error: 'boom' }, { ok: false, status: 500 }));
    await failing;

    expect(applied).toEqual(['blue']);
    expect(page.settingsByKey.theme.value).toBe('blue');
  });
});
