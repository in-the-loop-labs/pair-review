// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * A real PierreBridge for unit tests of the modules that talk to it
 * (ExternalCommentManager, TourRenderer, PRManager helpers), without the
 * vendor library.
 *
 * What it is: the production bridge class, constructed with no vendor
 * bundle, holding file records whose vendor instance is a spy. The bridge's
 * own behaviour is real: the annotation list, the visibility oracle
 * (isLineVisible answers from the hunks a test gives a file), the element
 * cache (getAnnotationElement), the renderer registry and sync.
 *
 * What it is not: a model of the vendor. The spy instance records what the
 * bridge sends (setLineAnnotations, rerender) and draws nothing, so no card
 * is ever attached to the document here. A test may assert what we send to
 * the vendor and what our code decides from data; what the vendor then does
 * with it is decided only by the real bundle in a browser (the contract
 * suite and the E2E suite). See tests/CONVENTIONS.md.
 */

const PierreBridge = require('../../public/js/modules/pierre-bridge.js');

/** A hunk covering lines `start..end` on both sides. */
function hunk(start, end) {
  const count = end - start + 1;
  return { additionStart: start, additionCount: count, deletionStart: start, deletionCount: count };
}

/**
 * @param {Object} vi - vitest's `vi`
 * @param {Object} [options]
 * @param {Array<string|Object>} [options.files] - file names, or
 *   `{ name, hunks, collapsed }`; hunks default to one hunk of lines 1-100
 * @returns {PierreBridge} the bridge, with `addAnnotation`, `addAnnotations`,
 *   `removeAnnotation`, `removeAnnotationsByType`, `registerAnnotationRenderer`
 *   and `getAnnotationElement` wrapped in spies that call through
 */
function createBridgeHarness(vi, { files = [] } = {}) {
  const bridge = new PierreBridge({ theme: 'light' });
  for (const method of ['addAnnotation', 'addAnnotations', 'removeAnnotation',
    'removeAnnotationsByType', 'registerAnnotationRenderer', 'getAnnotationElement']) {
    vi.spyOn(bridge, method);
  }
  for (const file of files) addBridgeFile(vi, bridge, file);
  return bridge;
}

/** Add a file record to a harness bridge. Returns the record. */
function addBridgeFile(vi, bridge, file) {
  const { name, hunks = [hunk(1, 100)], collapsed = false } = typeof file === 'string' ? { name: file } : file;
  const record = {
    instance: {
      fileDiff: { name, hunks, isPartial: true },
      setLineAnnotations: vi.fn(),
      rerender: vi.fn(),
    },
    annotations: [],
    formElements: new Map(),
    collapsed,
    container: null,
    // Not null: the split-layout pass (a DOM pass over vendor rows) is never scheduled.
    _splitLayoutRaf: 0,
  };
  bridge.files.set(name, record);
  return record;
}

module.exports = { createBridgeHarness, addBridgeFile, hunk };
