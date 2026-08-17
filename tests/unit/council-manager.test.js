// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the settings-page CouncilManager component
 * (public/js/components/CouncilManager.js). Imports the real class via its
 * CommonJS export and drives it against a routed fetch mock backed by an
 * in-memory store, so re-fetch-after-mutation behaves like the real API.
 *
 * The two config tabs are loaded FOR REAL rather than stubbed. They are the
 * whole point of the editor mode, and only the real classes can catch the two
 * things most likely to break: the hardcoded panel ids
 * (`#tab-panel-council` / `#tab-panel-advanced`, which the tabs query through
 * their constructor root) and the private `_saveCouncil` entry point the footer
 * Save button calls. A stub would happily accept a typo in either. They cost one
 * `inject()` of static HTML per test — the same thing
 * tests/unit/config-tab-bare-container.test.js already does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Sets window.TimeoutSelect. The tabs reference the bare identifier
// `TimeoutSelect` when mounting timeout dropdowns, so it has to resolve on the
// global scope chain, not just on `window`.
require('../../public/js/components/TimeoutSelect.js');
global.TimeoutSelect = window.TimeoutSelect;

// Each of these installs its browser global as a side effect of loading —
// exactly what the settings page's script tags do.
require('../../public/js/components/CouncilDropdown.js');
require('../../public/js/components/CouncilCard.js');
require('../../public/js/utils/provider-map.js');
require('../../public/js/utils/provider-model.js');
require('../../public/js/utils/council-crud.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');
const { CouncilManager } = require('../../public/js/components/CouncilManager.js');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    defaultModel: 'sonnet',
    defaultTimeout: 600000,
    models: [
      { id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true },
      { id: 'opus', name: 'Opus', tier: 'thorough' }
    ]
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    defaultModel: 'gemini-3.1-pro-low',
    models: [
      { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (low)', tier: 'fast', default: true }
    ]
  }
];

/**
 * Providers whose model ids are shaped like the real registry's: the tabs'
 * hardcoded `_defaultModel` ('sonnet') is an ALIAS here, not an `<option>`
 * value, so a new council seeded from it would select nothing and be dropped by
 * `_readConfigFromUI`. Used by the regression test for the seeded default pair.
 */
const VERSIONED_PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    defaultModel: 'sonnet-4.6',
    defaultTimeout: 600000,
    models: [
      { id: 'sonnet-4.6', name: 'Sonnet 4.6', tier: 'balanced', default: true, aliases: ['sonnet'] },
      { id: 'opus-4.6', name: 'Opus 4.6', tier: 'thorough' }
    ]
  }
];

/** The parts of GET /api/config CouncilManager reads. */
const APP_CONFIG = { default_provider: 'claude', default_model: 'sonnet' };

const VOICE_CONFIG = {
  voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced', timeout: 600000 }],
  levels: { 1: true, 2: true, 3: false },
  consolidation: { provider: 'claude', model: 'opus', tier: 'thorough', timeout: 1800000 }
};

const ADVANCED_CONFIG = {
  levels: {
    1: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', timeout: 600000 }] },
    2: { enabled: false, voices: [] },
    3: { enabled: false, voices: [] }
  },
  consolidation: { provider: 'claude', model: 'opus', timeout: 1800000 }
};

/** A DB council row as GET /api/councils returns it (source stamped by the store). */
function dbCouncil(overrides = {}) {
  return {
    id: 'db-1',
    name: 'Dream Team',
    type: 'council',
    config: VOICE_CONFIG,
    source: 'db',
    created_at: '2026-08-01 10:00:00',
    updated_at: '2026-08-01 10:00:00',
    ...overrides
  };
}

/** A file-overlay council row (~/.pair-review/councils/*.json). */
function fileCouncil(overrides = {}) {
  return {
    id: 'file:from-disk',
    name: 'From Disk',
    type: 'advanced',
    config: ADVANCED_CONFIG,
    description: 'Committed to the repo',
    source: 'file',
    readOnly: true,
    filePath: '/home/dev/.pair-review/councils/from-disk.council.json',
    ...overrides
  };
}

/** Minimal fetch Response stand-in with an async json() body. */
function makeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/**
 * Install a routed fetch mock backed by `store`
 * ({ list, nextId, providers?, config? }). Mutations update the store so the
 * component's re-fetch returns fresh data. File councils are refused on the
 * write paths exactly as src/routes/councils.js does.
 */
function installFetch(store) {
  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();

    if (url === '/api/providers') {
      return makeResponse({ providers: store.providers || PROVIDERS });
    }
    if (url === '/api/config') {
      // `configFails` makes the route 500 from the very first call, so a mount
      // can exercise the real constructor-time failure rather than a hand-rolled
      // re-invocation of the private loader.
      if (store.configFails) return makeResponse({ error: 'nope' }, { ok: false, status: 500 });
      return makeResponse(store.config || APP_CONFIG);
    }
    if (url === '/api/councils' && method === 'GET') {
      return makeResponse({ councils: store.list.map(c => ({ ...c })) });
    }
    if (url === '/api/councils' && method === 'POST') {
      const { name, config, type } = JSON.parse(opts.body);
      const council = {
        id: `db-${store.nextId++}`,
        name,
        config,
        type: type || 'advanced',
        source: 'db',
        created_at: '2026-08-12 09:00:00',
        updated_at: '2026-08-12 09:00:00'
      };
      store.list.unshift(council);
      return makeResponse({ council }, { status: 201 });
    }

    const m = url.match(/^\/api\/councils\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id.startsWith('file:')) {
        return makeResponse(
          { error: 'This council is defined in a file and cannot be modified through the API.' },
          { ok: false, status: 400 }
        );
      }
      const found = store.list.find(c => c.id === id);
      if (method === 'PUT') {
        if (!found) return makeResponse({ error: 'not found' }, { ok: false, status: 404 });
        const body = JSON.parse(opts.body);
        found.config = body.config;
        found.updated_at = '2026-08-12 12:00:00';
        return makeResponse({ council: found });
      }
      if (method === 'DELETE') {
        if (!found) return makeResponse({ error: 'not found' }, { ok: false, status: 404 });
        store.list = store.list.filter(c => c.id !== id);
        return makeResponse({ success: true });
      }
    }
    return makeResponse({ error: 'unexpected' }, { ok: false, status: 500 });
  });
  return global.fetch;
}

function mount() {
  document.body.innerHTML = '<div id="host"></div>';
  return document.getElementById('host');
}

/** Mount a manager and wait for its first list paint. */
async function mountManager(store, options = {}) {
  const fetchMock = installFetch(store);
  const host = mount();
  const manager = new CouncilManager(host, options);
  await vi.waitFor(() => {
    expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy();
  });
  return { host, manager, fetchMock };
}

function rowFor(host, id) {
  return host.querySelector(`.council-manager__row-wrap[data-id="${id}"]`);
}

/** An externally-settleable promise, for pinning a handler mid-await. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Record the tab lifecycle call order while keeping the real behavior. */
function recordTabOrder(TabClass, methods) {
  const order = [];
  for (const method of methods) {
    const original = TabClass.prototype[method];
    vi.spyOn(TabClass.prototype, method).mockImplementation(function (...args) {
      order.push(method);
      return original.apply(this, args);
    });
  }
  return order;
}

const TAB_LIFECYCLE = [
  'inject', 'setProviders', 'setDefaultOrchestration', 'reset', 'setDefaultCouncilId', 'loadCouncils'
];

beforeEach(() => {
  window.toast = {
    showError: vi.fn(),
    showWarning: vi.fn(),
    showSuccess: vi.fn()
  };
  // Destructive actions are gated behind a confirmation; default to the styled
  // dialog accepting so happy paths proceed. Individual tests override.
  window.confirmDialog = { show: vi.fn().mockResolvedValue('confirm') };
  window.textInputDialog = { show: vi.fn().mockResolvedValue(null) };
  window.CouncilDocument = {
    exportCouncilToFile: vi.fn(() => ({ doc: {}, copied: Promise.resolve(true) }))
  };
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete global.fetch;
  delete window.toast;
  delete window.confirmDialog;
  delete window.textInputDialog;
  delete window.CouncilDocument;
});

