// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of the bridge-in-browser tests (tests/contract/bridge).
 * Exposes `window.BH`, next to the vendor harness `window.H`.
 *
 * BH builds pane entries from the deterministic workload and constructs the
 * REAL PierreBridge over the REAL vendor bundle. It contains no model
 * of either: what a spec asserts on is read from the bridge's public API,
 * from the vendor's own objects, or from the DOM. After `BH.create` the
 * vendor harness's measurement helpers work on the bridge's viewer
 * (H.cv = bridge.codeView), so H.settle, H.heightAudit, H.host, H.findRow
 * and H.orphanHosts are the same instruments the vendor contract specs use.
 *
 * Loaded by tests/contract/bridge/bridge-test.js after the workload and the
 * production modules.
 */
(() => {
  const H = window.H;
  const BH = {
    bridge: null,
    headers: new Map(),   // id -> header element handed to the bridge
    forgotten: new Set(), // ids the page no longer knows: no header, no host classes
    zones: new Map(),     // id -> file-comment zone element
    hostClasses: new Map(), // id -> string[] answered by the hostState hook
    lifecycle: [],        // { id, phase }
    calls: [],            // interaction callbacks: { name, args }
    synced: [],           // sync calls of the 'card' test renderer: { id, n }
    cardBuilds: 0,
    rendererCalls: [],    // every call of a registered renderer: { type, file, id }
  };
  window.BH = BH;

  /** A changed-file entry for a workload path. */
  BH.diffEntry = (name, extra = {}) => {
    const file = H.workload.files[name] || {};
    let status = 'modified';
    if (typeof file.old !== 'string') status = 'added';
    else if (typeof file.new !== 'string') status = 'removed';
    return { id: name, kind: 'diff', patch: H.workload.patches[name], status, ...extra };
  };

  /**
   * A context-file entry: the NEW contents of a workload file under another
   * path, or the given text.
   */
  BH.contextEntry = (id, { from, contents, ranges = [], contentsSeq = 1, ...extra } = {}) => ({
    id,
    kind: 'context',
    contents: typeof contents === 'string' ? contents : H.workload.files[from].new,
    contentsSeq,
    ranges,
    ...extra,
  });

  /** Text of `count` numbered lines, ending with a newline. */
  BH.numberedLines = (count, tag = 'value') => `${Array.from({ length: count }, (_, i) => `const ${tag}${i + 1} = compute(${i + 1}); // line ${i + 1}`).join('\n')}\n`;

  /** The stand-in header the harness page styles (.ph, 40 px). One element per file. */
  BH.renderHeader = (id, kind) => {
    if (BH.forgotten.has(id)) return null;
    if (!BH.headers.has(id)) {
      const row = document.createElement('div');
      row.className = 'ph';
      row.dataset.phId = id;
      row.dataset.kind = kind;
      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = id;
      row.appendChild(path);
      BH.headers.set(id, row);
    }
    // The page re-stamps a file's cached header every time the viewer asks
    // for it (PRManager._syncFileHeader): a test may do the same here.
    if (typeof BH.onHeaderDraw === 'function') BH.onHeaderDraw(id, BH.headers.get(id));
    return BH.headers.get(id);
  };

  /**
   * Construct the bridge the way the app will: hooks, interaction callbacks,
   * a zone renderer, and a plain 'card' type whose build and sync calls are
   * counted.
   */
  BH.create = (options = {}) => {
    H.root = H.root || document.getElementById('root');
    const record = (name) => (...args) => { BH.calls.push({ name, args: args.map((a) => H.ser(a)) }); };
    const bridge = new window.PierreBridge({
      root: H.root,
      theme: 'light',
      workerUrl: '/vendor/pierre-diffs-worker.js',
      itemMetrics: { diffHeaderHeight: 40 },
      viewerOptions: { __devOnlyValidateItemHeights: true },
      hooks: {
        renderHeader: BH.renderHeader,
        hostState: (id) => (BH.forgotten.has(id) ? [] : BH.hostClasses.get(id) || []),
        onItemLifecycle: (id, phase) => {
          BH.lifecycle.push({ id, phase });
          H.log('onPostRender', { id, phase });
          if (typeof BH.onLifecycle === 'function') BH.onLifecycle(id, phase);
        },
      },
      onCommentClick: record('onCommentClick'),
      onChatClick: record('onChatClick'),
      onLineSelect: record('onLineSelect'),
      onLineSelectionEnd: record('onLineSelectionEnd'),
      onCommentFormSubmit: record('onCommentFormSubmit'),
      onCommentFormCancel: record('onCommentFormCancel'),
      ...options,
    });
    bridge.registerAnnotationRenderer('file-comments', (data, id, fileName) => {
      BH.rendererCalls.push({ type: 'file-comments', file: fileName, id });
      if (!BH.zones.has(data.file)) {
        const zone = document.createElement('div');
        zone.className = 'zone';
        zone.dataset.zoneFor = data.file;
        BH.zones.set(data.file, zone);
      }
      return BH.zones.get(data.file);
    });
    bridge.registerAnnotationRenderer('notice', (data) => {
      const el = document.createElement('div');
      el.className = 'ann notice';
      el.textContent = data.message;
      if (data.action) {
        const button = document.createElement('button');
        button.className = 'notice-action';
        button.textContent = data.action;
        el.appendChild(button);
      }
      return el;
    });
    bridge.registerAnnotationRenderer('card', (data, id, fileName) => {
      BH.cardBuilds++;
      BH.rendererCalls.push({ type: 'card', file: fileName, id });
      const el = document.createElement('div');
      el.className = 'ann card';
      el.dataset.cardId = id;
      el.textContent = data.text || id;
      if (data.height) el.style.height = `${data.height}px`;
      if (data.textarea) {
        const ta = document.createElement('textarea');
        ta.rows = 3;
        el.appendChild(ta);
      }
      return el;
    }, {
      sync: (el, data, id) => {
        BH.synced.push({ id, n: data.n ?? null });
        el.dataset.syncedN = String(data.n ?? '');
      },
    });
    BH.bridge = bridge;
    return bridge;
  };

  /** renderAll, then point the vendor harness's instruments at the bridge's viewer. */
  BH.renderAll = (entries, options = { keyPrefix: 'rev1' }) => {
    const ok = BH.bridge.renderAll(entries, options);
    H.cv = BH.bridge.codeView;
    return ok;
  };

  /** Bring up a bridge over the given entries and wait until the viewer is quiet. */
  BH.up = async ({ entries, options = {}, quietMs = 150 } = {}) => {
    BH.create(options);
    BH.renderAll(entries);
    await H.settle(quietMs, 15000);
    return { mounted: H.mounted(), files: [...BH.bridge.files.keys()] };
  };

  /** What a mounted file's host carries. Null when the file is not mounted. */
  BH.hostInfo = (id) => {
    const host = BH.bridge.findFileElement(id);
    if (!host) return null;
    return {
      fileName: host.getAttribute('data-file-name'),
      classes: [...host.classList].sort(),
      header: host.querySelector('.pr-file-header-slot .ph')?.dataset.phId ?? null,
    };
  };

  /** The rows a mounted file shows: [{ line, type, text }]. */
  BH.rows = (id) => {
    const host = BH.bridge.findFileElement(id);
    if (!host) return null;
    return [...host.shadowRoot.querySelectorAll('[data-content] > [data-line]')].map((row) => ({
      line: Number(row.getAttribute('data-line')),
      type: row.getAttribute('data-line-type'),
      text: row.textContent,
    }));
  };

  /** Line numbers of the rows a mounted file shows, as [start, end] runs. */
  BH.lineRuns = (id) => {
    const rows = BH.rows(id);
    if (!rows) return null;
    const runs = [];
    for (const { line } of rows) {
      const last = runs[runs.length - 1];
      if (last && line === last[1] + 1) last[1] = line;
      else if (!last || line !== last[1]) runs.push([line, line]);
    }
    return runs;
  };

  /** A separator of a mounted file by gap index. where: 'gutter' (the controls) | 'content' (the label). */
  BH.separator = (id, expandIndex, where = 'gutter') => {
    const host = BH.bridge.findFileElement(id);
    return host ? host.shadowRoot.querySelector(`[data-${where}] > [data-separator][data-expand-index="${expandIndex}"]`) : null;
  };

  /** Scroll until a file's separator is mounted and a little below the top of the pane. */
  BH.bringSeparator = async (id, expandIndex) => {
    for (let i = 0; i < 80; i++) {
      const separator = BH.separator(id, expandIndex);
      if (separator) {
        H.root.scrollTop += H.viewportTopOf(separator) - 300;
        await H.settle(200);
        if (BH.separator(id, expandIndex)) return true;
      } else {
        H.root.scrollTop = Math.max(0, BH.bridge.codeView.getTopForItem(id) - 60) + i * 300;
        await H.settle(120);
      }
    }
    return false;
  };

  /**
   * Where to click a separator's control. kind: 'up' | 'down' | 'both' (the
   * chevrons) | 'all' ("Expand all"). Null when the separator is not mounted;
   * { missing } when it has no such control; `visible` false when CSS hides it.
   */
  BH.controlBox = (id, expandIndex, kind) => {
    const separator = BH.separator(id, expandIndex);
    if (!separator) return null;
    const selector = { up: '[data-expand-up]', down: '[data-expand-down]', both: '[data-expand-both]', all: '[data-expand-all-button]' }[kind];
    const button = separator.querySelector(selector);
    if (!button) return { missing: selector };
    const box = button.getBoundingClientRect();
    return { x: box.x + Math.min(box.width / 2, 12), y: box.y + box.height / 2, visible: box.width > 0 && box.height > 0, text: button.textContent.trim() };
  };

  /** The label of a separator ("N unmodified lines"), or null. */
  BH.separatorLabel = (id, expandIndex) => {
    for (const where of ['content', 'gutter']) {
      const label = BH.separator(id, expandIndex, where)?.querySelector('[data-unmodified-lines]');
      if (label) return label.textContent.replace(/\s+/g, ' ').trim();
    }
    return null;
  };

  /** Wait until a file is mounted and drawing the metadata the bridge last published for it. */
  BH.displayed = (id, maxMs = 10000) => H.until(() => BH.bridge.isDiffDisplayed(id), maxMs);

  /** True when every mounted host belongs to an item, the layout is exact, and no host is orphaned. */
  BH.sound = () => ({ orphans: H.orphanHosts(), clean: H.auditClean() });

  /**
   * The viewer's list against the bridge's records, through the viewer's
   * public getItem. `candidates`: every id the spec has used.
   *   viewerIds:  the candidates the viewer has an item for
   *   recordIds:  the bridge's records, in order
   *   outOfStep:  records whose item is missing or does not carry the
   *               record's metadata object, annotation ids and collapsed state
   */
  BH.listState = (candidates) => {
    const b = BH.bridge;
    const viewerIds = candidates.filter((id) => !!b.codeView.getItem(id));
    const outOfStep = [];
    for (const [id, record] of b.files) {
      const item = b.codeView.getItem(id);
      const ids = (list) => list.map((a) => a.metadata.id).sort().join('|');
      if (!item || item.fileDiff !== record.metadata || item.collapsed !== record.collapsed || ids(item.annotations) !== ids(record.annotations)) outOfStep.push(id);
    }
    return { viewerIds, recordIds: [...b.files.keys()], outOfStep };
  };

  /**
   * Count the list writes the viewer receives from now on: the length of
   * every setItems call on the real instance, in order. Returns the array
   * (it grows) with `restore()`.
   */
  BH.spyOnSetItems = () => {
    const cv = BH.bridge.codeView;
    const original = cv.setItems;
    const calls = [];
    cv.setItems = function (items) { calls.push(items.length); return original.call(this, items); };
    calls.restore = () => { cv.setItems = original; };
    return calls;
  };

  /**
   * Record what the bridge sends to the viewer's list from now on: every
   * scrollTo and setSelectedLines on the real instance, in order, each with
   * what the viewer held at that moment, read from the viewer's own item:
   *   hasItem:   the viewer has an item with the target's id
   *   showsLine: (line targets) a hunk of that item's diff holds the line
   *              and the item is not collapsed
   * Returns the array (it grows) with `restore()`.
   */
  BH.spyOnListCommands = () => {
    const cv = BH.bridge.codeView;
    const originals = { scrollTo: cv.scrollTo, setSelectedLines: cv.setSelectedLines };
    const sent = [];
    const showsLine = (item, lineNumber, side) => {
      if (!item || item.collapsed) return false;
      const key = side === 'deletions' ? 'deletion' : 'addition';
      return item.fileDiff.hunks.some((h) => lineNumber >= h[`${key}Start`] && lineNumber < h[`${key}Start`] + h[`${key}Count`]);
    };
    cv.scrollTo = function (target) {
      const item = cv.getItem(target.id);
      const entry = { call: 'scrollTo', type: target.type, id: target.id, hasItem: !!item };
      if (target.type === 'line') {
        entry.line = target.lineNumber;
        entry.showsLine = showsLine(item, target.lineNumber, target.side);
      }
      sent.push(entry);
      return originals.scrollTo.call(this, target);
    };
    cv.setSelectedLines = function (selection, options) {
      sent.push({ call: 'setSelectedLines', id: selection?.id ?? null, hasItem: !!(selection && cv.getItem(selection.id)) });
      return originals.setSelectedLines.call(this, selection, options);
    };
    sent.restore = () => Object.assign(cv, originals);
    return sent;
  };

  /**
   * Run `fn` once from inside one of the viewer's render callbacks, by
   * putting a card on a mounted file:
   *   via 'hook':     from the page's onItemLifecycle hook (onPostRender),
   *                   on the file's next update;
   *   via 'renderer': from the card's own renderer (renderAnnotation).
   * `side` is the side of `lineNumber` (the card must be on a line the file
   * draws). Returns what `fn` returned, with the bridge's callback depth at
   * the call.
   */
  BH.fromViewerCallback = (via, file, lineNumber, fn, side = 'RIGHT') => {
    const b = BH.bridge;
    const out = { ran: 0, depth: null, value: undefined };
    const once = () => {
      if (out.ran++) return;
      out.depth = b._callbackDepth;
      out.value = fn();
    };
    if (via === 'renderer') {
      b.registerAnnotationRenderer('calls-out', (data, id) => {
        once();
        const el = document.createElement('div');
        el.className = 'ann card';
        el.dataset.cardId = id;
        el.textContent = id;
        return el;
      });
      b.addAnnotation(file, { lineNumber, side, type: 'calls-out', data: {}, id: 'trigger' });
    } else {
      BH.onLifecycle = (id, phase) => { if (id === file && phase === 'update') once(); };
      b.addAnnotation(file, { lineNumber, side, type: 'card', data: { text: 'trigger' }, id: 'trigger' });
      BH.onLifecycle = null;
    }
    return out;
  };

  /** Whether an annotation's element is attached, and where. */
  BH.cardState = (file, annotationId) => {
    const el = BH.bridge.getAnnotationElement(file, annotationId);
    if (!el) return { built: false, connected: false };
    const slot = el.closest('[data-annotation-slot]');
    return {
      built: true,
      connected: el.isConnected,
      slot: slot ? slot.getAttribute('slot') : null,
      host: el.closest('diffs-container')?.getAttribute('data-file-name') ?? null,
      height: Math.round(el.getBoundingClientRect().height),
    };
  };
})();
