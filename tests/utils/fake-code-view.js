// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared test doubles for the single-`CodeView` PierreBridge architecture.
 *
 * `FakeCodeView` mirrors the real @pierre/diffs `CodeView` reconciliation
 * semantics the bridge depends on:
 *   - `setItems` / `addItems` / `addItem` populate an ordered, id-keyed store.
 *   - `updateItem` is VERSION-GATED: an update whose `version` is not strictly
 *     greater than the stored item's `version` is a no-op that returns `false`
 *     (matching CodeView.syncItemRecord — the bridge bumps `version` on every
 *     imperative change, so forgetting to bump renders nothing).
 *   - `getItem` returns the current stored snapshot; the bridge re-`getItem`s
 *     before `updateItem` so a stale write to a wiped/replaced id is dropped.
 *
 * On top of the real surface it exposes test-only mount helpers
 * (`mountItem` / `renderHeaderFor` / `renderAnnotationFor` / `renderGutterFor`)
 * that invoke the bridge's option callbacks the way CodeView does when an item
 * scrolls into view, so tests can exercise header / annotation / gutter wiring
 * and virtualization remounts without a real virtualizer.
 *
 * `FakeWorkerPoolManager` stands in for @pierre/diffs `WorkerPoolManager`
 * (syntax-highlight worker pool); `createPierreEnv` wires jsdom + globals +
 * `window.PierreDiffs` so each test file loads the real bridge against the
 * fakes with minimal boilerplate.
 */

const { JSDOM } = require('jsdom');

const BRIDGE_PATH = require.resolve('../../public/js/modules/pierre-bridge.js');

// Sentinel parked in _scheduledFlush during _scheduleFlush so a synchronous rAF
// (whose callback resets the flag before the id is returned) can be told apart
// from a real pending id — see _scheduleFlush.
const FLUSH_SCHEDULED = Symbol('flush-scheduled');

/**
 * Faithful-enough fake of @pierre/diffs CodeView. Framework-agnostic: it records
 * calls into plain arrays (`this.calls`) so any assertion library can inspect
 * them, and performs the load-bearing version-gated reconciliation the bridge
 * relies on.
 */
class FakeCodeView {
  constructor(options, workerManager, isContainerManaged) {
    this.options = options || {};
    this.workerManager = workerManager;
    this.isContainerManaged = isContainerManaged;
    this.root = null;
    this._items = new Map(); // id -> item snapshot
    this._order = [];        // ordered ids
    // Items currently mounted (in the render window): id -> { host, instance,
    // shadowRoot }. Only these render annotations / fire onPostRender, mirroring
    // the vendor's virtualization. getRenderedItems() reports exactly this set.
    this._mounts = new Map();
    // Ids whose latest updateItem bumped the version but whose render has not
    // been flushed yet — the deferred, rAF-batched CodeView render the bridge
    // relies on. flushRender() drains these.
    this._pendingRender = new Set();
    // Handle for a single rAF-batched render scheduled by updateItem (the real
    // CodeView coalesces many updateItems in a frame into ONE render). null when
    // none pending. Drained by _flushPendingMounted; cancelled by an explicit
    // flushRender that empties the pending set.
    this._scheduledFlush = null;
    // STABLE per-item instance objects (id -> instance). The real CodeView
    // keeps one VirtualizedFileDiff per item and reuses it across
    // mount/unmount/remount; the bridge's instance->id fallback map and
    // _applyHostClasses rely on that identity, so the fake must NOT mint a fresh
    // instance per mount. Caller-supplied instances are cached here too.
    this._instances = new Map();
    this._scrollTop = 0;
    this._selection = null;
    this.cleanedUp = false;
    this.calls = {
      setup: [],
      setItems: [],
      addItems: [],
      addItem: [],
      updateItem: [],
      updateItemId: [],
      render: [],
      scrollTo: [],
      setOptions: [],
      onThemeChange: 0,
      cleanUp: 0,
      setSelectedLines: [],
      clearSelectedLines: 0,
    };
    if (FakeCodeView._instances) FakeCodeView._instances.push(this);
  }

  setup(root) {
    this.root = root;
    this.calls.setup.push(root);
    // Mirror the real CodeView: it creates a managed container element INSIDE
    // the scroll root. The bridge's _ensureCodeView reads codeView.container and
    // checks container.parentNode to detect an external innerHTML wipe of root
    // (which detaches this managed container while root === root).
    const doc = (root && root.ownerDocument) || globalThis.document;
    this.container = doc.createElement('div');
    this.container.className = 'diffs-container';
    if (root && typeof root.appendChild === 'function') root.appendChild(this.container);
  }