describe('CouncilManager list mode', () => {
  it('renders DB and file councils with type and source badges', async () => {
    const { host } = await mountManager({
      list: [
        dbCouncil(),
        dbCouncil({ id: 'db-2', name: 'Level Squad', type: 'advanced', config: ADVANCED_CONFIG }),
        fileCouncil()
      ],
      nextId: 3
    });

    expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(3);

    const standard = rowFor(host, 'db-1');
    expect(standard.querySelector('.council-manager__name').textContent).toBe('Dream Team');
    expect(standard.querySelector('.council-type-badge.badge-standard').textContent).toBe('Standard');
    expect(standard.querySelector('.council-type-badge.badge-file')).toBeNull();

    const advanced = rowFor(host, 'db-2');
    expect(advanced.querySelector('.council-type-badge.badge-advanced').textContent).toBe('Advanced');

    const file = rowFor(host, 'file:from-disk');
    const fileBadge = file.querySelector('.council-type-badge.badge-file');
    expect(fileBadge.textContent).toBe('File');
    // The path is the only place a user can go to edit a file council.
    expect(fileBadge.title).toBe('/home/dev/.pair-review/councils/from-disk.council.json');
  });

  it('badges a legacy untyped council as Advanced (the editor its Edit button opens)', async () => {
    const { host } = await mountManager({
      list: [dbCouncil({ id: 'db-legacy', name: 'Old Council', type: undefined, config: ADVANCED_CONFIG })],
      nextId: 2
    });

    const row = rowFor(host, 'db-legacy');
    expect(row.querySelector('.council-type-badge.badge-advanced').textContent).toBe('Advanced');
    expect(row.querySelector('.council-type-badge.badge-standard')).toBeNull();
  });

  it('offers Edit/Duplicate/Export/Delete on DB councils and only Duplicate/Export on file councils', async () => {
    const { host } = await mountManager({ list: [dbCouncil(), fileCouncil()], nextId: 3 });

    const db = rowFor(host, 'db-1');
    expect(db.querySelector('.council-manager__edit-btn')).toBeTruthy();
    expect(db.querySelector('.council-manager__duplicate-btn')).toBeTruthy();
    expect(db.querySelector('.council-manager__export-btn')).toBeTruthy();
    expect(db.querySelector('.council-manager__delete-btn')).toBeTruthy();

    // The API 400s on PUT/DELETE for `file:` ids by design, so those affordances
    // are not rendered at all.
    const file = rowFor(host, 'file:from-disk');
    expect(file.querySelector('.council-manager__edit-btn')).toBeNull();
    expect(file.querySelector('.council-manager__delete-btn')).toBeNull();
    expect(file.querySelector('.council-manager__duplicate-btn')).toBeTruthy();
    expect(file.querySelector('.council-manager__export-btn')).toBeTruthy();
  });

  it('shows the description as a subtitle only when the council has one', async () => {
    const { host } = await mountManager({ list: [dbCouncil(), fileCouncil()], nextId: 3 });

    expect(rowFor(host, 'db-1').querySelector('.council-manager__description')).toBeNull();
    expect(rowFor(host, 'file:from-disk').querySelector('.council-manager__description').textContent)
      .toBe('Committed to the repo');
  });

  it('escapes council names and descriptions (no HTML injection)', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const { host } = await mountManager({
      list: [dbCouncil({ name: evil, description: evil })],
      nextId: 2
    });

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.council-manager__name').textContent).toBe(evil);
    expect(host.querySelector('.council-manager__description').textContent).toBe(evil);
  });

  it('renders an empty state and an Add button when there are no councils', async () => {
    const { host } = await mountManager({ list: [], nextId: 1 });

    expect(host.querySelector('.council-manager__empty').textContent).toContain('No councils yet');
    expect(host.querySelector('.council-manager__add-btn')).toBeTruthy();
  });

  it('renders an error banner when the list fetch fails', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url === '/api/providers') return makeResponse({ providers: PROVIDERS });
      return makeResponse({ error: 'boom' }, { ok: false, status: 500 });
    });
    const host = mount();
    new CouncilManager(host);

    await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
  });

  // "The request failed" and "you have no councils" are different states. The
  // component used to collapse them: the catch assigned `this._councils = []`
  // and `_buildList` decided purely on length, so a transient error rendered as
  // an authoritative "No councils yet." — under the error banner, contradicting
  // it. Every mutation path ends in `_fetchAndRender()`, so one flaky GET right
  // after a successful delete wiped the whole list off the screen.
  describe('a failed load reports UNKNOWN, never EMPTY', () => {
    it('does not claim "No councils yet." when the very first load failed', async () => {
      global.fetch = vi.fn(async (url) => {
        if (url === '/api/providers') return makeResponse({ providers: PROVIDERS });
        if (url === '/api/config') return makeResponse(APP_CONFIG);
        return makeResponse({ error: 'boom' }, { ok: false, status: 500 });
      });
      const host = mount();
      new CouncilManager(host);

      await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
      expect(host.querySelector('.council-manager__empty')).toBeNull();
      // Add council stays reachable — the list being unknown is no reason to
      // take the only affordance away.
      expect(host.querySelector('.council-manager__add-btn')).toBeTruthy();
    });

    it('keeps the rows it already knows about when a refresh fails', async () => {
      const { host, manager } = await mountManager({
        list: [dbCouncil(), dbCouncil({ id: 'db-2', name: 'Survivor' })],
        nextId: 3
      });

      // The DELETE lands; the refresh that follows it does not.
      global.fetch = vi.fn(async (url, opts = {}) => {
        if ((opts.method || 'GET') === 'DELETE') return makeResponse({ success: true });
        return makeResponse({ error: 'refresh exploded' }, { ok: false, status: 503 });
      });

      rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
      await vi.waitFor(() => expect(manager._busy).toBe(false));
      // Both rows are still on screen — stale, but truthful and recoverable.
      expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(2);
      // …and the two messages never contradict each other.
      expect(host.querySelector('.council-manager__empty')).toBeNull();
    });

    it('clears the banner and shows the empty state once a load succeeds again', async () => {
      const store = { list: [dbCouncil()], nextId: 2 };
      const { host, manager } = await mountManager(store);

      global.fetch = vi.fn(async () => makeResponse({ error: 'boom' }, { ok: false, status: 500 }));
      await manager._fetchAndRender();
      expect(host.querySelector('.council-manager__error')).toBeTruthy();
      expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(1);

      store.list = [];
      installFetch(store);
      await manager._fetchAndRender();

      expect(host.querySelector('.council-manager__error')).toBeNull();
      expect(host.querySelector('.council-manager__empty').textContent).toContain('No councils yet');
    });
  });
});

