// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of the vendor contract harness. Exposes `window.H`.
 *
 * H is a thin, app-shaped driver around the REAL @pierre/diffs bundle: it
 * builds items from the deterministic workload, creates a CodeView with stable
 * callback wrappers, records every vendor callback in an event log, and offers
 * measurement helpers. It contains no model of the vendor: every answer a spec
 * asserts on is read from the vendor's own objects or from the DOM.
 *
 * Load order (done by contract-test.js `open()`): this file, then the vendor
 * bundle (window.PierreDiffs), then fixtures/workload.js (window.ContractWorkload).
 */
(() => {
  const CALLBACK_KEYS = [
    'renderCustomHeader', 'renderHeaderPrefix', 'renderHeaderFilenameSuffix', 'renderHeaderMetadata',
    'renderAnnotation', 'renderGutterUtility', 'onPostRender', 'onGutterUtilityClick',
    'onLineClick', 'onLineNumberClick', 'onLineEnter', 'onLineLeave',
    'onTokenClick', 'onTokenEnter', 'onTokenLeave',
    'onLineSelected', 'onLineSelectionStart', 'onLineSelectionChange', 'onLineSelectionEnd',
    'onSelectedLinesChange', 'renderCodeViewHeader', 'renderCodeViewFooter', 'loadDiffFiles',
    'onWorkerError', 'onHunkExpand',
  ];

  const H = {
    t0: performance.now(),
    events: [],           // { t, k, ... }
    counts: {},           // callback name -> number of invocations
    hooks: {},            // callback name -> implementation (specs override freely)
    wrappers: {},         // stable wrapper functions handed to CodeView
    quiet: new Set(['onLineEnter', 'onLineLeave', 'onTokenEnter', 'onTokenLeave', 'renderGutterUtility']),
    annEls: new Map(),    // annotation key -> cached element
    headerEls: new Map(), // item id -> cached header element
    gutterEls: new Map(), // item id -> cached gutter utility element
    instances: new Map(), // item id -> vendor instance, captured from onPostRender
    cacheAnnotationEls: true,
    cacheHeaderEls: true,
    workload: null,
    fileDiffs: null,
    items: null,
    cv: null,
    pool: null,
    options: null,
    root: null,
  };
  window.H = H;

  H.log = (k, data = {}) => { H.events.push({ t: +(performance.now() - H.t0).toFixed(1), k, ...data }); };
  H.clearEvents = () => { H.events.length = 0; H.counts = {}; };
  H.eventsOf = (k) => H.events.filter((e) => e.k === k);

  /** JSON-safe summary of a callback argument. */
  function ser(v, depth = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>`;
    if (v instanceof Event) return `[Event ${v.type}]`;
    if (typeof v === 'function') return '[fn]';
    if (depth > 2) return '[…]';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => ser(x, depth + 1));
    const out = {};
    for (const key of Object.keys(v)) {
      if (['fileDiff', 'file', 'instance', 'item', 'annotations', 'hunks', 'additionLines', 'deletionLines'].includes(key)) { out[key] = '[omitted]'; continue; }
      out[key] = ser(v[key], depth + 1);
    }
    return out;
  }
  H.ser = ser;

  for (const key of CALLBACK_KEYS) {
    H.wrappers[key] = function (...args) {
      H.counts[key] = (H.counts[key] || 0) + 1;
      const ctx = args[args.length - 1];
      const id = ctx && typeof ctx === 'object' && ctx.item ? ctx.item.id : undefined;
      if (key === 'onPostRender' && id !== undefined && ctx.instance) H.instances.set(id, ctx.instance);
      if (!H.quiet.has(key)) {
        const entry = { id, argc: args.length };
        if (key === 'onPostRender') {
          entry.phase = args[2];
          entry.sameEl = ctx ? ctx.element === args[0] : null;
          entry.connected = !!(args[0] && args[0].isConnected);
        } else if (key === 'renderAnnotation') {
          entry.ann = ser({ side: args[0].side, lineNumber: args[0].lineNumber, key: args[0].metadata && args[0].metadata.key });
        } else if (key.startsWith('on')) {
          entry.payload = ser(args[0]);
        }
        H.log(key, entry);
      }
      const impl = H.hooks[key];
      return impl ? impl.apply(this, args) : undefined;
    };
  }

  // ---- default hook implementations (app-like) ----
  H.hooks.renderAnnotation = (annotation, fileOrDiff, ctx) => {
    const meta = annotation.metadata || {};
    const key = meta.key || `${ctx && ctx.item ? ctx.item.id : '?'}:${annotation.side || ''}:${annotation.lineNumber}`;
    if (H.cacheAnnotationEls && H.annEls.has(key)) return H.annEls.get(key);
    const el = document.createElement('div');
    el.className = 'ann';
    el.dataset.annKey = key;
    if (meta.kind === 'form') {
      const ta = document.createElement('textarea');
      ta.rows = meta.rows || 3;
      ta.dataset.annKey = key;
      el.appendChild(ta);
    } else if (meta.kind === 'button') {
      const button = document.createElement('button');
      button.className = 'ann-button';
      button.textContent = meta.text || 'button';
      button.addEventListener('click', () => H.log('annButtonClick', { key }));
      el.appendChild(button);
    } else if (meta.kind === 'zone') {
      // Empty by default, like an empty file-comments zone.
      el.className = 'zone';
    } else {
      el.textContent = meta.text || `annotation ${key}`;
      if (meta.height) el.style.height = meta.height + 'px';
    }
    H.annEls.set(key, el);
    return el;
  };

  H.hooks.renderCustomHeader = (fileOrDiff, ctx) => {
    const id = ctx.item.id;
    if (H.cacheHeaderEls && H.headerEls.has(id)) return H.headerEls.get(id);
    const wrap = document.createElement('div');
    wrap.dataset.phId = id;
    const row = document.createElement('div');
    row.className = 'ph';
    const toggle = document.createElement('button');
    toggle.className = 'ph-toggle';
    toggle.textContent = 'v';
    toggle.addEventListener('click', () => H.toggleCollapsed(id));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ph-viewed';
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = fileOrDiff.name;
    row.append(toggle, cb, path);
    wrap.appendChild(row);
    H.headerEls.set(id, wrap);
    return wrap;
  };

  // One element per item: an element can live in one host only.
  H.hooks.renderGutterUtility = (getHoveredLine, ctx) => {
    const id = ctx.item.id;
    if (!H.gutterEls.has(id)) {
      const el = document.createElement('div');
      el.className = 'gut';
      const comment = document.createElement('button');
      comment.textContent = '+';
      comment.className = 'gut-comment';
      const chat = document.createElement('button');
      chat.textContent = '?';
      chat.className = 'gut-chat';
      el.append(comment, chat);
      comment.addEventListener('click', () => H.log('gutterButtonClick', { id, hovered: ser(getHoveredLine()) }));
      H.gutterEls.set(id, el);
    }
    return H.gutterEls.get(id);
  };

  // ---- workload and items ----
  H.loadWorkload = () => {
    if (!H.workload) H.workload = window.ContractWorkload.build();
    return { patchBytes: H.workload.patch.length, files: H.workload.order.length };
  };

  /** Parse the workload patch with the real vendor parser. opts: { cacheKeyPrefix } */
  H.parse = (opts = {}) => {
    const parsed = window.PierreDiffs.parsePatchFiles(
      H.workload.patch,
      opts.cacheKeyPrefix ? { cacheKeyPrefix: opts.cacheKeyPrefix } : undefined
    );
    H.fileDiffs = parsed.flatMap((p) => p.files);
    return { patches: parsed.length, files: H.fileDiffs.length };
  };

  /**
   * Build items in patch order.
   * opts: { only: [names], exclude: [names], limit, plain: 'none'|'end'|'interleave' }
   * `plain` defaults to 'none'; 'end' appends the two plain `type: 'file'` items.
   */
  H.buildItems = (opts = {}) => {
    let diffs = H.fileDiffs;
    if (opts.only) diffs = opts.only.map((name) => diffs.find((d) => d.name === name)).filter(Boolean);
    if (opts.exclude) diffs = diffs.filter((d) => !opts.exclude.includes(d.name));
    if (opts.limit) diffs = diffs.slice(0, opts.limit);
    const items = diffs.map((fileDiff) => ({ id: fileDiff.name, type: 'diff', fileDiff, annotations: [], version: 0 }));
    const plain = (!opts.plain || opts.plain === 'none' ? [] : H.workload.plain).map((f) => ({
      id: `file:${f.name}`, type: 'file', file: { name: f.name, contents: f.contents }, annotations: [], version: 0,
    }));
    if (opts.plain === 'interleave') { items.splice(3, 0, plain[0]); items.splice(20, 0, plain[1]); }
    else items.push(...plain);
    H.items = items;
    return items.map((i) => ({
      id: i.id, type: i.type,
      diffType: i.fileDiff && i.fileDiff.type,
      hunks: i.fileDiff && i.fileDiff.hunks.length,
      isPartial: i.fileDiff && i.fileDiff.isPartial,
    }));
  };

  /** A plain `type: 'file'` item that is not part of the workload, for list-mutation specs. */
  H.makeFileItem = (id, lineCount = 40) => ({
    id,
    type: 'file',
    file: { name: `${id}.txt`, contents: `${Array.from({ length: lineCount }, (_, i) => `${id} line ${i + 1}`).join('\n')}\n` },
    annotations: [],
    version: 0,
  });

  /** Full old/new file objects for a workload path, in the shape hydratePartialDiff takes. */
  H.contentsOf = (name) => {
    const f = H.workload.files[name];
    return {
      oldFile: typeof f.old === 'string' ? { name: f.oldName || name, contents: f.old } : null,
      newFile: typeof f.new === 'string' ? { name, contents: f.new } : null,
    };
  };

  H.createPool = (opts = {}) => {
    const workerUrl = opts.workerUrl || '/vendor/pierre-diffs-worker.js';
    H.pool = new window.PierreDiffs.WorkerPoolManager({
      workerFactory: () => {
        const worker = new Worker(workerUrl);
        worker.addEventListener('error', (ev) => H.log('workerErrorEvent', { message: ev.message || String(ev) }));
        return worker;
      },
      poolSize: opts.poolSize || 2,
      totalASTLRUCacheSize: opts.totalASTLRUCacheSize || 50,
      ...(opts.extra || {}),
      ...(opts.onWorkerError ? { onWorkerError: H.wrappers.onWorkerError } : {}),
    }, {
      langs: ['text'],
      theme: { dark: 'github-dark', light: 'github-light' },
      lineDiffType: 'word',
      preferredHighlighter: opts.preferredHighlighter || 'shiki-js',
      ...(opts.renderOptions || {}),
    });
    return true;
  };

  /** The serializable options the app passes (plan section 3.12), overridable. */
  H.makeOptions = (options = {}, callbacks = []) => {
    const o = {
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType: 'light',
      diffStyle: 'unified',
      diffIndicators: 'bars',
      overflow: 'wrap',
      lineHoverHighlight: 'line',
      lineDiffType: 'word',
      hunkSeparators: 'line-info',
      expansionLineCount: 20,
      collapsedContextThreshold: 5,
      stickyHeaders: true,
      ...options,
    };
    for (const key of callbacks) o[key] = H.wrappers[key];
    return o;
  };

  H.create = (options = {}, callbacks = ['onPostRender'], { pool = false } = {}) => {
    H.options = H.makeOptions(options, callbacks);
    H.cv = new window.PierreDiffs.CodeView(H.options, pool ? H.pool : undefined);
    // A spec may hand in its own scroll root (H.root) before calling create.
    H.root = H.root || document.getElementById('root');
    H.log('create');
    H.cv.setup(H.root);
    H.log('setupDone');
    return true;
  };

  /** setOptions takes a full replacement object, not a patch. */
  H.setOptions = (patch) => { H.options = { ...H.options, ...patch }; H.cv.setOptions(H.options); };

  // ---- item helpers ----
  H.update = (id, patch) => {
    const item = H.cv.getItem(id);
    return H.cv.updateItem({ ...item, ...patch, version: (item.version ?? 0) + 1 });
  };
  H.toggleCollapsed = (id) => H.update(id, { collapsed: !H.cv.getItem(id).collapsed });
  H.mounted = () => H.cv.getRenderedItems().map((r) => r.id);
  H.host = (id) => { const r = H.cv.getRenderedItems().find((x) => x.id === id); return r ? r.element : null; };
  /** The vendor instance for an item: from getRenderedItems when mounted, else the one seen in onPostRender. */
  H.instance = (id) => {
    const r = H.cv.getRenderedItems().find((x) => x.id === id);
    return r ? r.instance : (H.instances.get(id) || null);
  };
  /**
   * The vendor's internal record for an item ({ top, height, instance, ... }).
   * `idToItem` is TypeScript-private. Only the harness's layout audit reads it;
   * production code must not (plan section 8, "Vendor internals").
   */
  H.rec = (id) => H.cv.idToItem.get(id);
  H.orphanHosts = () => H.root.querySelectorAll('diffs-container').length - H.cv.getRenderedItems().length;

  // ---- timing helpers ----
  H.raf = (n = 1) => new Promise((ok) => {
    const step = () => (--n <= 0 ? ok() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  /**
   * Resolve once nothing has changed for `quietMs`: no vendor callback logged,
   * no scroll movement, no extent change. Returns the elapsed ms, or -1 when
   * `maxMs` passed first (specs assert on the state, not on this number).
   */
  H.settle = async (quietMs = 150, maxMs = 8000) => {
    const start = performance.now();
    let lastN = H.events.length;
    let lastTop = H.root.scrollTop;
    let lastH = H.root.scrollHeight;
    let lastChange = performance.now();
    while (performance.now() - start < maxMs) {
      await H.raf(1);
      if (H.events.length !== lastN || H.root.scrollTop !== lastTop || H.root.scrollHeight !== lastH) {
        lastN = H.events.length; lastTop = H.root.scrollTop; lastH = H.root.scrollHeight; lastChange = performance.now();
      } else if (performance.now() - lastChange >= quietMs) {
        return +(performance.now() - start).toFixed(0);
      }
    }
    return -1;
  };
  /** Poll a predicate once per frame. Returns { ok, ms, frames }. */
  H.until = async (pred, maxMs = 10000) => {
    const start = performance.now();
    let frames = 0;
    for (;;) {
      if (pred()) return { ok: true, ms: +(performance.now() - start).toFixed(0), frames };
      if (performance.now() - start >= maxMs) return { ok: false, ms: -1, frames };
      await H.raf(1);
      frames++;
    }
  };

  // ---- measurement helpers ----
  H.extent = () => ({
    rootScrollTop: H.root.scrollTop,
    rootScrollHeight: H.root.scrollHeight,
    rootClientHeight: H.root.clientHeight,
    maxScrollTop: H.root.scrollHeight - H.root.clientHeight,
    cvScrollTop: H.cv.getScrollTop(),
    cvScrollHeight: H.cv.getScrollHeight(),
  });
  /**
   * For every mounted item: the vendor's computed window height against the
   * host's DOM height (dH), and the vendor's computed top against the host's
   * DOM top in scroll coordinates (dTop). A correct layout is all zeros.
   * The vendor's own validator (development bundle) checks dH only.
   */
  H.heightAudit = () => {
    const rootRect = H.root.getBoundingClientRect();
    return H.cv.getRenderedItems().map((r) => {
      const rec = H.rec(r.id);
      const rect = r.element.getBoundingClientRect();
      const specs = rec.instance.getAdvancedStickySpecs && rec.instance.getAdvancedStickySpecs();
      const expected = specs ? specs.height : null;
      const domTop = rect.top - rootRect.top + H.root.scrollTop;
      const expectedTop = H.cv.getTopForItem(r.id) + (specs ? specs.topOffset - rec.top : 0);
      return {
        id: r.id,
        dH: expected == null ? null : +(rect.height - expected).toFixed(2),
        dTop: +(domTop - expectedTop).toFixed(2),
      };
    });
  };
  /** True when every mounted item's DOM matches the vendor's layout exactly. */
  H.auditClean = () => H.heightAudit().every((a) => a.dH === 0 && a.dTop === 0);
  H.itemHeight = (id) => H.rec(id).height;
  H.viewportTopOf = (el) => +(el.getBoundingClientRect().top - H.root.getBoundingClientRect().top).toFixed(2);
  H.firstVisibleItem = () => {
    const rootTop = H.root.getBoundingClientRect().top;
    for (const it of H.cv.getRenderedItems()) {
      if (it.element.getBoundingClientRect().bottom > rootTop + 1) return it.id;
    }
    return null;
  };

  /** A rendered row in an item's shadow DOM. side: 'additions' | 'deletions' | undefined */
  H.findRow = (id, lineNumber, side) => {
    const host = H.host(id);
    if (!host || !host.shadowRoot) return null;
    const rows = [...host.shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .filter((el) => el.getAttribute('data-line') === String(lineNumber));
    if (!side) return rows[0] || null;
    const wantTypes = side === 'deletions' ? ['change-deletion'] : ['change-addition', 'context', 'context-expanded'];
    return rows.find((el) => {
      const col = el.closest('[data-deletions],[data-additions],[data-unified]');
      if (col && col.hasAttribute('data-deletions')) return side === 'deletions';
      if (col && col.hasAttribute('data-additions')) return side === 'additions';
      return wantTypes.includes(el.getAttribute('data-line-type'));
    }) || null;
  };
  /** Counts read from an item's shadow DOM. Null when the item is not mounted. */
  H.shape = (id) => {
    const host = H.host(id);
    if (!host) return null;
    const sr = host.shadowRoot;
    return {
      rows: sr.querySelectorAll('[data-content] > [data-line]').length,
      separators: sr.querySelectorAll('[data-content] > [data-separator]').length,
      expandButtons: sr.querySelectorAll('[data-gutter] > [data-separator] [data-expand-button]').length,
      tokens: sr.querySelectorAll('[data-content] > [data-line] span[style*="--diffs-token"]').length,
      hasPre: !!sr.querySelector('pre'),
      diffType: sr.querySelector('pre') ? sr.querySelector('pre').getAttribute('data-diff-type') : null,
    };
  };

  // App-like bring-up used by most specs.
  // o: { options, callbacks, pool, poolOpts, build, parse, quietMs, maxMs }
  H.APP_CALLBACKS = [
    'onPostRender', 'renderAnnotation', 'renderCustomHeader', 'renderGutterUtility',
    'onLineClick', 'onLineNumberClick', 'onLineSelected', 'onLineSelectionStart',
    'onLineSelectionChange', 'onLineSelectionEnd', 'onSelectedLinesChange',
  ];
  // diffHeaderHeight 40 is the harness header's height (.ph in harness.html).
  H.APP_OPTIONS = {
    enableGutterUtility: true,
    enableLineSelection: true,
    itemMetrics: { diffHeaderHeight: 40 },
    __devOnlyValidateItemHeights: true,
  };
  H.appLike = async (o = {}) => {
    H.parse(o.parse || {});
    H.buildItems(o.build || {});
    if (o.pool) H.createPool(o.poolOpts || {});
    H.create({ ...H.APP_OPTIONS, ...(o.options || {}) }, o.callbacks || H.APP_CALLBACKS, { pool: !!o.pool });
    H.cv.setItems(H.items);
    const settle = await H.settle(o.quietMs || 150, o.maxMs || 15000);
    return { settle, mounted: H.mounted(), extent: H.extent() };
  };
  H.item = (id) => H.items.find((i) => i.id === id);

  /** Frame-time recorder: call the returned function to stop and get percentiles. */
  H.recordFrames = () => {
    const frames = [];
    let last = performance.now();
    let on = true;
    const tick = (now) => { frames.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return () => {
      on = false;
      const f = frames.slice(1).sort((a, b) => a - b);
      const q = (p) => +(f[Math.min(f.length - 1, Math.floor(p * f.length))] || 0).toFixed(1);
      return {
        n: f.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +(f[f.length - 1] || 0).toFixed(1),
        over33: f.filter((x) => x > 33.4).length, over50: f.filter((x) => x > 50).length, over100: f.filter((x) => x > 100).length,
      };
    };
  };
})();