  _store(item) {
    if (!this._items.has(item.id)) this._order.push(item.id);
    this._items.set(item.id, item);
  }

  setItems(items) {
    this.calls.setItems.push(items);
    this._items = new Map();
    this._order = [];
    // A fresh list re-renders from scratch: old mounts/pending are stale.
    this._mounts.clear();
    this._pendingRender.clear();
    for (const it of items || []) this._store(it);
  }

  addItems(items) {
    this.calls.addItems.push(items);
    for (const it of items || []) this._store(it);
  }

  addItem(item) {
    this.calls.addItem.push(item);
    this._store(item);
  }

  getItem(id) {
    return this._items.get(id);
  }

  /**
   * Version-gated reconcile: apply only when the input version strictly exceeds
   * the stored version. Returns whether the update was applied.
   */
  updateItem(input) {
    this.calls.updateItem.push(input);
    const existing = this._items.get(input.id);
    if (!existing) return false;
    if (
      input.version != null &&
      existing.version != null &&
      input.version <= existing.version
    ) {
      return false;
    }
    this._items.set(input.id, input);
    // The vendor does NOT render synchronously here — updateItem schedules a
    // rAF-batched CodeView render. Record the pending render and schedule ONE
    // coalesced flush (so a batch of updateItems still costs a single render).
    // flushRender() can also perform it explicitly/synchronously.
    this._pendingRender.add(input.id);
    this._scheduleFlush();
    return true;
  }

