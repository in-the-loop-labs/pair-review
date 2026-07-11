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

const { SettingsPage, SOURCE_DISPLAY, PROVIDER_KEYS, CHAT_PROVIDER_KEYS, MODEL_KEYS, COUNCIL_KEYS } = require('../../public/js/settings.js');

/**
 * Build a SettingsPage instance without invoking the constructor/init.
 * @param {Array} providers - provider definitions used by provider selects
 */
function createPage(providers = []) {
  const page = Object.create(SettingsPage.prototype);
  page.providers = providers;
  page.chatProviders = [];
  page.councils = [];
  page.settingsByKey = {};
  page._seq = {};
  page._councilDropdowns = {};
  page._councilCards = {};
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

  it('object value: renders a collapsible with an entry count (from the object keys)', () => {
    const page = createPage();
    const three = page.readonlyValueHtml(baseSetting({ value: { a: {}, b: {}, c: {} } }));
    expect(three).toContain('<details');
    expect(three).toContain('3 entries');
    expect(three).toContain('data-role="object-json"');
    // The <pre> is left empty in the HTML (filled later via textContent).
    expect(three).toMatch(/<pre class="readonly-object-json" data-role="object-json"><\/pre>/);

    const one = page.readonlyValueHtml(baseSetting({ value: { only: {} } }));
    expect(one).toContain('1 entry');
  });

  it('empty object value: shows No entries (no collapsible)', () => {
    const page = createPage();
    const html = page.readonlyValueHtml(baseSetting({ value: {} }));
    expect(html).toContain('No entries');
    expect(html).not.toContain('<details');
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

describe('populateObjectValues', () => {
  it('fills each object-json <pre> from its descriptor via textContent', () => {
    const page = createPage();
    page.settingsByKey = {
      providers: baseSetting({ key: 'providers', group: 'readonly', type: 'object', editable: false, value: { a: { model: 'x' } } })
    };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="providers">
          <pre class="readonly-object-json" data-role="object-json"></pre>
        </div>
      </div>`;
    page.populateObjectValues(document.getElementById('settings-sections'));
    const pre = document.querySelector('[data-role="object-json"]');
    expect(pre.textContent).toBe(JSON.stringify({ a: { model: 'x' } }, null, 2));
  });

  it('leaves the <pre> empty when the descriptor value is not an object', () => {
    const page = createPage();
    page.settingsByKey = { x: baseSetting({ key: 'x', value: 'scalar' }) };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="x">
          <pre class="readonly-object-json" data-role="object-json"></pre>
        </div>
      </div>`;
    page.populateObjectValues(document.getElementById('settings-sections'));
    expect(document.querySelector('[data-role="object-json"]').textContent).toBe('');
  });
});

describe('MODEL_KEYS + modelInputHtml (datalist-backed model field)', () => {
  const providers = [
    { id: 'claude', name: 'Claude', models: [{ id: 'opus' }, { id: 'sonnet' }] },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.5' }, { id: 'opus' }] } // 'opus' duplicated on purpose
  ];

  it('covers exactly the three model keys', () => {
    expect(MODEL_KEYS.has('default_model')).toBe(true);
    expect(MODEL_KEYS.has('summaries.model')).toBe(true);
    expect(MODEL_KEYS.has('tours.model')).toBe(true);
    expect(MODEL_KEYS.has('default_provider')).toBe(false);
  });

  it('controlHtml routes model keys to an input backed by a datalist', () => {
    const page = createPage(providers);
    const html = page.controlHtml(baseSetting({ key: 'default_model', type: 'string', value: 'opus', default: 'opus' }));
    expect(html).toContain('type="text"');
    // Non-alphanumerics in the key (incl. underscores) collapse to dashes in the id.
    expect(html).toMatch(/list="models-default-model"/);
    expect(html).toContain('<datalist id="models-default-model">');
    expect(html).toContain('value="opus"');
  });

  it('datalist is the de-duplicated, sorted union of all providers\' models', () => {
    const page = createPage(providers);
    const html = page.modelInputHtml(baseSetting({ key: 'summaries.model', type: 'string', value: '', default: '' }));
    // Union: gpt-5.5, opus, sonnet — 'opus' appears once despite two providers.
    const optionValues = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
    expect(optionValues).toEqual(['gpt-5.5', 'opus', 'sonnet']);
    // Datalist id is derived from the dot-path key (dots → dashes).
    expect(html).toContain('id="models-summaries-model"');
  });

  it('accepts a valid-but-unlisted model id (free text, not a strict select)', () => {
    const page = createPage(providers);
    const html = page.modelInputHtml(baseSetting({ key: 'tours.model', type: 'string', value: 'some-unlisted-model' }));
    expect(html).toContain('type="text"');
    expect(html).toContain('value="some-unlisted-model"');
  });

  it('renders disabled when final', () => {
    const page = createPage(providers);
    const html = page.modelInputHtml(baseSetting({ key: 'default_model', type: 'string', final: true, value: 'opus' }));
    expect(html).toMatch(/data-role="control"[^>]*disabled/);
  });
});

describe('COUNCIL_KEYS + "Default for Analysis" control (shared CouncilDropdown)', () => {
  const { CouncilDropdown } = require('../../public/js/components/CouncilDropdown.js');
  const councils = [
    { id: 'c1', name: 'Security', type: 'advanced' },
    { id: 'c2', name: 'Perf', type: 'council' }
  ];

  function councilSetting(overrides = {}) {
    return baseSetting({ key: 'default_council_id', group: 'ai', type: 'string', default: '', value: '', ...overrides });
  }

  it('covers the default_council_id key', () => {
    expect(COUNCIL_KEYS.has('default_council_id')).toBe(true);
  });

  it('controlHtml routes the council key to a mount point + preview (not a native select)', () => {
    const page = createPage();
    page.councils = councils;
    const html = page.controlHtml(councilSetting());
    expect(html).toContain('data-role="council-mount"');
    expect(html).toContain('data-role="council-preview"');
    expect(html).toContain('custom-dropdown');
    // Not a native select and not a generic control (the generic change handler
    // must ignore it — the component PUTs via its own callback).
    expect(html).not.toContain('<select');
    expect(html).not.toContain('data-role="control"');
  });

  it('mountCouncilDropdowns instantiates the shared component with a base "Default Provider / Model" option', () => {
    const page = createPage();
    page.councils = councils;
    window.CouncilDropdown = CouncilDropdown;
    page.settingsByKey = { default_council_id: councilSetting({ value: 'c2' }) };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="custom-dropdown council-dropdown-control" data-role="council-mount"></div>
        </div>
      </div>`;
    page.mountCouncilDropdowns(document.getElementById('settings-sections'));

    const mount = document.querySelector('[data-role="council-mount"]');
    // The rich dropdown rendered: trigger shows the selected council + its type badge.
    expect(mount.querySelector('.custom-dropdown-trigger')).toBeTruthy();
    expect(mount.textContent).toContain('Perf');
    expect(mount.querySelector('.council-type-badge')).toBeTruthy();
    // The base option is present in the list.
    const optionTexts = [...mount.querySelectorAll('.custom-dropdown-option')].map(o => o.textContent.trim());
    expect(optionTexts.some(t => /Default Provider \/ Model/.test(t))).toBe(true);
    // An instance is tracked for teardown.
    expect(page._councilDropdowns.default_council_id).toBeInstanceOf(CouncilDropdown);
  });

  it('mountCouncilDropdowns tears down a prior instance before re-mounting (no listener leak)', () => {
    const page = createPage();
    page.councils = councils;
    window.CouncilDropdown = CouncilDropdown;
    page.settingsByKey = { default_council_id: councilSetting({ value: '' }) };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="custom-dropdown" data-role="council-mount"></div>
        </div>
      </div>`;
    const container = document.getElementById('settings-sections');
    page.mountCouncilDropdowns(container);
    const first = page._councilDropdowns.default_council_id;
    const destroySpy = vi.spyOn(first, 'destroy');
    page.mountCouncilDropdowns(container);
    expect(destroySpy).toHaveBeenCalled();
    expect(page._councilDropdowns.default_council_id).not.toBe(first);
  });

  it('selecting a council PUTs via updateSetting with the council id', () => {
    const page = createPage();
    page.councils = councils;
    window.CouncilDropdown = CouncilDropdown;
    page.settingsByKey = { default_council_id: councilSetting({ value: '' }) };
    page.updateSetting = vi.fn();
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="custom-dropdown" data-role="council-mount"></div>
        </div>
      </div>`;
    page.mountCouncilDropdowns(document.getElementById('settings-sections'));
    // Simulate the component reporting a selection.
    page._councilDropdowns.default_council_id.onSelect('c1');
    expect(page.updateSetting).toHaveBeenCalledWith('default_council_id', 'c1');
  });

  it('a final council setting mounts a disabled dropdown', () => {
    const page = createPage();
    page.councils = councils;
    window.CouncilDropdown = CouncilDropdown;
    page.settingsByKey = { default_council_id: councilSetting({ final: true, value: 'c1' }) };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="custom-dropdown" data-role="council-mount"></div>
        </div>
      </div>`;
    page.mountCouncilDropdowns(document.getElementById('settings-sections'));
    expect(document.querySelector('.custom-dropdown-trigger').disabled).toBe(true);
  });

  it('mountCouncilDropdowns is a no-op when the component is unavailable', () => {
    const page = createPage();
    delete window.CouncilDropdown;
    page.settingsByKey = { default_council_id: councilSetting() };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="custom-dropdown" data-role="council-mount"></div>
        </div>
      </div>`;
    expect(() => page.mountCouncilDropdowns(document.getElementById('settings-sections'))).not.toThrow();
    expect(page._councilDropdowns.default_council_id).toBeUndefined();
  });

  it('loadCouncils populates councils from GET /api/councils', async () => {
    const page = createPage();
    global.fetch = vi.fn(async () => makeResponse({ councils }));
    await page.loadCouncils();
    expect(page.councils).toEqual(councils);
    expect(global.fetch).toHaveBeenCalledWith('/api/councils');
  });

  it('loadCouncils defaults to an empty list on failure', async () => {
    const page = createPage();
    page.councils = [{ id: 'stale' }];
    global.fetch = vi.fn(async () => makeResponse({}, { ok: false, status: 500 }));
    await page.loadCouncils();
    expect(page.councils).toEqual([]);
  });
});

describe('"Default for Analysis" composition preview', () => {
  const { CouncilCard } = require('../../public/js/components/CouncilCard.js');
  const { CouncilDropdown } = require('../../public/js/components/CouncilDropdown.js');
  const previewCouncils = [
    { id: 'c1', name: 'Security', type: 'advanced', config: { levels: { '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] } } } },
    { id: 'c2', name: 'Perf', type: 'council', config: { voices: [{ provider: 'claude', model: 'sonnet' }], levels: { '1': true } } }
  ];
  const previewProviders = [{ id: 'claude', name: 'Claude', models: [{ id: 'sonnet', name: 'Sonnet' }] }];

  function councilRow(value) {
    document.body.innerHTML = `
      <div class="setting-row" data-key="default_council_id">
        <div class="council-control-wrap">
          <div class="custom-dropdown" data-role="council-mount"></div>
          <div class="council-preview" data-role="council-preview"></div>
        </div>
      </div>`;
    return document.querySelector('.setting-row');
  }

  it('resolveModelDisplay maps provider/model ids to names from /api/providers', () => {
    const page = createPage(previewProviders);
    expect(page.resolveModelDisplay('claude', 'sonnet')).toEqual({ providerName: 'Claude', modelName: 'Sonnet' });
    // Unknown provider/model fall back to the raw ids.
    expect(page.resolveModelDisplay('nope', 'x')).toEqual({ providerName: 'nope', modelName: 'x' });
  });

  it('shows a hint (not a card) for the base "Default Provider / Model" option', () => {
    const page = createPage(previewProviders);
    page.councils = previewCouncils;
    const row = councilRow('');
    page.renderCouncilPreview(row, { key: 'default_council_id', value: '' });
    const preview = row.querySelector('[data-role="council-preview"]');
    expect(preview.querySelector('.council-preview-hint')).toBeTruthy();
    expect(preview.textContent).toContain('Uses the Default Provider / Model rows below');
    expect(preview.querySelector('.council-card')).toBeNull();
  });

  it('renders the CouncilCard composition when a council is selected', () => {
    window.CouncilCard = CouncilCard;
    const page = createPage(previewProviders);
    page.councils = previewCouncils;
    const row = councilRow('c2');
    page.renderCouncilPreview(row, { key: 'default_council_id', value: 'c2' });
    const preview = row.querySelector('[data-role="council-preview"]');
    expect(preview.querySelector('.council-card')).toBeTruthy();
    expect(preview.textContent).toContain('Perf');
    // Model ids resolved to display names via /api/providers.
    expect(preview.textContent).toContain('Claude / Sonnet');
  });

  it('shows a not-found note for a stale council id', () => {
    const page = createPage(previewProviders);
    page.councils = previewCouncils;
    const row = councilRow('deleted');
    page.renderCouncilPreview(row, { key: 'default_council_id', value: 'deleted' });
    const preview = row.querySelector('[data-role="council-preview"]');
    expect(preview.textContent).toContain('not found');
    expect(preview.querySelector('.council-card')).toBeNull();
  });

  it('mountCouncilDropdowns renders both the dropdown and the composition preview', () => {
    window.CouncilDropdown = CouncilDropdown;
    window.CouncilCard = CouncilCard;
    const page = createPage(previewProviders);
    page.councils = previewCouncils;
    page.settingsByKey = {
      default_council_id: baseSetting({ key: 'default_council_id', group: 'ai', type: 'string', value: 'c1' })
    };
    document.body.innerHTML = `
      <div id="settings-sections">
        <div class="setting-row" data-key="default_council_id">
          <div class="council-control-wrap">
            <div class="custom-dropdown" data-role="council-mount"></div>
            <div class="council-preview" data-role="council-preview"></div>
          </div>
        </div>
      </div>`;
    page.mountCouncilDropdowns(document.getElementById('settings-sections'));
    const row = document.querySelector('.setting-row');
    expect(row.querySelector('.custom-dropdown-trigger')).toBeTruthy();
    // Selected council 'c1' is advanced → its preview card shows the Advanced badge.
    expect(row.querySelector('.council-preview .council-card')).toBeTruthy();
    expect(row.querySelector('.council-card-badge-advanced')).toBeTruthy();
  });
});

describe('computeSections — hidden sections', () => {
  it('omits a section flagged hidden on the API payload', () => {
    const page = createPage();
    const apiSections = [
      { id: 'general', title: 'General', badge: null, hidden: false },
      { id: 'summaries', title: 'Summaries', badge: null, hidden: true },
      { id: 'tours', title: 'Tours', badge: 'new', hidden: false }
    ];
    const sections = page.computeSections([
      baseSetting({ key: 'a', group: 'general' }),
      baseSetting({ key: 'summaries.enabled', group: 'summaries' }),
      baseSetting({ key: 'tours.enabled', group: 'tours' })
    ], apiSections);
    // Summaries is dropped even though it has settings.
    expect(sections.map(s => s.groupKey)).toEqual(['general', 'tours']);
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