describe('CouncilManager preview', () => {
  it('toggles the CouncilCard preview on row click', async () => {
    const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    const main = () => rowFor(host, 'db-1').querySelector('.council-manager__row-main');
    expect(host.querySelector('.council-manager__preview')).toBeNull();
    expect(main().getAttribute('aria-expanded')).toBe('false');

    main().click();
    const preview = host.querySelector('.council-manager__preview');
    expect(preview).toBeTruthy();
    expect(preview.querySelector('.council-card-name').textContent.trim()).toBe('Dream Team');
    // The provider map resolved the display names (Claude / Sonnet, not raw ids).
    expect(preview.querySelector('.council-card-reviewer-name').textContent).toContain('Claude / Sonnet');
    expect(main().getAttribute('aria-expanded')).toBe('true');

    main().click();
    expect(host.querySelector('.council-manager__preview')).toBeNull();
  });

  // REGRESSION: a row predating the `type` column holds a level-keyed config.
  // The badge calls it "Advanced" (via `_effectiveType`/`typeBadge`), so the
  // card right below it must use the advanced layout too — the voice layout
  // reads `config.voices`, which such a row does not have, and would render an
  // empty reviewer list under an "Advanced" badge. The rule now lives solely in
  // CouncilCard.render; this pins that the manager still gets it right after
  // dropping its own normalization spread.
  it('previews a legacy untyped council with the advanced layout, matching its badge', async () => {
    const untyped = dbCouncil({ id: 'db-legacy', name: 'Old Council', config: ADVANCED_CONFIG });
    delete untyped.type;
    const { host } = await mountManager({ list: [untyped], nextId: 2 });

    const row = rowFor(host, 'db-legacy');
    expect(row.querySelector('.council-type-badge').textContent).toBe('Advanced');

    row.querySelector('.council-manager__row-main').click();

    const preview = host.querySelector('.council-manager__preview');
    expect(preview.querySelector('.council-card-badge-advanced')).toBeTruthy();
    // The level-keyed config renders rather than collapsing to zero reviewers.
    expect(preview.querySelector('.council-card-level-header').textContent)
      .toContain('Level 1 — Isolation');
    expect(preview.querySelector('.council-card-reviewer-name').textContent)
      .toContain('Claude / Sonnet');
    // The voice layout's level summary must be absent.
    expect(preview.querySelector('.council-card-summary')).toBeNull();
  });

  it('shows only one preview at a time', async () => {
    const { host } = await mountManager({
      list: [dbCouncil(), dbCouncil({ id: 'db-2', name: 'Second' })],
      nextId: 3
    });

    rowFor(host, 'db-1').querySelector('.council-manager__row-main').click();
    rowFor(host, 'db-2').querySelector('.council-manager__row-main').click();

    expect(host.querySelectorAll('.council-manager__preview')).toHaveLength(1);
    expect(rowFor(host, 'db-2').querySelector('.council-manager__preview')).toBeTruthy();
  });

  // The preview used to resolve names from a THIRD private copy of
  // resolveModelDisplay — map-keyed and exact-match — while repo-settings.js's
  // copy was alias-aware and settings.js's read the raw array. Two of the three
  // render CouncilCards on the SAME settings page, and they disagreed.
  describe('display names come from the shared ProviderMap resolver', () => {
    /** A provider the map form DROPS: no models declared. */
    const NO_MODEL_PROVIDER = { id: 'opencode', name: 'OpenCode', models: [] };

    it('delegates to ProviderMap.resolveModelDisplay with the RAW provider array', async () => {
      const spy = vi.spyOn(window.ProviderMap, 'resolveModelDisplay');
      const { host } = await mountManager({
        list: [dbCouncil()],
        nextId: 2,
        providers: PROVIDERS
      });

      rowFor(host, 'db-1').querySelector('.council-manager__row-main').click();

      expect(spy).toHaveBeenCalled();
      // The ARRAY, not `_providers` — buildProviderMap drops model-less
      // providers, and a stored council may still name one.
      expect(Array.isArray(spy.mock.calls[0][0])).toBe(true);
      expect(spy.mock.calls[0].slice(1)).toEqual(['claude', 'sonnet']);
    });

    it('renders the canonical model name for a council that stored an ALIAS', async () => {
      // council-validation.js only requires `voice.model` to be non-empty, so a
      // hand-written ~/.pair-review/councils/*.json can legitimately say
      // "sonnet". The exact-match copy printed "Claude / sonnet" here while
      // repo-settings printed "Claude / Sonnet 4.6" for the same council.
      const aliased = {
        voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }],
        levels: { 1: true, 2: false, 3: false }
      };
      const { host } = await mountManager({
        list: [dbCouncil({ config: aliased })],
        nextId: 2,
        providers: VERSIONED_PROVIDERS
      });

      rowFor(host, 'db-1').querySelector('.council-manager__row-main').click();

      expect(host.querySelector('.council-card-reviewer-name').textContent)
        .toContain('Claude / Sonnet 4.6');
    });

    it('names a provider the provider MAP drops for having no models', async () => {
      const orphaned = {
        voices: [{ provider: 'opencode', model: 'zen', tier: 'balanced' }],
        levels: { 1: true, 2: false, 3: false }
      };
      const { host } = await mountManager({
        list: [dbCouncil({ config: orphaned })],
        nextId: 2,
        providers: [...PROVIDERS, NO_MODEL_PROVIDER]
      });

      rowFor(host, 'db-1').querySelector('.council-manager__row-main').click();

      // Resolving from the map printed the bare id ("opencode") while the
      // "Default for Analysis" card a few pixels above showed "OpenCode".
      expect(host.querySelector('.council-card-reviewer-name').textContent)
        .toContain('OpenCode / zen');
    });
  });

  it('does not toggle the preview when an action button is clicked', async () => {
    const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__export-btn').click();

    expect(host.querySelector('.council-manager__preview')).toBeNull();
  });
});

describe('CouncilManager duplicate', () => {
  it('prefills "<name> (copy)" and POSTs the stored config', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue('Dream Team (copy)');
    const onChange = vi.fn();
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 }, { onChange });

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => {
      expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(2);
    });
    expect(window.textInputDialog.show).toHaveBeenCalledTimes(1);
    expect(window.textInputDialog.show.mock.calls[0][0].value).toBe('Dream Team (copy)');

    const post = fetchMock.mock.calls.find(([u, o]) => u === '/api/councils' && o && o.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({
      name: 'Dream Team (copy)',
      config: VOICE_CONFIG,
      type: 'council'
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('re-prompts on a case-insensitive name collision, keeping the rejected name', async () => {
    window.textInputDialog.show = vi.fn()
      .mockResolvedValueOnce('DREAM TEAM')   // collides with "Dream Team"
      .mockResolvedValueOnce('Dream Team v2');
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(true);
    });
    expect(window.textInputDialog.show).toHaveBeenCalledTimes(2);
    // The bounce re-offers what the user typed rather than losing it.
    expect(window.textInputDialog.show.mock.calls[1][0].value).toBe('DREAM TEAM');
    expect(window.toast.showWarning).toHaveBeenCalledWith('A council with that name already exists.');

    const post = fetchMock.mock.calls.find(([u, o]) => u === '/api/councils' && o && o.method === 'POST');
    expect(JSON.parse(post[1].body).name).toBe('Dream Team v2');
  });

  it('duplicates a file council as a DB council of the same type', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue('From Disk (copy)');
    const { host, fetchMock } = await mountManager({ list: [fileCouncil()], nextId: 2 });

    rowFor(host, 'file:from-disk').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(true);
    });
    const post = fetchMock.mock.calls.find(([u, o]) => u === '/api/councils' && o && o.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({
      name: 'From Disk (copy)',
      config: ADVANCED_CONFIG,
      type: 'advanced'
    });
  });

  it('sends type "advanced" for a legacy untyped council', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue('Old Council (copy)');
    const { host, fetchMock } = await mountManager({
      list: [dbCouncil({ id: 'db-legacy', name: 'Old Council', type: undefined, config: ADVANCED_CONFIG })],
      nextId: 2
    });

    rowFor(host, 'db-legacy').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(true);
    });
    const post = fetchMock.mock.calls.find(([u, o]) => u === '/api/councils' && o && o.method === 'POST');
    expect(JSON.parse(post[1].body).type).toBe('advanced');
  });

  it('does nothing when the name prompt is cancelled', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue(null);
    const onChange = vi.fn();
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 }, { onChange });

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => expect(window.textInputDialog.show).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a double-click opens only one name prompt', async () => {
    // REGRESSION (integration review, nit 6): `_busy` was set AFTER the awaited
    // name prompt, so a second click re-entered the handler, opened a second
    // prompt against the singleton dialog, and left the first click's promise
    // pending forever.
    const gate = deferred();
    window.textInputDialog.show = vi.fn(() => gate.promise);
    const { host, manager, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    const btn = rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn');
    btn.click();
    await vi.waitFor(() => expect(window.textInputDialog.show).toHaveBeenCalledTimes(1));
    // The handler is parked on the prompt. `_duplicate` reaches `dialog.show`
    // synchronously, so a re-entrant click shows up immediately; flush the
    // microtask queue anyway so nothing can arrive after the assertion.
    btn.click();
    btn.click();
    await new Promise(setImmediate);

    expect(window.textInputDialog.show).toHaveBeenCalledTimes(1);
    expect(manager._busy).toBe(true);

    gate.resolve('Dream Team (copy)');
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toHaveLength(1);
    });
    await vi.waitFor(() => expect(manager._busy).toBe(false));
  });

  it('releases the busy guard when the name prompt is cancelled', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue(null);
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => expect(window.textInputDialog.show).toHaveBeenCalledTimes(1));
    // A cancelled prompt must not wedge the row's buttons for the rest of the
    // session — the guard is claimed before the await, so it needs a finally.
    await vi.waitFor(() => expect(manager._busy).toBe(false));

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();
    await vi.waitFor(() => expect(window.textInputDialog.show).toHaveBeenCalledTimes(2));
  });

  it('surfaces the server message and clears _busy after a failed duplicate', async () => {
    // The mirror of the failed-delete test, and the more interesting half: the
    // POST that fails here is exactly the one this feature's headline
    // regression is about (a council posting `voices: []` gets a 400). A
    // regression that moved `this._busy = false` out of the `finally` would
    // wedge every row button for the rest of the session with the suite green.
    window.textInputDialog.show = vi.fn().mockResolvedValue('Dream Team (copy)');
    const onChange = vi.fn();
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 }, { onChange });

    global.fetch = vi.fn(async (url, opts = {}) => {
      if (url === '/api/councils' && (opts.method || 'GET') === 'GET') {
        return makeResponse({ councils: [dbCouncil()] });
      }
      return makeResponse({ error: 'config.voices must be a non-empty array' }, { ok: false, status: 400 });
    });

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
    // The banner carries the SERVER's diagnosis; the toast stays generic.
    expect(host.querySelector('.council-manager__error').textContent)
      .toBe('config.voices must be a non-empty array');
    expect(window.toast.showError).toHaveBeenCalledWith('Failed to duplicate council');
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(manager._busy).toBe(false));
    // The failure did not cost the user the row they were duplicating.
    expect(rowFor(host, 'db-1')).toBeTruthy();
    expect(host.querySelector('.council-manager__empty')).toBeNull();
  });
});