  /**
   * Schedule a single rAF-batched flush of all pending mounted renders (the
   * vendor coalesces a frame's updateItems into one render). No-op if one is
   * already scheduled or there is no frame source (tests then flush explicitly).
   *
   * Sync-rAF safety: under a SYNCHRONOUS requestAnimationFrame (createPierreEnv's
   * default), the callback runs DURING the rAF call and resets _scheduledFlush to
   * null — but the outer `_scheduledFlush = requestAnimationFrame(...)` assignment
   * would then overwrite that null with the returned id, wedging the flag truthy
   * and self-disabling every later flush (the batch's 2nd+ updateItems silently
   * never render). Guard with a sentinel set BEFORE the call and only adopt the
   * real id if the callback has not already cleared it.
   * @private
   */
  _scheduleFlush() {
    if (this._scheduledFlush != null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._scheduledFlush = FLUSH_SCHEDULED;
    const id = requestAnimationFrame(() => {
      this._scheduledFlush = null;
      this._flushPendingMounted();
    });
    // Async rAF: callback hasn't run, keep the real id for cancellation.
    // Sync rAF: callback already reset to null above — don't clobber it.
    if (this._scheduledFlush === FLUSH_SCHEDULED) this._scheduledFlush = id;
  }

  /**
   * Render every pending MOUNTED item once (renderAnnotation + onPostRender);
   * a pending unmounted item has no DOM, so its pending render is just cleared.
   * @private
   */
  _flushPendingMounted() {
    for (const id of [...this._pendingRender]) {
      this._pendingRender.delete(id);
      if (this._mounts.has(id)) this._renderMounted(id, 'update');
    }
  }

  updateItemId(oldId, newId) {
    this.calls.updateItemId.push([oldId, newId]);
    if (!this._items.has(oldId)) return false;
    const item = this._items.get(oldId);
    item.id = newId;
    this._items.delete(oldId);
    this._items.set(newId, item);
    this._order = this._order.map((id) => (id === oldId ? newId : id));
    return true;
  }

  scrollTo(target) {
    this.calls.scrollTo.push(target);
    if (target && target.type === 'position') this._scrollTop = target.position;
  }

  getScrollTop() {
    return this._scrollTop;
  }

  setSelectedLines(selection) {
    this.calls.setSelectedLines.push(selection);
    this._selection = selection;
  }

  getSelectedLines() {
    return this._selection;
  }

  clearSelectedLines() {
    this.calls.clearSelectedLines += 1;
    this._selection = null;
  }

  setOptions(options) {
    this.calls.setOptions.push(options);
    this.options = options;
  }

  onThemeChange() {
    this.calls.onThemeChange += 1;
  }

  cleanUp() {
    this.calls.cleanUp += 1;
    this.cleanedUp = true;
  }

  /**
   * Only MOUNTED items are "rendered" (in the render window), matching the real
   * CodeView — the bridge's _isItemRendered uses this to tell a slotting item
   * from one virtualized out. Seeded-but-unmounted items are NOT returned.
   */
  getRenderedItems() {
    return [...this._mounts.keys()].map((id) => ({ id, item: this._items.get(id) }));
  }

  /** Ordered ids currently held (test convenience). */
  itemIds() {
    return [...this._order];
  }

  // ─── Test-only mount simulation ───────────────────────────────────
  //
  // The real CodeView invokes these option callbacks when an item mounts into
  // the viewport (and re-invokes them on every virtualization remount). Drive
  // them explicitly so tests can assert the bridge's header/annotation/gutter
  // wiring and onPostRender bookkeeping.

  _context(id, extra = {}) {
    return { item: { id }, instance: {}, ...extra };
  }

  /**
   * Render a mounted item's annotations then fire onPostRender — the vendor's
   * same-pass order (FileDiff runs renderAnnotations() then emitPostRender()).
   * @private
   */
  /**
   * Resolve the STABLE instance for an item. A caller-supplied instance is
   * cached and reused; otherwise a per-item instance is created once and reused
   * across every mount/unmount/remount — matching the real CodeView, whose
   * instance identity backs the bridge's instance->id fallback map.
   * @private
   */
  _instanceFor(id, provided) {
    if (provided != null) {
      this._instances.set(id, provided);
      return provided;
    }
    let inst = this._instances.get(id);
    if (!inst) {
      inst = { __fakeInstanceFor: id };
      this._instances.set(id, inst);
    }
    return inst;
  }

  _renderMounted(id, phase) {
    const mount = this._mounts.get(id);
    if (!mount) return undefined;
    const item = this._items.get(id);
    const context = { item: { id }, element: mount.host, instance: mount.instance };
    const host = mount.host;
    // The vendor rebuilds slotted annotation nodes each render pass — clear the
    // prior pass's so a removed/re-scoped annotation never lingers in the host.
    if (host && typeof host.querySelectorAll === 'function') {
      host.querySelectorAll('[data-pr-annotation-id]').forEach((n) => n.remove());
    }
    const annotations = (item && item.annotations) || [];
    // A per-mount slot window: only annotations passing slotFilter are inside
    // the item's internal render window; the rest are NOT slotted (their lines
    // are scrolled out), so whenAnnotationSlotted reports 'line-not-rendered'.
    const slotFilter = mount.slotFilter || (() => true);
    for (const annotation of annotations) {
      if (!slotFilter(annotation)) continue;
      const el = this.options.renderAnnotation?.(annotation, context);
      // Project the rendered node (the bridge stamps it with
      // data-pr-annotation-id) into the host's LIGHT DOM so the bridge's
      // host.querySelector([data-pr-annotation-id]) can locate it — mirroring
      // the vendor slotting annotation content into the host.
      if (el && el.nodeType === 1 && host && typeof host.appendChild === 'function') {
        host.appendChild(el);
      }
    }
    // Vendor contract: onPostRender(fileContainer, instance, phase, context) —
    // phase is arg 3, the appended item context is arg 4.
    this.options.onPostRender?.(host, mount.instance, phase, context);
    return context;
  }

  /**
   * Simulate mounting an item into the render window: run renderCustomHeader,
   * then (like the vendor) renderAnnotations + onPostRender in one pass.
   * Returns the context (with the light-DOM host element).
   */
  mountItem(id, { element, instance, shadowRoot, phase = 'mount', slotFilter } = {}) {
    const doc = (this.root && this.root.ownerDocument) || globalThis.document;
    const host = element || doc.createElement('div');
    if (shadowRoot && !host.shadowRoot) {
      Object.defineProperty(host, 'shadowRoot', { value: shadowRoot, configurable: true });
    }
    const inst = this._instanceFor(id, instance);
    const item = this._items.get(id);
    if (typeof this.options.renderCustomHeader === 'function') {
      this.options.renderCustomHeader(item && (item.fileDiff || item.file), {
        item: { id }, element: host, instance: inst,
      });
    }
    this._mounts.set(id, { host, instance: inst, shadowRoot, slotFilter });
    // A mount IS a render pass — it clears any pending render for this item.
    this._pendingRender.delete(id);
    return this._renderMounted(id, phase);
  }

  /**
   * Flush the deferred CodeView render for one item (or all pending). Mirrors
   * the vendor's same-pass ordering (renderAnnotation then onPostRender 'update')
   * and only renders MOUNTED items — a virtualized-out item has no pending DOM,
   * so its pending render is dropped without firing callbacks. This is the
   * deterministic stand-in for the real rAF-batched render: tests call it
   * explicitly instead of waiting on a frame (tests/CONVENTIONS.md).
   * @param {string} [id] - flush just this id; omit to flush all pending.
   */
  flushRender(id) {
    const ids = id != null ? [id] : [...this._pendingRender];
    for (const itemId of ids) {
      this._pendingRender.delete(itemId);
      if (this._mounts.has(itemId)) this._renderMounted(itemId, 'update');
    }
    // Nothing left to render → drop any coalesced auto-flush so it can't fire a
    // redundant second render pass on a later tick.
    if (this._pendingRender.size === 0 && this._scheduledFlush != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._scheduledFlush);
      this._scheduledFlush = null;
    }
  }

