// @vitest-environment jsdom
// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The landing page names the code hosts it accepts PR URLs from. That copy is
 * derived from /api/config (`pr_host_list` / `pr_url_hostnames`), not
 * hardcoded, so an alt host configured via `repos[*].links.external.name`
 * appears without patching the shipped strings — and Graphite does NOT appear
 * unless `enable_graphite` is on.
 *
 * Exercises the real public/js/index.js exports against a jsdom document that
 * mirrors the relevant parts of public/index.html.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const INDEX_MARKUP = `
  <button id="help-btn"></button>
  <div id="help-modal-overlay"><button id="help-modal-close"></button></div>
  <form id="start-review-form">
    <input id="pr-url-input" placeholder="Enter PR URL">
  </form>
  <div id="start-review-error-pr"></div>
  <input id="local-path-input">
  <div id="start-review-error-local"></div>
  <p>From anywhere, using a full <span data-pr-host-list>GitHub</span> URL:</p>
`;

const path = require('path');
const INDEX_JS = path.resolve(__dirname, '../../public/js/index.js');

let indexModule;

beforeEach(() => {
  document.body.innerHTML = INDEX_MARKUP;
  // Loaded by a preceding <script> tag in the real page.
  window.PairReviewTheme = { setup: () => {} };
  // The IIFE caches host state in module scope; reload it per test so each
  // case starts from the shipped host-neutral defaults.
  delete require.cache[INDEX_JS];
  indexModule = require(INDEX_JS);
});

describe('landing-page host list', () => {
  it('ships host-neutral defaults before /api/config resolves', () => {
    expect(document.getElementById('pr-url-input').placeholder).toBe('Enter PR URL');
    // Not "Pass GitHub URLs": naming the built-ins before the real list arrives
    // would deny alt-host/Graphite URLs that this install does accept.
    expect(indexModule.localReviewPathUrlError())
      .toBe('Local reviews require a filesystem path, not a URL. '
        + 'Pass PR URLs as PR review inputs instead.');
  });

  it('names GitHub only when Graphite is disabled and no alt host is configured', () => {
    indexModule.applyPrHostList({ pr_host_names: ['GitHub'], pr_host_list: 'GitHub' });

    expect(document.getElementById('pr-url-input').placeholder).toBe('Enter GitHub PR URL');
    expect(document.querySelector('[data-pr-host-list]').textContent).toBe('GitHub');
    expect(indexModule.localReviewPathUrlError())
      .toBe('Local reviews require a filesystem path, not a URL. '
        + 'Pass GitHub URLs as PR review inputs instead.');
  });

  it('adds Graphite when it is enabled', () => {
    indexModule.applyPrHostList({
      pr_host_names: ['GitHub', 'Graphite'],
      pr_host_list: 'GitHub or Graphite'
    });

    expect(document.getElementById('pr-url-input').placeholder)
      .toBe('Enter GitHub or Graphite PR URL');
    expect(document.querySelector('[data-pr-host-list]').textContent)
      .toBe('GitHub or Graphite');
  });

  it('names a configured alt host alongside the built-ins', () => {
    indexModule.applyPrHostList({
      pr_host_names: ['GitHub', 'Graphite', 'Meteorite'],
      pr_host_list: 'GitHub, Graphite, or Meteorite'
    });

    expect(document.getElementById('pr-url-input').placeholder)
      .toBe('Enter GitHub, Graphite, or Meteorite PR URL');
    expect(document.querySelector('[data-pr-host-list]').textContent)
      .toBe('GitHub, Graphite, or Meteorite');
    expect(indexModule.localReviewPathUrlError())
      .toContain('Pass GitHub, Graphite, or Meteorite URLs');
  });

  it('leaves the defaults alone for a malformed or missing payload', () => {
    indexModule.applyPrHostList(null);
    indexModule.applyPrHostList({});
    indexModule.applyPrHostList({ pr_host_list: '' });

    expect(document.getElementById('pr-url-input').placeholder).toBe('Enter PR URL');
    expect(indexModule.localReviewPathUrlError()).toContain('Pass PR URLs');
  });
});

// The "that's a URL" error is marked with a dataset flag so it can be cleared
// without comparing message text (the text names the configured hosts). Unlike
// the text comparison it replaced, a flag is not self-correcting: it must be
// dropped by every writer that replaces or hides the message, or the next
// keystroke dismisses somebody else's error.
describe('local-path URL error flag lifetime', () => {
  const errorEl = () => document.getElementById('start-review-error-local');

  it('marks the element and clears it when a real path is typed', () => {
    indexModule.showLocalPathUrlError();
    expect(errorEl().dataset.localPathUrlError).toBe('true');
    expect(errorEl().classList.contains('visible')).toBe(true);

    document.getElementById('local-path-input').value = '/Users/test/repo';
    indexModule.handleLocalPathInput();

    expect(errorEl().dataset.localPathUrlError).toBeUndefined();
    expect(errorEl().classList.contains('visible')).toBe(false);
  });

  it('does not dismiss an unrelated error shown after it', () => {
    indexModule.showLocalPathUrlError();
    // e.g. the directory picker failing while the URL error is on screen.
    indexModule.showError('local', 'Failed to open directory picker');
    expect(errorEl().dataset.localPathUrlError).toBeUndefined();

    document.getElementById('local-path-input').value = '/Users/test/repo';
    indexModule.handleLocalPathInput();

    expect(errorEl().textContent).toBe('Failed to open directory picker');
    expect(errorEl().classList.contains('visible')).toBe(true);
  });

  it('does not dismiss an unrelated info message shown after it', () => {
    indexModule.showLocalPathUrlError();
    indexModule.showInfo('local', 'Reusing the existing review');
    expect(errorEl().dataset.localPathUrlError).toBeUndefined();

    document.getElementById('local-path-input').value = '/Users/test/repo';
    indexModule.handleLocalPathInput();

    expect(errorEl().textContent).toBe('Reusing the existing review');
    expect(errorEl().classList.contains('visible')).toBe(true);
  });
});

describe('local-path URL detection', () => {
  it('recognises the built-in hosts without any config', () => {
    expect(indexModule.isUrlLikeLocalReviewPath('https://github.com/o/r/pull/1')).toBe(true);
    expect(indexModule.isUrlLikeLocalReviewPath('github.com/o/r/pull/1')).toBe(true);
    expect(indexModule.isUrlLikeLocalReviewPath('app.graphite.dev/github/o/r/pull/1')).toBe(true);
    expect(indexModule.isUrlLikeLocalReviewPath('/Users/test/repo')).toBe(false);
  });

  it('recognises a scheme-less alt-host URL once /api/config supplies its hostname', () => {
    expect(indexModule.isUrlLikeLocalReviewPath('meteorite.example/o/r/pull/1')).toBe(false);

    indexModule.applyPrHostList({
      pr_host_list: 'GitHub or Meteorite',
      pr_url_hostnames: ['github.com', 'meteorite.example']
    });

    expect(indexModule.isUrlLikeLocalReviewPath('meteorite.example/o/r/pull/1')).toBe(true);
    expect(indexModule.isUrlLikeLocalReviewPath('METEORITE.EXAMPLE/o/r/pull/1')).toBe(true);
    // A hostname-shaped directory is still a path.
    expect(indexModule.isUrlLikeLocalReviewPath('meteorite.example')).toBe(false);
    expect(indexModule.isUrlLikeLocalReviewPath('/src/meteorite.example/repo')).toBe(false);
  });
});