// One multi-step sequence, one order. `_duplicate` and `_delete` used to
// notify BEFORE their re-fetch while `_exitEditor` notified after — so the
// host's own `refreshCouncilRows()` GET raced ours, two parallel
// `GET /api/councils` per mutation, with the host free to paint from whichever
// landed first. All three now go last, which is also the only order that makes
// "onChange fires when the change is visible" true.
describe('CouncilManager onChange ordering', () => {
  /**
   * Mount with an onChange that records what the component looked like AT THE
   * MOMENT it was called — the host's view of the world when it decides to
   * refresh.
   */
  function observingHost() {
    const seen = [];
    const onChange = vi.fn();
    return {
      seen,
      onChange,
      attach: (host, manager) => {
        manager.onChange = () => {
          onChange();
          seen.push({
            rows: host.querySelectorAll('.council-manager__row-wrap').length,
            names: manager._councils.map(c => c.name)
          });
        };
      }
    };
  }

  it('notifies AFTER the refetch on delete, so the host sees the new list', async () => {
    const observer = observingHost();
    const { host, manager } = await mountManager({
      list: [dbCouncil(), dbCouncil({ id: 'db-2', name: 'Survivor' })],
      nextId: 3
    });
    observer.attach(host, manager);

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(observer.onChange).toHaveBeenCalledTimes(1));
    // Notifying first would have shown the host two rows and 'Dream Team'
    // still present, while a second GET was already in flight.
    expect(observer.seen).toEqual([{ rows: 1, names: ['Survivor'] }]);
  });

  it('notifies AFTER the refetch on duplicate, so the host sees the new council', async () => {
    window.textInputDialog.show = vi.fn().mockResolvedValue('Dream Team (copy)');
    const observer = observingHost();
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });
    observer.attach(host, manager);

    rowFor(host, 'db-1').querySelector('.council-manager__duplicate-btn').click();

    await vi.waitFor(() => expect(observer.onChange).toHaveBeenCalledTimes(1));
    expect(observer.seen).toEqual([{ rows: 2, names: ['Dream Team (copy)', 'Dream Team'] }]);
  });

  it('notifies AFTER the refetch on a footer save, matching the other two', async () => {
    const observer = observingHost();
    const store = { list: [dbCouncil()], nextId: 2 };
    const { host, manager } = await mountManager(store);
    observer.attach(host, manager);

    rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();
    await vi.waitFor(() => expect(manager._tab).toBeTruthy());
    await vi.waitFor(() => expect(manager._tab.selectedCouncilId).toBe('db-1'));

    // A council created elsewhere while the editor was open: the host must not
    // be told to refresh until our own list already includes it.
    store.list.unshift(dbCouncil({ id: 'db-9', name: 'Made Elsewhere' }));
    manager._tab._markDirty();
    host.querySelector('.council-manager__save-btn').click();

    await vi.waitFor(() => expect(observer.onChange).toHaveBeenCalledTimes(1));
    expect(observer.seen).toEqual([{ rows: 2, names: ['Made Elsewhere', 'Dream Team'] }]);
  });

  it('issues exactly one GET per mutation from this component', async () => {
    // The paired half of the ordering fix: notifying first put the host's GET
    // in flight next to ours. This component contributes one.
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 });
    const getsBefore = fetchMock.mock.calls
      .filter(([u, o]) => u === '/api/councils' && (!o || !o.method)).length;

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__empty')).toBeTruthy());
    const getsAfter = fetchMock.mock.calls
      .filter(([u, o]) => u === '/api/councils' && (!o || !o.method)).length;
    expect(getsAfter - getsBefore).toBe(1);
  });
});

describe('CouncilManager pre-loaded host data', () => {
  it('uses the providers and config the host page already fetched', async () => {
    // "Pass resolved values down, don't reach up": the settings page has both
    // payloads before it mounts this component, and the page was fetching each
    // of them twice.
    const store = { list: [dbCouncil()], nextId: 2 };
    const fetchMock = installFetch(store);
    const host = mount();
    const manager = new CouncilManager(host, {
      providers: VERSIONED_PROVIDERS,
      appConfig: { default_provider: 'claude', default_model: 'sonnet' }
    });

    await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());

    expect(fetchMock.mock.calls.some(([u]) => u === '/api/providers')).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/config')).toBe(false);
    expect(manager._providerList).toBe(VERSIONED_PROVIDERS);
    // The map form the tabs consume is derived from them, not re-fetched.
    expect(Object.keys(manager._providers)).toEqual(['claude']);

    // And the seeded default pair still resolves through the shared resolver.
    host.querySelector('.council-manager__add-btn').click();
    host.querySelectorAll('.council-manager__chooser-option')[0].click();
    await vi.waitFor(() => expect(manager._tab).toBeTruthy());
    expect(manager._tab._defaultModel).toBe('sonnet-4.6');
  });

  it('still fetches for itself when the host supplies nothing', async () => {
    const { fetchMock } = await mountManager({ list: [], nextId: 1 });

    expect(fetchMock.mock.calls.some(([u]) => u === '/api/providers')).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/config')).toBe(true);
  });
});