  /**
   * Vendor parity for `CodeView.render(immediate)`: request a render/layout pass.
   * The vendor syncs the scrollable container's height only inside such a pass,
   * which is what bridge.syncScrollExtent() reaches for — with `false`, i.e. a
   * QUEUED pass the vendor coalesces to one per frame, so a resize storm costs one
   * flush per frame. `true` runs the pass now.
   *
   * The argument is recorded (`calls.render`) so tests can pin queued-vs-immediate,
   * and the request is wired to the same pending-render machinery the rest of the
   * fake uses so a requested pass actually renders mounted items.
   * @param {boolean} [immediate=false]
   */
  render(immediate = false) {
    this.calls.render.push(immediate);
    if (immediate) this._flushPendingMounted();
    else this._scheduleFlush();
    return true;
  }

  /** True when an item is currently mounted (test convenience). */
  isMounted(id) {
    return this._mounts.has(id);
  }

  /**
   * Simulate an item scrolling out of view: the vendor recycles its
   * <diffs-container> host for another item and invokes onPostRender with
   * phase 'unmount' (context still appended last). The bridge drops its
   * per-file element/instance/shadow refs on this phase.
   */
  unmountItem(id, { element = null, instance = null } = {}) {
    const mount = this._mounts.get(id);
    this._mounts.delete(id);
    this._pendingRender.delete(id);
    const host = element || mount?.host || null;
    // Reuse the SAME stable instance the mount published, so the bridge's
    // instance->id fallback resolves and its ref-clear guard matches.
    const inst = instance || mount?.instance || this._instances.get(id) || null;
    const context = { item: { id }, element: host, instance: inst };
    return this.options.onPostRender?.(host, inst, 'unmount', context);
  }

  renderHeaderFor(id, extra) {
    const item = this._items.get(id);
    return this.options.renderCustomHeader?.(item && (item.fileDiff || item.file), this._context(id, extra));
  }

  renderAnnotationFor(id, annotation, extra) {
    return this.options.renderAnnotation?.(annotation, this._context(id, extra));
  }

  renderGutterFor(id, getHoveredRow, extra) {
    return this.options.renderGutterUtility?.(getHoveredRow, this._context(id, extra));
  }
}

/**
 * Stand-in for @pierre/diffs WorkerPoolManager. Configurable enough to drive the
 * bridge's worker init / ready / timeout / fallback paths.
 */
class FakeWorkerPoolManager {
  constructor(poolOptions, renderOptions, cfg = {}) {
    this.poolOptions = poolOptions;
    this.renderOptions = renderOptions;
    this._cfg = cfg;
    this._statsCallback = null;
    this.terminated = false;
    this.setRenderOptions =
      cfg.setRenderOptions || ((opts) => {
        this.renderOptions = opts;
        return Promise.resolve();
      });
    if (FakeWorkerPoolManager._instances) FakeWorkerPoolManager._instances.push(this);
  }

  subscribeToStatChanges(callback) {
    this._statsCallback = callback;
    const initial = this._cfg.initialStats || { managerState: 'initialized', workersFailed: false };
    callback(initial);
    return this._cfg.unsubscribe || (() => {});
  }

  /** Test helper: push a stats update to the subscribed callback. */
  emitStats(stats) {
    if (this._statsCallback) this._statsCallback(stats);
  }

  initialize() {
    return this._cfg.initialize ? this._cfg.initialize() : Promise.resolve();
  }

  terminate() {
    this.terminated = true;
    if (this._cfg.terminate) this._cfg.terminate();
  }
}

/**
 * Build a fresh `window.PierreDiffs` object backed by the fakes.
 * @param {Object} [opts]
 * @param {Function} [opts.parsePatch] - (patch) => FileDiffMetadata for parsePatchFiles
 * @param {Function} [opts.parseDiffFromFile] - (oldFile,newFile) => FileDiffMetadata
 * @param {boolean}  [opts.worker] - include WorkerPoolManager (default false)
 */
