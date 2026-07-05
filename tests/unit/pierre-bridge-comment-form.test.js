// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// Regression coverage for the comment-form Chat button dropping the diff
// "side". The form stashes the selected side on textarea.dataset.side, but the
// Chat button used to build its line commentContext without threading it
// through, so deletion-side (LEFT) comments were misrouted — ChatPanel treats
// a missing side as RIGHT.

describe('PierreBridge comment form Chat button side threading', () => {
  let PierreBridge;
  let dom;
  let open;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    open = vi.fn();
    global.window = {
      PierreDiffs: undefined,
      chatPanel: { open },
      matchMedia: vi.fn(() => ({ matches: false })),
    };
    // The form builder schedules focus/emoji work in rAF; make it a no-op so
    // the test doesn't depend on a real animation frame.
    global.requestAnimationFrame = () => {};
    PierreBridge = require(BRIDGE_PATH);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
  });

  function openChatFromForm(data) {
    const bridge = new PierreBridge({});
    const form = bridge._renderFormAnnotation(data, 'ann-1', new Map(), 'src/a.js');
    const chatBtn = form.querySelector('.btn-chat-from-comment');
    expect(chatBtn).toBeTruthy();
    chatBtn.click();
    expect(open).toHaveBeenCalledTimes(1);
    return open.mock.calls[0][0].commentContext;
  }

  it('preserves the LEFT (deletion) side from the form textarea', () => {
    const ctx = openChatFromForm({ lineStart: 4, lineEnd: 4, side: 'LEFT' });
    expect(ctx).toMatchObject({
      type: 'line',
      file: 'src/a.js',
      line_start: 4,
      line_end: 4,
      side: 'LEFT',
      source: 'user',
    });
  });

  it('defaults a missing side to RIGHT', () => {
    const ctx = openChatFromForm({ lineStart: 7, lineEnd: 7 });
    expect(ctx.side).toBe('RIGHT');
  });
});