describe('CouncilManager delete', () => {
  it('DELETEs on confirm, re-fetches, and fires onChange', async () => {
    const onChange = vi.fn();
    const { host, fetchMock } = await mountManager({
      list: [dbCouncil(), dbCouncil({ id: 'db-2', name: 'Survivor' })],
      nextId: 3
    }, { onChange });

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => {
      expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(1);
    });
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(window.confirmDialog.show.mock.calls[0][0].message).toContain('Dream Team');
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils/db-1' && o && o.method === 'DELETE')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.council-manager__name').textContent).toBe('Survivor');
  });

  it('does NOT delete on any result other than "confirm"', async () => {
    window.confirmDialog.show = vi.fn().mockResolvedValue('cancel');
    const onChange = vi.fn();
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 }, { onChange });

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(window.confirmDialog.show).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'DELETE')).toBe(false);
    expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to native confirm on a page without the styled dialog', async () => {
    delete window.confirmDialog;
    window.confirm = vi.fn(() => false);
    const { host, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([, o]) => o && o.method === 'DELETE')).toBe(false);
    expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(1);
  });

  it('shows an error banner and clears _busy after a failed delete', async () => {
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });
    global.fetch = vi.fn(async (url, opts = {}) => {
      if (url === '/api/councils' && (opts.method || 'GET') === 'GET') {
        return makeResponse({ councils: [dbCouncil()] });
      }
      return makeResponse({ error: 'nope' }, { ok: false, status: 500 });
    });

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
    expect(manager._busy).toBe(false);
    expect(window.toast.showError).toHaveBeenCalledWith('Failed to delete council');
  });

  it('a double-click opens only one confirmation and issues one DELETE', async () => {
    // REGRESSION (integration review, nit 6): `_busy` was set AFTER the awaited
    // confirmation, so a second click re-entered the handler. Only the
    // singleton confirmDialog kept that from becoming a second DELETE.
    const gate = deferred();
    window.confirmDialog.show = vi.fn(() => gate.promise);
    const { host, manager, fetchMock } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    const btn = rowFor(host, 'db-1').querySelector('.council-manager__delete-btn');
    btn.click();
    await vi.waitFor(() => expect(window.confirmDialog.show).toHaveBeenCalledTimes(1));
    // The handler is parked on the confirmation. `_delete` reaches
    // `confirmDialog.show` synchronously, so a re-entrant click shows up
    // immediately; flush the microtask queue anyway.
    btn.click();
    btn.click();
    await new Promise(setImmediate);

    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(manager._busy).toBe(true);

    gate.resolve('confirm');
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([u, o]) => u === '/api/councils/db-1' && o && o.method === 'DELETE')).toHaveLength(1);
    });
    await vi.waitFor(() => expect(manager._busy).toBe(false));
  });

  it('releases the busy guard when the confirmation is declined', async () => {
    window.confirmDialog.show = vi.fn().mockResolvedValue('cancel');
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();

    await vi.waitFor(() => expect(window.confirmDialog.show).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(manager._busy).toBe(false));

    rowFor(host, 'db-1').querySelector('.council-manager__delete-btn').click();
    await vi.waitFor(() => expect(window.confirmDialog.show).toHaveBeenCalledTimes(2));
  });
});

describe('CouncilManager export', () => {
  it('delegates to CouncilDocument.exportCouncilToFile with { name, type, config }', async () => {
    const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__export-btn').click();

    await vi.waitFor(() => expect(window.CouncilDocument.exportCouncilToFile).toHaveBeenCalledTimes(1));
    expect(window.CouncilDocument.exportCouncilToFile).toHaveBeenCalledWith({
      name: 'Dream Team',
      type: 'council',
      config: VOICE_CONFIG
    });
    await vi.waitFor(() => {
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Council exported and copied to clipboard');
    });
  });

  it('carries the description of a file council into the document', async () => {
    const { host } = await mountManager({ list: [fileCouncil()], nextId: 2 });

    rowFor(host, 'file:from-disk').querySelector('.council-manager__export-btn').click();

    await vi.waitFor(() => expect(window.CouncilDocument.exportCouncilToFile).toHaveBeenCalledTimes(1));
    expect(window.CouncilDocument.exportCouncilToFile).toHaveBeenCalledWith({
      name: 'From Disk',
      type: 'advanced',
      config: ADVANCED_CONFIG,
      description: 'Committed to the repo'
    });
  });

  it('reports a failed export without throwing', async () => {
    window.CouncilDocument.exportCouncilToFile = vi.fn(() => { throw new Error('no blob'); });
    const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__export-btn').click();

    await vi.waitFor(() => {
      expect(window.toast.showError).toHaveBeenCalledWith('Failed to export council');
    });
  });
});