function makePierreDiffs(opts = {}) {
  const parsePatch =
    opts.parsePatch ||
    ((patch) => ({
      name: 'file',
      type: 'change',
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      deletionLines: [],
      additionLines: [],
      _patch: patch,
    }));

  const diffs = {
    CodeView: FakeCodeView,
    parsePatchFiles: (input) => [{ files: [parsePatch(input)] }],
    getSingularPatch: opts.getSingularPatch || ((patch) => parsePatch(patch)),
    parseDiffFromFile:
      opts.parseDiffFromFile ||
      ((oldFile, newFile) => ({
        name: (newFile && newFile.name) || (oldFile && oldFile.name) || 'file',
        type: 'change',
        hunks: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        deletionLines: [],
        additionLines: [],
      })),
  };
  if (opts.worker) diffs.WorkerPoolManager = FakeWorkerPoolManager;
  return diffs;
}

/**
 * Set up a jsdom window/document with `window.PierreDiffs` and load the real
 * PierreBridge fresh against the fakes. Returns handles for the test plus a
 * `cleanup()` that restores globals and clears the module cache.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.diffs=true] - when false, leaves `window.PierreDiffs`
 *   undefined so the bridge boots `_disabled` (pure static/logic tests).
 * @param {Object}  [opts.context] - value for `window.PierreContext`.
 * @param {Object}  [opts.windowExtras] - extra props merged onto `window`.
 * @param {Function} [opts.parsePatch] - see makePierreDiffs.
 * @param {Function} [opts.parseDiffFromFile] - see makePierreDiffs.
 * @param {boolean} [opts.worker=false] - include a WorkerPoolManager fake.
 * @param {Object}  [opts.workerConfig] - forwarded to FakeWorkerPoolManager cfg.
 * @param {boolean} [opts.raf=true] - install a synchronous requestAnimationFrame.
 */
function createPierreEnv(opts = {}) {
  const {
    diffs = true,
    context,
    windowExtras = {},
    parsePatch,
    parseDiffFromFile,
    getSingularPatch,
    worker = false,
    workerConfig = {},
    raf = true,
  } = opts;

  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevWorker = global.Worker;
  const prevRaf = global.requestAnimationFrame;
  const prevCancelRaf = global.cancelAnimationFrame;

  const codeViews = [];
  const workerManagers = [];
  FakeCodeView._instances = codeViews;
  FakeWorkerPoolManager._instances = workerManagers;

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  global.document = dom.window.document;

  if (worker) {
    global.Worker = function Worker() {};
  }

  const window = {
    matchMedia: () => ({ matches: false }),
    navigator: { hardwareConcurrency: 4 },
    ...windowExtras,
  };
  window.PierreDiffs = diffs
    ? makePierreDiffs({
      parsePatch,
      parseDiffFromFile,
      getSingularPatch,
      worker,
      ...(worker ? { workerConfig } : {}),
    })
    : undefined;
  if (worker && window.PierreDiffs) {
    // Thread workerConfig into the WorkerPoolManager the bridge constructs.
    window.PierreDiffs.WorkerPoolManager = function (poolOptions, renderOptions) {
      return new FakeWorkerPoolManager(poolOptions, renderOptions, workerConfig);
    };
    window.PierreDiffs.WorkerPoolManager._instances = workerManagers;
  }
  if (context !== undefined) window.PierreContext = context;
  global.window = window;

  if (raf) {
    global.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };
    global.cancelAnimationFrame = () => {};
  }

  delete require.cache[BRIDGE_PATH];
  const PierreBridge = require(BRIDGE_PATH);

  function cleanup() {
    delete require.cache[BRIDGE_PATH];
    FakeCodeView._instances = null;
    FakeWorkerPoolManager._instances = null;
    if (prevWindow === undefined) delete global.window; else global.window = prevWindow;
    if (prevDocument === undefined) delete global.document; else global.document = prevDocument;
    if (prevWorker === undefined) delete global.Worker; else global.Worker = prevWorker;
    if (prevRaf === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = prevRaf;
    if (prevCancelRaf === undefined) delete global.cancelAnimationFrame; else global.cancelAnimationFrame = prevCancelRaf;
  }

  return { PierreBridge, window, document: global.document, dom, codeViews, workerManagers, cleanup };
}

module.exports = {
  FakeCodeView,
  FakeWorkerPoolManager,
  makePierreDiffs,
  createPierreEnv,
};