describe('CouncilManager editor mount sequence', () => {
  it('Add → type chooser → voice tab, injected in the load-bearing order', async () => {
    const order = recordTabOrder(VoiceCentricConfigTab, TAB_LIFECYCLE);
    const { host, manager } = await mountManager({ list: [], nextId: 1 });

    host.querySelector('.council-manager__add-btn').click();
    const options = host.querySelectorAll('.council-manager__chooser-option');
    expect(options).toHaveLength(2);
    expect(options[0].querySelector('.council-manager__chooser-option-title').textContent).toBe('Council');
    expect(options[1].querySelector('.council-manager__chooser-option-title').textContent).toBe('Advanced');

    options[0].click();

    // The tab is published only when the mount has fully resolved, so waiting
    // for `_tab` waits for loadCouncils() to settle — not merely to be called.
    await vi.waitFor(() => expect(manager._tab).toBeTruthy());
    // setProviders AND setDefaultOrchestration BEFORE reset (reset repaints from
    // _defaultConfig, which reads _defaultProvider/_defaultModel and the provider
    // dropdown data); no setDefaultCouncilId on the Add path.
    expect(order).toEqual(['inject', 'setProviders', 'setDefaultOrchestration', 'reset', 'loadCouncils']);
    expect(host.querySelector('#tab-panel-council')).toBeTruthy();
    expect(manager._tab).toBeInstanceOf(VoiceCentricConfigTab);
    // The WRAPPER is the tab's query root — it plays the modal's role.
    expect(manager._tab.modal).toBe(host.querySelector('.council-manager__tab-host'));
    expect(manager._tab.modal.querySelector('#tab-panel-council')).toBeTruthy();
  });

  it('Add → Advanced mounts the advanced tab and its panel id', async () => {
    const order = recordTabOrder(AdvancedConfigTab, TAB_LIFECYCLE);
    const { host, manager } = await mountManager({ list: [], nextId: 1 });

    host.querySelector('.council-manager__add-btn').click();
    host.querySelectorAll('.council-manager__chooser-option')[1].click();

    await vi.waitFor(() => expect(manager._tab).toBeTruthy());
    expect(order).toEqual(['inject', 'setProviders', 'setDefaultOrchestration', 'reset', 'loadCouncils']);
    expect(host.querySelector('#tab-panel-advanced')).toBeTruthy();
    expect(manager._tab).toBeInstanceOf(AdvancedConfigTab);
  });

  it('Edit applies setDefaultCouncilId before loadCouncils', async () => {
    const order = recordTabOrder(VoiceCentricConfigTab, TAB_LIFECYCLE);
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

    // Wait for the selector render at the END of loadCouncils(), not merely for
    // the call to have started.
    await vi.waitFor(() => expect(manager._tab && manager._tab.selectedCouncilId).toBe('db-1'));
    // The pending default id is applied when the selector renders, so it MUST
    // precede loadCouncils().
    expect(order).toEqual([
      'inject', 'setProviders', 'setDefaultOrchestration', 'reset', 'setDefaultCouncilId', 'loadCouncils'
    ]);
    expect(host.querySelector('#vc-council-selector').value).toBe('db-1');
  });

  it('Edit picks the advanced tab for a legacy untyped council', async () => {
    const order = recordTabOrder(AdvancedConfigTab, TAB_LIFECYCLE);
    const { host, manager } = await mountManager({
      list: [dbCouncil({ id: 'db-legacy', name: 'Old Council', type: undefined, config: ADVANCED_CONFIG })],
      nextId: 2
    });

    rowFor(host, 'db-legacy').querySelector('.council-manager__edit-btn').click();

    // AdvancedConfigTab.loadCouncils keeps `!c.type || c.type === 'advanced'`,
    // so the legacy row really is selectable there.
    await vi.waitFor(() => expect(manager._tab && manager._tab.selectedCouncilId).toBe('db-legacy'));
    expect(order).toEqual([
      'inject', 'setProviders', 'setDefaultOrchestration', 'reset', 'setDefaultCouncilId', 'loadCouncils'
    ]);
    expect(manager._tab).toBeInstanceOf(AdvancedConfigTab);
  });

  it('falls back to the list when the tab class is not loaded on the page', async () => {
    const real = window.VoiceCentricConfigTab;
    try {
      delete window.VoiceCentricConfigTab;
      const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
      expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy();
      expect(manager._tab).toBeNull();
    } finally {
      window.VoiceCentricConfigTab = real;
    }
  });

  it('recovers to the list when mounting the tab throws', async () => {
    const real = window.VoiceCentricConfigTab;
    try {
      window.VoiceCentricConfigTab = class {
        inject() { throw new Error('boom'); }
      };
      const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      await vi.waitFor(() => {
        expect(window.toast.showError).toHaveBeenCalledWith('Failed to open the council editor');
      });
      expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy();
      expect(manager._tab).toBeNull();
    } finally {
      window.VoiceCentricConfigTab = real;
    }
  });

  it('seeds a new council with a provider/model pair that really exists', async () => {
    // REGRESSION: the tabs' own fallback pair is claude/'sonnet', and 'sonnet'
    // is an alias — not an <option> value. Assigning it to the model <select>
    // selects nothing, `_readConfigFromUI` drops reviewer rows that lack a
    // model, and POST /api/councils then 400s on `voices: []`. CouncilManager
    // must resolve the page's configured default pair (the shared resolver
    // matches aliases) and hand it to setDefaultOrchestration BEFORE reset().
    const { host, manager } = await mountManager({
      list: [],
      nextId: 1,
      providers: VERSIONED_PROVIDERS,
      config: { default_provider: 'claude', default_model: 'sonnet' }
    });

    host.querySelector('.council-manager__add-btn').click();
    host.querySelectorAll('.council-manager__chooser-option')[0].click();

    await vi.waitFor(() => expect(manager._tab && manager._tab._injected).toBe(true));

    expect(manager._tab._defaultProvider).toBe('claude');
    expect(manager._tab._defaultModel).toBe('sonnet-4.6');
    expect(host.querySelector('#vc-reviewer-list .voice-model').value).toBe('sonnet-4.6');

    const config = manager._tab._readConfigFromUI();
    expect(config.voices).toHaveLength(1);
    expect(config.voices[0]).toMatchObject({ provider: 'claude', model: 'sonnet-4.6' });
  });

  it('falls back to the provider default when the configured model is unknown', async () => {
    const { host, manager } = await mountManager({
      list: [],
      nextId: 1,
      providers: VERSIONED_PROVIDERS,
      config: { default_provider: 'claude', default_model: 'not-a-real-model' }
    });

    host.querySelector('.council-manager__add-btn').click();
    host.querySelectorAll('.council-manager__chooser-option')[1].click();

    await vi.waitFor(() => expect(manager._tab && manager._tab._injected).toBe(true));

    expect(manager._tab._defaultModel).toBe('sonnet-4.6');
    expect(manager._tab._readConfigFromUI().levels['1'].voices[0])
      .toMatchObject({ provider: 'claude', model: 'sonnet-4.6' });
  });

  it('leaves the tab default alone when the shared resolver is not on the page', async () => {
    const resolver = window.resolveProviderModelPair;
    const scopes = window.buildProviderModelScopes;
    try {
      delete window.resolveProviderModelPair;
      delete window.buildProviderModelScopes;
      const { host, manager } = await mountManager({ list: [], nextId: 1 });

      host.querySelector('.council-manager__add-btn').click();
      host.querySelectorAll('.council-manager__chooser-option')[0].click();

      await vi.waitFor(() => expect(manager._tab && manager._tab._injected).toBe(true));
      // setDefaultOrchestration(null, null) → the tab keeps its own fallback.
      expect(manager._tab._defaultProvider).toBe('claude');
      expect(manager._tab._defaultModel).toBe('sonnet');
    } finally {
      window.resolveProviderModelPair = resolver;
      window.buildProviderModelScopes = scopes;
    }
  });

  it('survives a failed /api/config fetch during the initial mount', async () => {
    // The failure is armed BEFORE construction, so `/api/config` rejects inside
    // the constructor's `_init()` Promise.all — the path that actually runs in
    // production. Driving `_loadAppConfig()` by hand afterwards would leave an
    // unhandled rejection during first paint undetected.
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2, configFails: true });

    // mountManager already waited for `.council-manager__list-wrap`, so _init()
    // resolved and painted despite the failed fetch. The list is real, not the
    // loading or error state.
    expect(host.querySelector('.council-manager__error')).toBeNull();
    expect(rowFor(host, 'db-1')).toBeTruthy();
    expect(manager._appConfig).toEqual({});

    host.querySelector('.council-manager__add-btn').click();
    host.querySelectorAll('.council-manager__chooser-option')[0].click();

    await vi.waitFor(() => expect(manager._tab && manager._tab._injected).toBe(true));
    // No config scope → the resolver still derives claude's default model.
    expect(manager._tab._defaultModel).toBe('sonnet');
  });

  it('constructs the tab with { hosted: true } and gets no in-panel write buttons', async () => {
    const real = window.VoiceCentricConfigTab;
    const seen = [];
    try {
      window.VoiceCentricConfigTab = class extends real {
        constructor(root, options) {
          super(root, options);
          seen.push(options);
        }
      };
      const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();
      await vi.waitFor(() => expect(manager._tab).toBeTruthy());

      expect(seen).toEqual([{ hosted: true }]);
      // The consequence that matters: the tab's own Save / Save As / Delete row
      // is gone, so CouncilManager's footer is the ONLY write surface in editor
      // mode — which is what lets `onChange` drop its list-diff heuristic.
      expect(host.querySelector('#vc-council-save-btn')).toBeNull();
      expect(host.querySelector('#vc-council-save-as-btn')).toBeNull();
      expect(host.querySelector('#vc-council-delete-btn')).toBeNull();
      // The council <select> itself must survive: it is where
      // _renderCouncilSelector applies the pending default id, and dropping it
      // would turn every Edit into a Create.
      expect(host.querySelector('#vc-council-selector')).toBeTruthy();
      expect(manager._tab.selectedCouncilId).toBe('db-1');
    } finally {
      window.VoiceCentricConfigTab = real;
    }
  });

  // The footer Save used to be wired and live BEFORE `await tab.loadCouncils()`
  // resolved. In that window `tab.selectedCouncilId` is still null (the pending
  // default id is only applied by _renderCouncilSelector, at the END of the
  // load) and the UI still shows reset() defaults — so a Save fell through
  // council-crud's Save As branch and POSTed a BRAND NEW council built from
  // default config, under a header reading "Edit council". Nothing reported it:
  // the save "succeeded", the editor exited and onChange fired.
  describe('the mount window', () => {
    /** Park the tab's loadCouncils on a gate, keeping the real behavior. */
    function gateLoadCouncils(TabClass) {
      const gate = deferred();
      const original = TabClass.prototype.loadCouncils;
      const settled = { done: false };
      vi.spyOn(TabClass.prototype, 'loadCouncils').mockImplementation(async function (...args) {
        await gate.promise;
        const result = await original.apply(this, args);
        settled.done = true;
        return result;
      });
      return { gate, settled };
    }

    it('renders the footer Save disabled, and inert, until the mount resolves', async () => {
      const { gate, settled } = gateLoadCouncils(VoiceCentricConfigTab);
      const onChange = vi.fn();
      const { host, manager, fetchMock } = await mountManager(
        { list: [dbCouncil()], nextId: 2 }, { onChange }
      );

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      // The editor chrome is up, the tab is not published yet.
      const saveBtn = host.querySelector('.council-manager__save-btn');
      expect(saveBtn).toBeTruthy();
      expect(saveBtn.disabled).toBe(true);
      expect(manager._tab).toBeNull();

      // Visible AND safe: force the handler past the disabled attribute.
      await manager._saveFromEditor();
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(false);
      expect(window.textInputDialog.show).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(host.querySelector('.council-manager__editor-header').textContent).toBe('Edit council');

      gate.resolve();
      await vi.waitFor(() => expect(manager._tab).toBeTruthy());
      expect(settled.done).toBe(true);
      expect(host.querySelector('.council-manager__save-btn').disabled).toBe(false);
      expect(manager._tab.selectedCouncilId).toBe('db-1');
    });

    it('tears the editor down when the tab reports a failed council load', async () => {
      // The quiet permanent variant: loadCouncils swallows its own fetch error,
      // so the promise resolves cleanly and the editor used to sit there
      // labelled "Edit council" in the no-selection state forever — every Save
      // from then on forking a copy instead of updating.
      vi.spyOn(VoiceCentricConfigTab.prototype, 'loadCouncils').mockResolvedValue(false);
      const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      await vi.waitFor(() => {
        expect(window.toast.showError).toHaveBeenCalledWith('Failed to open the council editor');
      });
      expect(manager._tab).toBeNull();
      expect(host.querySelector('#tab-panel-council')).toBeNull();
      expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy();
    });

    it('refuses to open an editor for a council the tab could not select', async () => {
      // The OTHER door into the same Edit-becomes-Create failure, and the one a
      // second browser tab can open at any time: the council is deleted between
      // the list paint that drew the Edit button and the tab's own load. The
      // fetch SUCCEEDS, so the boolean above says nothing;
      // `_renderCouncilSelector` consumes the pending id without finding a
      // match, leaving `selectedCouncilId` null under an "Edit council" header,
      // and the next Save forks a new council through the name prompt.
      const store = { list: [dbCouncil()], nextId: 2 };
      const { host, manager } = await mountManager(store);

      // The row is on screen from the first paint; the council is gone by the
      // time the editor asks for it.
      store.list = [];
      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
      expect(manager._tab).toBeNull();
      expect(host.querySelector('#tab-panel-council')).toBeNull();
      expect(window.toast.showError).toHaveBeenCalledWith('Failed to open the council editor');
      // The banner says why, in words the user can act on.
      expect(host.querySelector('.council-manager__error').textContent)
        .toBe('That council is no longer available.');
    });

    it('keeps an internal exception out of the banner', async () => {
      // Only the messages _openEditor authors reach the UI; a tab class that
      // throws its own error is a console matter.
      const real = window.VoiceCentricConfigTab;
      try {
        window.VoiceCentricConfigTab = class {
          inject() { throw new Error('boom'); }
        };
        const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

        rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

        await vi.waitFor(() => {
          expect(window.toast.showError).toHaveBeenCalledWith('Failed to open the council editor');
        });
        expect(host.querySelector('.council-manager__error')).toBeNull();
      } finally {
        window.VoiceCentricConfigTab = real;
      }
    });

    it('names the reason in the banner when the council load fails', async () => {
      vi.spyOn(VoiceCentricConfigTab.prototype, 'loadCouncils').mockResolvedValue(false);
      const { host } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__error')).toBeTruthy());
      expect(host.querySelector('.council-manager__error').textContent)
        .toBe('Could not load your councils. Please try again.');
    });

    it('does not publish a tab whose editor was left before the mount resolved', async () => {
      const { gate, settled } = gateLoadCouncils(VoiceCentricConfigTab);
      const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

      rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();
      expect(manager._tab).toBeNull();

      // Back is live during the mount (there is nothing dirty to lose yet).
      host.querySelector('.council-manager__back-btn').click();
      await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());

      gate.resolve();
      await vi.waitFor(() => expect(settled.done).toBe(true));
      await new Promise(setImmediate);

      // The abandoned mount must not install itself over the list.
      expect(manager._tab).toBeNull();
      expect(manager._mode).toBe('list');
      expect(host.querySelector('#tab-panel-council')).toBeNull();
    });
  });

  it('Cancel on the type chooser returns to the list without mounting a tab', async () => {
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    host.querySelector('.council-manager__add-btn').click();
    host.querySelector('.council-manager__cancel-btn').click();

    expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy();
    expect(manager._tab).toBeNull();
  });
});

describe('CouncilManager editor footer', () => {
  /** Open the editor on the seeded DB council and wait for the tab to settle. */
  async function openEditor(store, options) {
    const mounted = await mountManager(store, options);
    rowFor(mounted.host, 'db-1').querySelector('.council-manager__edit-btn').click();
    await vi.waitFor(() => expect(mounted.manager._tab).toBeTruthy());
    await vi.waitFor(() => expect(mounted.manager._tab.selectedCouncilId).toBe('db-1'));
    return mounted;
  }

  it('Save calls the tab\'s _saveCouncil, PUTs, returns to the list, and fires onChange', async () => {
    const onChange = vi.fn();
    const { host, manager, fetchMock } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

    const saveSpy = vi.spyOn(manager._tab, '_saveCouncil');
    manager._tab._markDirty();
    host.querySelector('.council-manager__save-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils/db-1' && o && o.method === 'PUT')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(manager._tab).toBeNull();
  });

  it('stays in the editor when the save did not go through', async () => {
    const onChange = vi.fn();
    const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

    // A refused save (invalid config, cancelled Save As prompt) leaves the tab
    // dirty — the edits must not be discarded by returning to the list.
    manager._tab._markDirty();
    vi.spyOn(manager._tab, '_saveCouncil').mockResolvedValue(false);
    host.querySelector('.council-manager__save-btn').click();

    await vi.waitFor(() => expect(manager._tab._saveCouncil).toHaveBeenCalledTimes(1));
    // Settle on the guard, not on the call: `_busy` is held for the whole of
    // _saveFromEditor (exit included), so a regression that wrongly proceeded
    // into _exitEditor is still in flight when _saveCouncil resolves and the
    // assertions below would pass against a doomed editor.
    await vi.waitFor(() => expect(manager._busy).toBe(false));
    expect(host.querySelector('#tab-panel-council')).toBeTruthy();
    expect(host.querySelector('.council-manager__list-wrap')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  // REGRESSION (integration review, defect 2): success used to be inferred from
  // `tab.isDirty` going false. Every refusal path in council-crud.js returns
  // without touching `_markClean`, and a freshly `reset()` editor is ALREADY
  // clean — so a Save that wrote nothing read as a Save that worked: the
  // manager exited to the list with `mutated: true` and fired onChange, making
  // the host page refresh its Default-for-Analysis picker for a council that
  // does not exist. `_saveCouncil` now reports the outcome explicitly.
  describe('a Save that writes nothing on a CLEAN editor', () => {
    it('Add → Save → cancel the name prompt stays in the editor', async () => {
      window.textInputDialog.show = vi.fn().mockResolvedValue(null);
      const onChange = vi.fn();
      const { host, manager, fetchMock } = await mountManager({ list: [], nextId: 1 }, { onChange });

      host.querySelector('.council-manager__add-btn').click();
      host.querySelectorAll('.council-manager__chooser-option')[0].click();
      await vi.waitFor(() => expect(manager._tab && manager._tab._injected).toBe(true));

      // Nothing edited: the brand-new editor is clean, and there is no
      // selectedCouncilId, so Save falls through to the Save As name prompt.
      expect(manager._tab.isDirty).toBe(false);
      host.querySelector('.council-manager__save-btn').click();

      await vi.waitFor(() => expect(window.textInputDialog.show).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(manager._busy).toBe(false));

      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils' && o && o.method === 'POST')).toBe(false);
      expect(host.querySelector('#tab-panel-council')).toBeTruthy();
      expect(host.querySelector('.council-manager__list-wrap')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('Edit → Save → PUT fails stays in the editor', async () => {
      const onChange = vi.fn();
      const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

      // Untouched editor (clean) + a PUT the server refuses. council-crud.js
      // swallows the failure into an error toast, so nothing but the return
      // value distinguishes it from a successful save.
      expect(manager._tab.isDirty).toBe(false);
      global.fetch = vi.fn(async (url, opts = {}) => {
        if (url === '/api/councils' && (opts.method || 'GET') === 'GET') {
          return makeResponse({ councils: [dbCouncil()] });
        }
        return makeResponse(
          { error: 'config.voices must be a non-empty array' },
          { ok: false, status: 400 }
        );
      });

      host.querySelector('.council-manager__save-btn').click();

      // The SERVER's diagnosis reaches the user, not a fixed string — on this
      // page the toast is the only feedback there is.
      await vi.waitFor(() => expect(window.toast.showError)
        .toHaveBeenCalledWith('config.voices must be a non-empty array'));
      // `_busy` is held across the whole save, exit included, so waiting for it
      // to clear is waiting for _saveFromEditor to have SETTLED — not merely
      // for _saveCouncil to have been called. A regression that wrongly
      // proceeded into _exitEditor would still be mid-refetch otherwise.
      await vi.waitFor(() => expect(manager._busy).toBe(false));

      expect(host.querySelector('#tab-panel-council')).toBeTruthy();
      expect(host.querySelector('.council-manager__list-wrap')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('Edit → Save → PUT succeeds still exits and notifies', async () => {
      // The other half of the contract: a clean editor whose PUT DOES land is
      // still a real write, so it must exit exactly as before.
      const onChange = vi.fn();
      const { host, manager, fetchMock } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

      expect(manager._tab.isDirty).toBe(false);
      host.querySelector('.council-manager__save-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/councils/db-1' && o && o.method === 'PUT')).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  // `_saveFromEditor`, `_duplicate` and `_delete` all claimed `_busy` before
  // their first await; `_backFromEditor` did not, and the footer buttons were
  // never disabled. So Back stayed live for the whole duration of a save:
  // "Discard unsaved changes?" popped over a POST that was already committing,
  // and answering Discard ran `_exitEditor()` immediately AND again when the
  // save resolved — two re-fetches and two onChange notifications for one write.
  describe('Back and Save cannot overlap', () => {
    it('holds the guard, disables both footer buttons, and refuses Back for the whole save', async () => {
      const gate = deferred();
      const onChange = vi.fn();
      const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

      manager._tab._markDirty();
      vi.spyOn(manager._tab, '_saveCouncil').mockImplementation(() => gate.promise);
      host.querySelector('.council-manager__save-btn').click();
      await vi.waitFor(() => expect(manager._busy).toBe(true));

      // Visible half: neither footer button is clickable mid-write.
      expect(host.querySelector('.council-manager__save-btn').disabled).toBe(true);
      expect(host.querySelector('.council-manager__back-btn').disabled).toBe(true);
      // Guard half: the handler refuses even when driven directly.
      await manager._backFromEditor();
      expect(window.confirmDialog.show).not.toHaveBeenCalled();
      expect(host.querySelector('#tab-panel-council')).toBeTruthy();

      gate.resolve(true);
      await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
      await vi.waitFor(() => expect(manager._busy).toBe(false));
      // Exactly one exit, so exactly one notification.
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('keeps the guard claimed across the post-save exit, not just the write', async () => {
      // The `finally` used to release `_busy` BEFORE awaiting `_exitEditor`,
      // leaving the window open across the exit's own re-fetch.
      const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 });

      let busyOnEntry = null;
      const realExit = manager._exitEditor.bind(manager);
      vi.spyOn(manager, '_exitEditor').mockImplementation(async (options) => {
        busyOnEntry = manager._busy;
        return realExit(options);
      });

      manager._tab._markDirty();
      host.querySelector('.council-manager__save-btn').click();

      await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
      expect(busyOnEntry).toBe(true);
      expect(manager._busy).toBe(false);
    });

    it('a save whose editor was replaced mid-flight notifies but spares the new editor', async () => {
      // `_saveFromEditor` captures `const tab = this._tab` and its continuation
      // runs after an await. Without re-validating that reference, the pending
      // continuation tore down a DIFFERENT, freshly-opened editor.
      const gate = deferred();
      const onChange = vi.fn();
      const { host, manager } = await openEditor({
        list: [dbCouncil(), dbCouncil({ id: 'db-2', name: 'Second' })],
        nextId: 3
      }, { onChange });

      const firstTab = manager._tab;
      firstTab._markDirty();
      vi.spyOn(firstTab, '_saveCouncil').mockImplementation(() => gate.promise);
      host.querySelector('.council-manager__save-btn').click();
      await vi.waitFor(() => expect(manager._busy).toBe(true));

      // A second editor opens over the top (the manager's own entry point; the
      // footer Back is guarded, so this is the remaining route).
      await manager._openEditor({ type: 'council', councilId: 'db-2' });
      await vi.waitFor(() => expect(manager._tab).toBeTruthy());
      expect(manager._tab).not.toBe(firstTab);

      gate.resolve(true);
      await vi.waitFor(() => expect(manager._busy).toBe(false));

      // The editor on screen is untouched: still mounted, still the new one.
      expect(host.querySelector('#tab-panel-council')).toBeTruthy();
      expect(manager._tab.selectedCouncilId).toBe('db-2');
      expect(host.querySelector('.council-manager__list-wrap')).toBeNull();
      // The write DID land, so the host still hears about it — exactly once.
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  it('Back confirms before discarding unsaved changes and stays put on cancel', async () => {
    window.confirmDialog.show = vi.fn().mockResolvedValue('cancel');
    const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 });

    manager._tab._markDirty();
    host.querySelector('.council-manager__back-btn').click();

    await vi.waitFor(() => expect(window.confirmDialog.show).toHaveBeenCalledTimes(1));
    expect(window.confirmDialog.show.mock.calls[0][0].message).toBe('Discard unsaved changes?');
    expect(host.querySelector('#tab-panel-council')).toBeTruthy();
    expect(manager._tab).toBeTruthy();
  });

  it('Back leaves the editor and re-fetches the list on confirm', async () => {
    const store = { list: [dbCouncil()], nextId: 2 };
    const { host, manager, fetchMock } = await openEditor(store);

    manager._tab._markDirty();
    // A council created elsewhere while the editor was open shows up on the way
    // back, because leaving re-fetches.
    store.list.unshift(dbCouncil({ id: 'db-9', name: 'Made Elsewhere' }));
    const getsBefore = fetchMock.mock.calls.filter(([u, o]) => u === '/api/councils' && (!o || !o.method)).length;

    host.querySelector('.council-manager__back-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('.council-manager__row-wrap')).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([u, o]) => u === '/api/councils' && (!o || !o.method)).length
    ).toBeGreaterThan(getsBefore);
    expect(manager._tab).toBeNull();
  });

  it('Back on a clean editor leaves immediately without a confirmation, and does NOT notify', async () => {
    // GUARDS THE NEGATIVE HALF OF THE onChange CONTRACT. Since the hosted tab
    // stopped rendering its own write buttons, `_exitEditor` notifies ONLY on an
    // explicit `mutated: true` — the old `_listSignature()` diff is gone. Drop
    // the `if (mutated)` and this suite would otherwise stay green while every
    // Back click made the settings page re-fetch /api/councils and repaint its
    // Default-for-Analysis picker for nothing.
    const onChange = vi.fn();
    const { host, manager } = await openEditor({ list: [dbCouncil()], nextId: 2 }, { onChange });

    expect(manager._tab.isDirty).toBe(false);
    host.querySelector('.council-manager__back-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
    expect(window.confirmDialog.show).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not notify when the list changed under the editor without a save we own', async () => {
    // The inference this replaces fingerprinted {id, name, updated_at} and
    // notified on any difference. It was there for the tab's OWN in-panel
    // Save As / Delete row, which no longer renders when hosted — and it was
    // unreliable anyway (SQLite's one-second `updated_at` hid same-second
    // in-place edits). A list that moved for some other reason is not our
    // mutation to report.
    const onChange = vi.fn();
    const store = { list: [dbCouncil()], nextId: 2 };
    const { host, manager } = await openEditor(store, { onChange });

    store.list = [];
    host.querySelector('.council-manager__back-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.council-manager__list-wrap')).toBeTruthy());
    expect(manager._tab).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // The heuristic itself is gone, not merely unused.
    expect(manager._listSignature).toBeUndefined();
  });
});

describe('CouncilManager.destroy', () => {
  it('clears the container and drops the hosted tab', async () => {
    const { host, manager } = await mountManager({ list: [dbCouncil()], nextId: 2 });

    rowFor(host, 'db-1').querySelector('.council-manager__edit-btn').click();
    await vi.waitFor(() => expect(manager._tab).toBeTruthy());

    manager.destroy();

    expect(host.innerHTML).toBe('');
    expect(manager._tab).toBeNull();
    expect(manager._docListeners).toEqual([]);
    expect(document.querySelector('#tab-panel-council')).toBeNull();
  });

  it('removes every tracked document listener', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { manager } = await mountManager({ list: [], nextId: 1 });

    const handler = () => {};
    manager._docListeners.push({ target: document, type: 'keydown', handler });
    manager.destroy();

    expect(removeSpy).toHaveBeenCalledWith('keydown', handler);
    expect(manager._docListeners).toEqual([]);
  });
});
