// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Rendered Markdown view
 *
 * Covers the user-facing flow for the first-class Rendered/Diff Markdown
 * view: per-file toggle, Outline sidebar navigation, block-level
 * commenting (both in-diff and honest-fallback/out-of-diff targets),
 * relative-link navigation to another changed Markdown file, and the
 * Diff-mode fallback remaining fully intact. Runs against BOTH PR mode
 * (test-owner/test-repo #1) and Local mode (/local/2), which share the
 * same seeded diff (see global-setup.js) — non-markdown files (src/*.js)
 * are asserted to have no Rendered/Diff toggle, guarding against
 * regression of the existing Diff-only behavior.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

async function toggleRendered(page, filePath) {
  const fileWrapper = page.locator(`.d2h-file-wrapper[data-file-name="${filePath}"]`);
  await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Rendered")').click();
  await expect(fileWrapper).toHaveClass(/rendered-mode-active/);
  return fileWrapper;
}

/**
 * Resolve the numeric review id for either mode from its metadata endpoint,
 * so a test can hit the shared `/api/reviews/:id/comments` route directly.
 */
async function getReviewId(page, reviewApiBase) {
  return page.evaluate(async (base) => {
    const meta = await (await fetch(base)).json();
    return meta.data?.id ?? meta.metadata?.id ?? meta.review?.id ?? meta.id;
  }, reviewApiBase);
}

/**
 * The comment count a nested target's badge is currently showing, as a
 * number (0 when the badge is hidden). Tests assert badge counts RELATIVE to
 * this baseline: the seeded review lives in a per-worker in-memory database
 * that persists across every test in the worker, so an absolute `'1'` would
 * be order-dependent and would break outright under `--repeat-each`.
 */
function badgeCount(targetLocator) {
  return targetLocator.evaluate((el) => {
    const badge = el.querySelector('.rendered-markdown-target-badge');
    return badge && !badge.hidden ? Number(badge.textContent) || 0 : 0;
  });
}

/**
 * Delete the comments a test created, through the same API the UI uses, so
 * the shared per-worker review is left exactly as the test found it. Called
 * from a `finally` so it also runs when an assertion above it failed.
 */
async function deleteComments(page, reviewId, commentIds) {
  const ids = commentIds.filter((id) => id != null);
  if (ids.length === 0) return;
  await page.evaluate(async ({ id, targets }) => {
    for (const commentId of targets) {
      await fetch(`/api/reviews/${id}/comments/${commentId}`, { method: 'DELETE' });
    }
  }, { id: reviewId, targets: ids });
}

/**
 * Force a concrete theme on the page without persisting a preference (the
 * shared review DB and the browser context are reused across tests in this
 * file, so a persisted preference would leak). `applyResolved` writes the
 * resolved value to `<html data-theme>`, which is exactly what every theme
 * CSS rule keys off.
 */
async function setTheme(page, theme) {
  await page.evaluate((t) => window.PairReviewTheme.applyResolved(t), theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Select a concrete preference through the production theme-toggle path. */
async function selectThemePreference(page, preference) {
  const target = `Theme: ${preference[0].toUpperCase()}${preference.slice(1)} `;
  const toggle = page.locator('#theme-toggle');
  for (let attempts = 0; attempts < 3; attempts++) {
    if ((await toggle.getAttribute('aria-label'))?.startsWith(target)) return;
    await toggle.click();
  }
  throw new Error(`Could not select ${preference} theme preference`);
}

/**
 * Disable CSS transitions/animations for the rest of the test.
 *
 * The comment action buttons carry `transition: var(--transition-ui)` on
 * `color`, so a computed-style read taken shortly after a theme switch can
 * catch an interpolated colour mid-flight (observed: `rgb(95, 104, 114)`
 * between the light `#57606a` and the dark `#c9d1d9`) and report a
 * difference that does not exist at rest. Freezing transitions makes the
 * steady-state palette the only thing these assertions can see; it changes
 * nothing about WHAT is being compared.
 *
 * NOT redundant with the reset in `tests/e2e/fixtures.js`, despite appearances.
 * That one runs in an `addInitScript` at document-start, where BOTH
 * `document.head` and `document.documentElement` are still null, so it dies
 * on `null.appendChild` before it can insert anything. Measured on this
 * page: zero `transition-duration: 0s` style elements in the document and a
 * `TypeError: Cannot read properties of null (reading 'appendChild')` on the
 * page-error channel. Removing this helper on the assumption the fixture
 * covers it reintroduces the mid-flight read above — reproduced under
 * `--repeat-each=3`. (The fixture itself is shared by every E2E spec and is
 * left alone here rather than changing animation timing suite-wide.)
 */
async function freezeTransitions(page) {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }'
  });
}

/**
 * Computed presentation of the canonical `.user-comment` fragment inside a
 * placement element (a Diff `.user-comment-row` or a Rendered
 * `.rendered-markdown-comment-card`).
 *
 * Deliberately property-based rather than a pixel screenshot: screenshots of
 * a shared, order-dependent review are fragile and tell you nothing about
 * WHICH property drifted. These are the properties that made the two
 * surfaces read as different objects — shell palette/accent/shadow/padding,
 * body typography, the line badge, and the icon action controls.
 */
function cardPresentation(locator) {
  return locator.evaluate((root) => {
    const pick = (el, props) => {
      const cs = getComputedStyle(el);
      const out = {};
      props.forEach((p) => { out[p] = cs[p]; });
      return out;
    };
    const shell = root.querySelector('.user-comment');
    if (!shell) return { missing: ['.user-comment'], placement: root.className };
    const body = shell.querySelector('.user-comment-body');
    const lineInfo = shell.querySelector('.user-comment-line-info');
    const originIcon = shell.querySelector('.comment-origin-icon');
    const actionButtons = Array.from(shell.querySelectorAll('.user-comment-actions > button'));
    // A missing canonical sub-element IS the parity failure. Report it as
    // data the assertion can print, instead of letting `pick(null, ...)`
    // throw an opaque in-page TypeError that says nothing about which
    // surface lost which part of the card.
    const missing = [
      [body, '.user-comment-body'],
      [lineInfo, '.user-comment-line-info'],
      [originIcon, '.comment-origin-icon']
    ].filter(([el]) => !el).map(([, sel]) => sel);
    if (actionButtons.length === 0) missing.push('.user-comment-actions > button');
    if (actionButtons.some((b) => !b.querySelector('svg'))) missing.push('action button <svg>');
    if (missing.length > 0) {
      return { missing, placement: root.className, shellHtml: shell.innerHTML.slice(0, 500) };
    }
    // The canonical action classes, identified BY the shared contract rather
    // than by "whichever class happens to be first": the Rendered surface
    // appends its own behaviour-hook class with `classList.add` after
    // `innerHTML`, so a change in class ordering must not silently turn this
    // into a comparison of hook classes.
    const canonicalActions = (window.UserCommentView && window.UserCommentView.ACTION_ORDER)
      || ['btn-chat-comment', 'btn-edit-comment', 'btn-delete-comment'];
    return {
      shell: pick(shell, [
        'backgroundColor', 'borderTopColor', 'borderLeftColor',
        'borderTopWidth', 'borderLeftWidth', 'borderTopLeftRadius',
        'boxShadow', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
      ]),
      body: pick(body, ['color', 'fontSize', 'fontFamily', 'lineHeight']),
      lineInfo: pick(lineInfo, [
        'backgroundColor', 'color', 'fontSize', 'fontWeight', 'borderTopLeftRadius'
      ]),
      lineInfoText: lineInfo.textContent,
      originIconColor: getComputedStyle(originIcon).color,
      hasOriginIconSvg: !!originIcon.querySelector('svg'),
      // Canonical classes only: the Rendered surface adds a behaviour-hook
      // class to the same button, which is not a presentation difference.
      actionOrder: actionButtons.map((b) => Array.from(b.classList)
        .filter((c) => canonicalActions.includes(c)).join(' ')),
      actionTitles: actionButtons.map((b) => b.getAttribute('title')),
      // Icon-only controls: the accessible name must be explicit and must
      // match the tooltip on every surface.
      actionAriaLabels: actionButtons.map((b) => b.getAttribute('aria-label')),
      actionStyles: actionButtons.map((b) => pick(b, [
        'display', 'color', 'paddingTop', 'paddingLeft', 'borderTopLeftRadius'
      ])),
      actionIconSizes: actionButtons.map((b) => {
        const svg = b.querySelector('svg');
        const cs = getComputedStyle(svg);
        return `${cs.width}x${cs.height}`;
      })
    };
  });
}

for (const { label, url, reviewApiBase } of [
  { label: 'PR mode', url: '/pr/test-owner/test-repo/1', reviewApiBase: '/api/pr/test-owner/test-repo/1' },
  { label: 'Local mode', url: '/local/2', reviewApiBase: '/api/local/2' }
]) {
  test.describe(`Rendered Markdown view — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(url);
      await waitForDiffToRender(page);
    });

    test('shows a Diff/Rendered toggle only on markdown files, not on ordinary source files', async ({ page }) => {
      await expect(page.locator('.d2h-file-wrapper[data-file-name="docs/guide.md"] .file-header-view-toggle')).toBeVisible();
      await expect(page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"] .file-header-view-toggle')).toHaveCount(0);
    });

    test('toggling to Rendered shows headings/paragraphs and toggling back restores the original diff', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      await expect(fileWrapper.locator('.rendered-markdown-block h1')).toHaveText('Guide');
      await expect(fileWrapper.locator('.rendered-markdown-block h2')).toHaveText(['Usage', 'Notes']);
      await expect(
        fileWrapper.locator('.rendered-markdown-block-content', { hasText: 'This paragraph explains usage and was newly added by this PR.' })
      ).toBeVisible();

      // Diff mode is the always-available fallback: the removed line must
      // still be there, untouched, once we switch back.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Diff")').click();
      await expect(fileWrapper).not.toHaveClass(/rendered-mode-active/);
      const shadowText = await fileWrapper.evaluate((el) => {
        const host = el.querySelector('diffs-container');
        return host?.shadowRoot?.textContent || '';
      });
      expect(shadowText).toContain('This paragraph explains usage.');
    });

    test('renders gap-tolerant document rhythm and highlighted scrolling code in both app themes', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const renderedDocument = fileWrapper.locator('.rendered-markdown-doc');
      const usageHeading = fileWrapper
        .locator('.rendered-markdown-heading-block')
        .filter({ hasText: 'Usage' })
        .first();
      const usageParagraph = fileWrapper.locator('.rendered-markdown-block', {
        hasText: 'This paragraph explains usage and was newly added by this PR.'
      });

      const rhythm = await usageHeading.evaluate((element) => ({
        marginTop: getComputedStyle(element).marginTop,
        separatorClass: element.previousElementSibling?.className || '',
        separatorHidden: element.previousElementSibling?.hidden === true
      }));
      expect(rhythm).toEqual({
        marginTop: '20px',
        separatorClass: 'rendered-markdown-gap',
        separatorHidden: true
      });
      await expect(usageParagraph).toHaveCSS('margin-top', '8px');

      const listBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Alpha item' });
      const tableBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Column A' });
      const quoteBlock = fileWrapper.locator('.rendered-markdown-block', {
        hasText: 'A quoted note for rendered rhythm coverage.'
      });
      const codeBlock = fileWrapper.locator('.rendered-markdown-block:has(pre code.language-js)');
      const rhythmElements = [
        usageParagraph.locator('p'),
        listBlock.locator('.rendered-markdown-block-content > ul'),
        tableBlock.locator('.rendered-markdown-block-content > table'),
        quoteBlock.locator('blockquote'),
        codeBlock.locator('pre')
      ];
      for (const element of rhythmElements) {
        expect(await element.evaluate((node) => ({
          marginTop: getComputedStyle(node).marginTop,
          marginBottom: getComputedStyle(node).marginBottom,
          wrapperMargin: getComputedStyle(node.closest('.rendered-markdown-block')).marginTop
        }))).toEqual({ marginTop: '0px', marginBottom: '0px', wrapperMargin: '8px' });
      }

      const pre = codeBlock.locator('pre');
      const code = pre.locator('code');
      const keyword = code.locator('.hljs-keyword');
      await expect(keyword).toHaveText('const');

      const themeCases = [
        { theme: 'light', oppositeOs: 'dark', expectedKeyword: 'rgb(215, 58, 73)' },
        { theme: 'dark', oppositeOs: 'light', expectedKeyword: 'rgb(255, 123, 114)' }
      ];
      for (const { theme, oppositeOs, expectedKeyword } of themeCases) {
        await page.emulateMedia({ colorScheme: oppositeOs });
        await selectThemePreference(page, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const colors = await code.evaluate((element) => ({
          code: getComputedStyle(element).color,
          keyword: getComputedStyle(element.querySelector('.hljs-keyword')).color
        }));
        expect(colors.keyword).toBe(expectedKeyword);
        expect(colors.keyword).not.toBe(colors.code);
      }
      await selectThemePreference(page, 'system');

      const codeOverflow = await pre.evaluate((element) => ({
        scrolls: element.scrollWidth > element.clientWidth,
        whiteSpace: getComputedStyle(element).whiteSpace
      }));
      expect(codeOverflow).toEqual({ scrolls: true, whiteSpace: 'pre' });

      const wideTableContent = fileWrapper.locator('.rendered-markdown-block', {
        hasText: 'Wide column 30'
      }).locator('.rendered-markdown-block-content');
      const documentOverflow = await wideTableContent.evaluate((element) => {
        const doc = element.closest('.rendered-markdown-doc');
        return {
          tableScrolls: element.scrollWidth > element.clientWidth,
          documentFits: doc.scrollWidth <= doc.clientWidth + 1
        };
      });
      expect(documentOverflow).toEqual({ tableScrolls: true, documentFits: true });
      await expect(renderedDocument).toBeVisible();

      await codeBlock.hover();
      const addButton = codeBlock.locator('.rendered-markdown-block-btn');
      await expect(addButton).toBeVisible();
      await addButton.click();
      await expect(codeBlock.locator('.rendered-markdown-comment-form')).toBeVisible();
      await codeBlock.locator('.rendered-markdown-comment-btn.cancel').click();
    });

    test('Outline sidebar lists headings for the Rendered document, supports click-to-scroll, and shows an empty state otherwise', async ({ page }) => {
      await expect(page.locator('#outline-list')).toBeHidden();
      await expect(page.locator('#sidebar-tab-outline')).toBeVisible();
      await page.locator('#sidebar-tab-outline').click();
      await expect(page.locator('#outline-list')).toBeVisible();
      await expect(page.locator('#outline-list .outline-empty-state')).toBeVisible();

      await toggleRendered(page, 'docs/guide.md');
      const items = page.locator('#outline-list .outline-item');
      await expect(items).toHaveText(['Guide', 'Usage', 'Notes']);

      await items.filter({ hasText: 'Usage' }).click();
      await expect(items.filter({ hasText: 'Usage' })).toHaveAttribute('aria-current', 'true');

      const headingInView = await page.evaluate(() => {
        const heading = document.getElementById('md-heading-docs-guide-md--usage');
        const rect = heading.getBoundingClientRect();
        return rect.top >= 0 && rect.top <= window.innerHeight;
      });
      expect(headingInView).toBe(true);
    });

    test('adds an in-diff block comment (gets a diffPosition) and an out-of-diff block comment (honest fallback, no diffPosition), both persisting across reload', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      // Baseline card count for the reload assertion below: the seeded
      // review is shared per worker and this test may be repeated.
      const cardsBefore = await fileWrapper.locator('.rendered-markdown-comment-card').count();

      // In-diff: the "Usage" paragraph is inside the seeded hunk.
      const usageBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'This paragraph explains usage and was newly added' });
      await usageBlock.hover();
      await usageBlock.locator('.rendered-markdown-add-comment-btn').click();
      await usageBlock.locator('.rendered-markdown-comment-textarea').fill('Great addition!');
      const inDiffResponse = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await usageBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const inDiffResult = await (await inDiffResponse).json();
      await expect(usageBlock.locator('.rendered-markdown-comment-card')).toContainText('Great addition!');

      // Out-of-diff (honest fallback): the "Notes" paragraph is far outside
      // every hunk. The context note must be shown, and the comment must
      // still save successfully without a diffPosition.
      const notesBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'unchanged context and sits far' });
      await notesBlock.hover();
      await notesBlock.locator('.rendered-markdown-add-comment-btn').click();
      await expect(notesBlock.locator('.rendered-markdown-context-note')).toBeVisible();
      await notesBlock.locator('.rendered-markdown-comment-textarea').fill('Just a note.');
      const outOfDiffResponse = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await notesBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const outOfDiffResult = await (await outOfDiffResponse).json();
      await expect(notesBlock.locator('.rendered-markdown-comment-card')).toContainText('Just a note.');

      // Verify the stored records directly: in-diff got a diffPosition,
      // the honest fallback did not — and neither was mis-attached to an
      // unrelated file/line.
      const comments = await page.evaluate(async (base) => {
        const metaResp = await fetch(base);
        const meta = await metaResp.json();
        const reviewId = meta.data?.id ?? meta.metadata?.id ?? meta.review?.id ?? meta.id;
        const res = await fetch(`/api/reviews/${reviewId}/comments`);
        return (await res.json()).comments;
      }, reviewApiBase);

      const inDiffComment = comments.find((c) => c.id === inDiffResult.commentId);
      const outOfDiffComment = comments.find((c) => c.id === outOfDiffResult.commentId);
      expect(inDiffComment).toMatchObject({ file: 'docs/guide.md', line_start: 7, line_end: 7 });
      expect(inDiffComment.diff_position).toBeTruthy();
      expect(outOfDiffComment).toMatchObject({ file: 'docs/guide.md', line_start: 11, line_end: 11 });
      expect(outOfDiffComment.diff_position == null).toBe(true);

      // Reload and confirm both comments re-appear in the Rendered view —
      // exactly two MORE cards than were there before this test ran.
      await page.reload();
      await waitForDiffToRender(page);
      const reloadedWrapper = await toggleRendered(page, 'docs/guide.md');
      await expect(reloadedWrapper.locator('.rendered-markdown-comment-card')).toHaveCount(cardsBefore + 2);
      await expect(reloadedWrapper).toContainText('Great addition!');
      await expect(reloadedWrapper).toContainText('Just a note.');

      // Self-cleaning, so the shared per-worker review is left as found.
      await deleteComments(page, reviewId, [inDiffResult.commentId, outOfDiffResult.commentId]);
    });

    test('an out-of-diff Rendered comment also reaches the Diff surface and is counted for submission', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      // Counts are asserted RELATIVE to the starting state: the seeded
      // review is shared across the tests in this file, so an absolute
      // count would be order-dependent.
      const countBefore = await page.evaluate(() => window.CommentCount.countDraftComments(document).total);

      // The last paragraph of the fixture sits far below the file's only
      // (single-line) hunk, so the diff engine has it collapsed — its diff
      // row does not exist yet. Assert that up front, so this test can only
      // pass by actually revealing it.
      const farBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'far-away paragraph is nowhere near' });
      const farLine = parseInt(await farBlock.getAttribute('data-start-line'), 10);
      expect(await page.evaluate(
        (line) => window.prManager.pierreBridge
          ? window.prManager.pierreBridge.isLineVisible('docs/guide.md', line, 'RIGHT')
          : !!document.querySelector(`.d2h-file-wrapper[data-file-name="docs/guide.md"] tr[data-new-line-number="${line}"]`),
        farLine
      )).toBe(false);

      await farBlock.hover();
      await farBlock.locator('.rendered-markdown-add-comment-btn').click();
      await farBlock.locator('.rendered-markdown-comment-textarea').fill('Out-of-diff feedback.');
      const response = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await farBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const { commentId } = await (await response).json();

      // The regression: the comment must be REACHABLE on the Diff surface
      // too. Its line was collapsed a moment ago, so this only holds if the
      // enclosing gap / context range was revealed before syncing.
      await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(1);

      // Counted exactly ONCE more than before, even though the comment now
      // has a card on two surfaces. `CommentCount` is the shared counter
      // PRManager.updateCommentCount/submitReview and both ReviewModal call
      // sites delegate to, so asserting it here covers the toolbar count,
      // "N comments will be submitted" and the Request-changes validation
      // at their single source of truth.
      await expect(page.locator('#split-button-text')).toContainText(`(${countBefore + 1})`);
      await expect(page.locator('#split-button-main')).toHaveClass(/has-comments/);
      expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
        .toBe(countBefore + 1);

      // And it is actually visible once the reviewer toggles back to Diff.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Diff")').click();
      await expect(fileWrapper).not.toHaveClass(/rendered-mode-active/);
      await expect(fileWrapper.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toBeVisible();

      // Deleting it from the Rendered card removes it from BOTH surfaces
      // and the count returns to where it started — no stale +1 left behind
      // by counting before the card was actually removed.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Rendered")').click();
      await expect(fileWrapper).toHaveClass(/rendered-mode-active/);
      await fileWrapper
        .locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"] .rendered-markdown-comment-delete`)
        .click();
      await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`)).toHaveCount(0);
      await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(0);
      expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
        .toBe(countBefore);
    });

    test('an existing comment on a blank separator line is shown at its true position with its real line number', async ({ page }) => {
      // guide.md new content line 8 is the blank line between the "Usage"
      // paragraph (line 7) and the "## Notes" heading (line 9) — trivially
      // easy to land on from the Diff view, and rendered by no block.
      const reviewId = await getReviewId(page, reviewApiBase);
      const created = await page.evaluate(async (id) => {
        const res = await fetch(`/api/reviews/${id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: 'docs/guide.md',
            line_start: 8,
            line_end: 8,
            side: 'RIGHT',
            diff_position: null,
            body: 'Comment on a blank separator line.'
          })
        });
        return res.json();
      }, reviewId);

      try {
        await page.reload();
        await waitForDiffToRender(page);
        const fileWrapper = await toggleRendered(page, 'docs/guide.md');

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`);
        await expect(card).toBeVisible();
        await expect(card).toContainText('Comment on a blank separator line.');
        // Honest repository line metadata...
        await expect(card.locator('.user-comment-line-info')).toHaveText('Line 8');
        // ...in its own gap container at the true source position...
        await expect(fileWrapper.locator('.rendered-markdown-gap[data-start-line="8"]')).toBeVisible();
        // ...and NOT silently reattached to a neighbouring heading/paragraph.
        expect(await card.evaluate((el) => !!el.closest('.rendered-markdown-block'))).toBe(false);
        // Exactly one card for this comment across the whole page, so the
        // blank-line comment is not also duplicated onto a block.
        await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`))
          .toHaveCount(1);
      } finally {
        // API-created and never deleted through the UI, so this test owns
        // its cleanup: the seeded review lives in a per-worker database
        // shared with every other spec, and a leftover comment would shift
        // any sibling's baseline. Same `finally` contract as the
        // UI-driven tests above.
        await deleteComments(page, reviewId, [created.commentId]);
      }
    });

    test('gap containers are shown only when they actually hold a comment', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      // The rendered document is built asynchronously (file-contents fetch);
      // the orphan zone is created unconditionally by render(), so its
      // presence is the deterministic "document is built" signal. (Counting
      // it, rather than asserting visibility, because it is hidden while
      // empty — which is exactly what this test verifies.)
      await expect(fileWrapper.locator('.rendered-markdown-orphan-comments')).toHaveCount(1);
      // Property-based (and therefore order-independent): every gap /
      // orphan container is hidden exactly when it holds no comment card,
      // so an ordinary document is visually unchanged by the feature.
      const containers = await fileWrapper.evaluate((el) =>
        Array.from(el.querySelectorAll('.rendered-markdown-gap, .rendered-markdown-orphan-comments'))
          .map((c) => ({
            cls: c.className,
            hidden: c.hidden,
            cards: c.querySelectorAll('.rendered-markdown-comment-card').length
          }))
      );
      expect(containers.length).toBeGreaterThan(0);
      for (const c of containers) {
        expect(c.hidden, `${c.cls} with ${c.cards} card(s)`).toBe(c.cards === 0);
      }
    });

    /**
     * Hierarchical comment targets. The fixture's tail (see test-server.js)
     * is a two-level list followed by a two-column table whose body cells
     * share ONE source line — the case line numbers alone cannot express.
     */
    test('exposes container, list-item, nested-item, row and cell targets with accessible names', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      // Prefix-matched on purpose: the seeded review is shared across the
      // tests in this file, and a target that already carries a comment
      // appends its count to the button's accessible name.
      const ariaLabels = (locator) =>
        locator.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label').replace(/ \(\d+ comments?\)$/, '')));

      const listBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Alpha item' });
      // The whole-list target is still there, alongside the per-item ones.
      await expect(listBlock.locator('.rendered-markdown-block-btn'))
        .toHaveAttribute('aria-label', /Add comment on the whole list/);
      expect(await ariaLabels(
        listBlock.locator('li > .rendered-markdown-target-affordance > .rendered-markdown-target-btn')
      )).toEqual([
        'Add comment on Nested list item, line 66',
        'Add comment on List item, lines 65–66',
        'Add comment on List item, line 67'
      ]);

      const tableBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Column A' });
      await expect(tableBlock.locator('.rendered-markdown-block-btn'))
        .toHaveAttribute('aria-label', /Add comment on the whole table/);
      expect(await ariaLabels(tableBlock.locator('.rendered-markdown-row-gutter .rendered-markdown-target-btn')))
        .toEqual([
          'Add comment on Table row, line 69',
          'Add comment on Table row, line 71'
        ]);
      expect(await ariaLabels(tableBlock.locator('tbody td.rendered-markdown-target .rendered-markdown-target-btn')))
        .toEqual([
          'Add comment on Table cell, line 71, column 1',
          'Add comment on Table cell, line 71, column 2'
        ]);

      // Structural validity: nothing invalid was injected under the table,
      // its rows, or the lists.
      const structuralViolations = await tableBlock.evaluate((el) => {
        const bad = [];
        el.querySelectorAll('table').forEach((t) => {
          Array.from(t.children).forEach((c) => {
            if (!['THEAD', 'TBODY', 'TFOOT', 'CAPTION', 'COLGROUP'].includes(c.tagName)) bad.push(`table>${c.tagName}`);
          });
        });
        el.querySelectorAll('tr').forEach((r) => {
          Array.from(r.children).forEach((c) => {
            if (!['TH', 'TD'].includes(c.tagName)) bad.push(`tr>${c.tagName}`);
          });
        });
        el.querySelectorAll('ul,ol').forEach((l) => {
          Array.from(l.children).forEach((c) => {
            if (c.tagName !== 'LI') bad.push(`list>${c.tagName}`);
          });
        });
        return bad;
      });
      expect(structuralViolations).toEqual([]);

      // The row gutter is UI chrome, not a data column: it must be marked
      // presentational (otherwise every row announces one more column than
      // the header has), while its button stays a focusable, named button.
      const gutterA11y = await tableBlock.evaluate((el) =>
        Array.from(el.querySelectorAll('td.rendered-markdown-row-gutter')).map((td) => ({
          role: td.getAttribute('role'),
          ariaHidden: td.closest('[aria-hidden="true"]') !== null,
          btnTag: td.querySelector('.rendered-markdown-target-btn')?.tagName,
          btnTabIndex: td.querySelector('.rendered-markdown-target-btn')?.getAttribute('tabindex'),
          btnLabel: td.querySelector('.rendered-markdown-target-btn')?.getAttribute('aria-label')
        }))
      );
      expect(gutterA11y.length).toBe(2);
      for (const g of gutterA11y) {
        expect(g.role).toBe('presentation');
        expect(g.ariaHidden).toBe(false);
        expect(g.btnTag).toBe('BUTTON');
        expect(g.btnTabIndex).toBeNull();
        expect(g.btnLabel).toMatch(/^Add comment on Table row, line \d+/);
      }
      // Keyboard-focusable in the real browser, not just in principle.
      const firstGutterBtn = tableBlock.locator('.rendered-markdown-row-gutter .rendered-markdown-target-btn').first();
      await firstGutterBtn.focus();
      await expect(firstGutterBtn).toBeFocused();

      // Hovering a nested item reveals exactly one affordance — the
      // innermost target's — not the parent item's and not the list's.
      await fileWrapper.locator('li li', { hasText: 'Nested alpha item' }).hover();
      await expect(fileWrapper.locator('.is-target-active')).toHaveCount(1);
      await expect(fileWrapper.locator('.is-target-active')).toContainText('Nested alpha item');
    });

    test('two comments on two cells of one source line each return to their own cell after reload', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const tableBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Column A' });
      const cells = tableBlock.locator('tbody td.rendered-markdown-target');

      // Baselines, because the seeded review is shared per worker and this
      // test may itself be repeated (`--repeat-each`).
      const badgesBefore = [await badgeCount(cells.nth(0)), await badgeCount(cells.nth(1))];

      const commentIds = [];
      try {
        for (const [index, text] of [[0, 'About cell a1.'], [1, 'About cell b1.']]) {
          const cell = cells.nth(index);
          await cell.hover();
          await cell.locator('.rendered-markdown-target-btn').click();
          await expect(tableBlock.locator('.rendered-markdown-comment-form .rendered-markdown-comment-target'))
            .toHaveText(`Commenting on Table cell, line 71, column ${index + 1}`);
          await tableBlock.locator('.rendered-markdown-comment-textarea').fill(text);
          const response = page.waitForResponse(
            (r) => r.url().includes('/comments') && r.request().method() === 'POST'
          );
          await tableBlock.locator('.rendered-markdown-comment-btn.submit').click();
          commentIds.push((await (await response).json()).commentId);
        }

        // Both stored comments carry the SAME honest line-based GitHub
        // coordinates (the row's source line); only the local descriptor
        // tells the two cells apart.
        const stored = await page.evaluate(
          async (id) => (await (await fetch(`/api/reviews/${id}/comments`)).json()).comments,
          reviewId
        );
        const [first, second] = commentIds.map((id) => stored.find((c) => c.id === id));
        expect(first).toMatchObject({ file: 'docs/guide.md', line_start: 71, line_end: 71, side: 'RIGHT' });
        expect(second).toMatchObject({ file: 'docs/guide.md', line_start: 71, line_end: 71, side: 'RIGHT' });
        expect(JSON.parse(first.rendered_anchor)).toEqual({ v: 1, kind: 'table-cell', startLine: 71, endLine: 71, ordinal: 0 });
        expect(JSON.parse(second.rendered_anchor)).toEqual({ v: 1, kind: 'table-cell', startLine: 71, endLine: 71, ordinal: 1 });

        await page.reload();
        await waitForDiffToRender(page);
        const reloaded = await toggleRendered(page, 'docs/guide.md');
        const reloadedTable = reloaded.locator('.rendered-markdown-block', { hasText: 'Column A' });
        const reloadedCells = reloadedTable.locator('tbody td.rendered-markdown-target');

        // Each cell gained EXACTLY ONE comment of its own — relative to the
        // baseline above, so pre-existing state cannot change the meaning.
        await expect(reloadedCells.nth(0).locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgesBefore[0] + 1));
        await expect(reloadedCells.nth(1).locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgesBefore[1] + 1));
        // ...and each card names the cell it belongs to, with no stale
        // marker. Scoped by comment id, so only this test's cards matter.
        await expect(
          reloadedTable.locator(`.rendered-markdown-comment-card[data-comment-id="${commentIds[0]}"] .rendered-markdown-comment-target`)
        ).toHaveText('Table cell, line 71, column 1');
        await expect(
          reloadedTable.locator(`.rendered-markdown-comment-card[data-comment-id="${commentIds[1]}"] .rendered-markdown-comment-target`)
        ).toHaveText('Table cell, line 71, column 2');
        await expect(reloaded.locator('.rendered-markdown-comment-target.is-stale')).toHaveCount(0);
      } finally {
        // Self-cleaning: leave the shared per-worker review as we found it,
        // on the failure path too.
        await deleteComments(page, reviewId, commentIds);
      }
    });

    test('a nested list-item comment is created, counted once, editable and deletable across surfaces', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const countBefore = await page.evaluate(() => window.CommentCount.countDraftComments(document).total);

      const nestedItem = fileWrapper.locator('li li', { hasText: 'Nested alpha item' });
      const badgeBefore = await badgeCount(nestedItem);
      let commentId = null;
      try {
        await nestedItem.hover();
        await nestedItem.locator('.rendered-markdown-target-btn').click();
        await fileWrapper.locator('.rendered-markdown-comment-textarea').fill('Nested item feedback.');
        const response = page.waitForResponse(
          (r) => r.url().includes('/comments') && r.request().method() === 'POST'
        );
        await fileWrapper.locator('.rendered-markdown-comment-btn.submit').click();
        ({ commentId } = await (await response).json());

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`);
        await expect(card.locator('.rendered-markdown-comment-target')).toHaveText('Nested list item, line 66');
        // Relative to the baseline: the badge gained exactly this comment.
        await expect(nestedItem.locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgeBefore + 1));

        // Counted exactly once even though the comment also reaches the Diff
        // surface (its out-of-hunk target is revealed before syncing).
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(1);
        expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
          .toBe(countBefore + 1);

        // Edit in place from the nested card, then delete: both surfaces and
        // the badge must follow.
        await card.locator('.rendered-markdown-comment-edit').click();
        await card.locator('.rendered-markdown-comment-body textarea').fill('Edited nested feedback.');
        await card.locator('.rendered-markdown-comment-body .submit').click();
        await expect(card.locator('.rendered-markdown-comment-body')).toContainText('Edited nested feedback.');
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`))
          .toContainText('Edited nested feedback.');

        await card.locator('.rendered-markdown-comment-delete').click();
        await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`)).toHaveCount(0);
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(0);
        commentId = null; // deleted through the UI; nothing left to clean up
        // Back to the baseline — hidden only when it started at zero.
        if (badgeBefore === 0) {
          await expect(nestedItem.locator('.rendered-markdown-target-badge')).toBeHidden();
        } else {
          await expect(nestedItem.locator('.rendered-markdown-target-badge')).toHaveText(String(badgeBefore));
        }
        expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
          .toBe(countBefore);
      } finally {
        // Only reached if an assertion failed before the UI delete above.
        await deleteComments(page, reviewId, [commentId]);
      }
    });

    test('a comment with no nested descriptor stays on its top-level block, never on a cell', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const created = await page.evaluate(async (id) => {
        const res = await fetch(`/api/reviews/${id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: 'docs/guide.md',
            line_start: 71,
            line_end: 71,
            side: 'RIGHT',
            body: 'Legacy comment on the table row line.'
          })
        });
        return res.json();
      }, reviewId);

      try {
        await page.reload();
        await waitForDiffToRender(page);
        const fileWrapper = await toggleRendered(page, 'docs/guide.md');

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`);
        await expect(card).toBeVisible();
        // Shown on the table BLOCK, with no target claim of any kind.
        await expect(card.locator('.rendered-markdown-comment-target')).toHaveCount(0);
        expect(await card.evaluate((el) => el.closest('.rendered-markdown-block')?.dataset.startLine)).toBe('69');

        // No nested target gained a comment because of it. Asserted as a
        // PROPERTY rather than an absolute count, because the seeded review is
        // shared across the tests in this file: every visible badge must be
        // backed by exactly that many target-anchored cards, and this
        // descriptor-less comment is not one of them.
        const badgesMatchCards = await fileWrapper.evaluate((el) => {
          const cardsByKey = new Map();
          el.querySelectorAll('.rendered-markdown-comment-card[data-rendered-target-key]').forEach((c) => {
            const key = c.dataset.renderedTargetKey;
            cardsByKey.set(key, (cardsByKey.get(key) || 0) + 1);
          });
          const badgeTotal = Array.from(el.querySelectorAll('.rendered-markdown-target-badge'))
            .filter((b) => !b.hidden)
            .reduce((sum, b) => sum + Number(b.textContent), 0);
          const cardTotal = Array.from(cardsByKey.values()).reduce((a, b) => a + b, 0);
          return { badgeTotal, cardTotal };
        });
        expect(badgesMatchCards.badgeTotal).toBe(badgesMatchCards.cardTotal);
      } finally {
        // API-created and never deleted through the UI — see the identical
        // cleanup on the blank-separator-line test above. Leaving this
        // legacy row-line comment behind would add a permanent card (and a
        // baseline shift) to the shared per-worker review.
        await deleteComments(page, reviewId, [created.commentId]);
      }
    });

    test('a relative link to another changed markdown file navigates there in Rendered mode; the external link stays a normal link', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      const externalLink = fileWrapper.locator('a:has-text("GitHub")');
      await expect(externalLink).toHaveAttribute('href', 'https://github.com');
      await expect(externalLink).not.toHaveClass(/rendered-markdown-internal-link/);

      const setupLink = fileWrapper.locator('a:has-text("Setup")');
      await expect(setupLink).toHaveClass(/rendered-markdown-internal-link/);
      await setupLink.click();

      const setupWrapper = page.locator('.d2h-file-wrapper[data-file-name="docs/setup.md"]');
      await expect(setupWrapper).toHaveClass(/rendered-mode-active/);
      await expect(
        setupWrapper.locator('.rendered-markdown-block-content', { hasText: 'Follow these steps to set up the project.' })
      ).toBeVisible();
    });

    for (const theme of ['light', 'dark']) {
      test(`one saved comment presents identically in Diff and Rendered mode (${theme} theme)`, async ({ page }) => {
        // Line 7 (the "Usage" paragraph) is inside the fixture's only hunk,
        // so this ONE stored comment has a card on BOTH surfaces at once —
        // which is exactly the condition the reviewer sees when toggling.
        const reviewId = await getReviewId(page, reviewApiBase);
        const created = await page.evaluate(async (id) => {
          const res = await fetch(`/api/reviews/${id}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file: 'docs/guide.md',
              line_start: 7,
              line_end: 7,
              side: 'RIGHT',
              body: 'Presentation parity check.'
            })
          });
          return res.json();
        }, reviewId);

        try {
          await page.reload();
          await waitForDiffToRender(page);
          // Must come BEFORE setTheme: it is the theme switch that starts
          // the colour transitions this test would otherwise read mid-flight.
          await freezeTransitions(page);
          await setTheme(page, theme);

          const fileWrapper = page.locator('.d2h-file-wrapper[data-file-name="docs/guide.md"]');
          await fileWrapper.scrollIntoViewIfNeeded();

          const diffRow = page.locator(`.user-comment-row[data-comment-id="${created.commentId}"]`);
          await expect(diffRow).toHaveCount(1);
          await expect(diffRow).toBeVisible();
          const diffPresentation = await cardPresentation(diffRow);
          // `missing` names the canonical parts a surface failed to emit, so
          // a structural regression reads as data instead of a TypeError.
          expect(diffPresentation.missing).toBeUndefined();

          await toggleRendered(page, 'docs/guide.md');
          const renderedCard = fileWrapper.locator(
            `.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`
          );
          await expect(renderedCard).toBeVisible();
          const renderedPresentation = await cardPresentation(renderedCard);
          expect(renderedPresentation.missing).toBeUndefined();

          // The whole point: same object, same computed presentation.
          expect(renderedPresentation).toEqual(diffPresentation);
          expect(renderedPresentation.actionOrder).toEqual([
            'btn-chat-comment', 'btn-edit-comment', 'btn-delete-comment'
          ]);
          // Icon-only controls need an explicit accessible name on BOTH
          // surfaces; `title` alone is exposed inconsistently and is
          // invisible to touch users.
          expect(renderedPresentation.actionAriaLabels).toEqual(
            renderedPresentation.actionTitles
          );
          expect(renderedPresentation.actionAriaLabels).toEqual([
            'Chat about comment', 'Edit comment', 'Dismiss comment'
          ]);
          expect(renderedPresentation.hasOriginIconSvg).toBe(true);
          expect(renderedPresentation.lineInfoText).toBe('Line 7');

          // Sanity: the theme really did change the palette, so an
          // all-defaults false pass is impossible.
          if (theme === 'dark') {
            expect(renderedPresentation.body.color).not.toBe('rgb(31, 35, 40)');
          } else {
            expect(renderedPresentation.body.color).toBe('rgb(31, 35, 40)');
          }

          // The Rendered placement adapter must stay a placement adapter: no
          // Diff row identity (which would double-count the comment) and no
          // second card shell of its own.
          expect(await renderedCard.evaluate((el) => ({
            isDiffRow: el.classList.contains('user-comment-row'),
            adapterBackground: getComputedStyle(el).backgroundColor,
            adapterBorder: getComputedStyle(el).borderLeftWidth,
            shells: el.querySelectorAll('.user-comment').length
          }))).toEqual({
            isDiffRow: false,
            adapterBackground: 'rgba(0, 0, 0, 0)',
            adapterBorder: '0px',
            shells: 1
          });

          // Guard against a false pass: the comparison above is only
          // meaningful if the Diff row and the Rendered card are genuinely
          // two different elements that are BOTH present right now.
          expect(await page.evaluate((id) => {
            const wanted = String(id);
            const diffRows = Array.from(document.querySelectorAll('.user-comment-row'))
              .filter((el) => el.dataset.commentId === wanted).length;
            const cards = Array.from(document.querySelectorAll('.rendered-markdown-comment-card'))
              .filter((el) => el.dataset.commentId === wanted).length;
            return { diffRows, cards };
          }, created.commentId)).toEqual({ diffRows: 1, cards: 1 });
        } finally {
          await deleteComments(page, reviewId, [created.commentId]);
        }
      });
    }

    test('the Rendered card\'s canonical chat, edit and dismiss controls drive the rendered lifecycle', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const countBefore = await page.evaluate(() => window.CommentCount.countDraftComments(document).total);

      let commentId = null;
      let chatPanelInstrumented = false;
      try {
        const usageBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'This paragraph explains usage' });
        await usageBlock.hover();
        await usageBlock.locator('.rendered-markdown-add-comment-btn').click();
        await usageBlock.locator('.rendered-markdown-comment-textarea').fill('Canonical controls check.');
        const response = page.waitForResponse(
          (r) => r.url().includes('/comments') && r.request().method() === 'POST'
        );
        await usageBlock.locator('.rendered-markdown-comment-btn.submit').click();
        ({ commentId } = await (await response).json());

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`);
        await expect(card).toBeVisible();

        // --- chat: exactly one open, with this comment's own context ------
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-chat', 'available');
          window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
        });
        // Instrument the real panel rather than counting rendered context
        // cards: "opened twice" is the regression, and a second open with
        // identical context could otherwise be invisible in the DOM.
        // The original is stashed on `window` and put back in the `finally`
        // below: this page/context is reused by later tests in the file, and
        // a leaked wrapper would keep pushing into a stale array.
        await page.evaluate(() => {
          window.__chatOpens = [];
          window.__chatOpenOriginal = window.chatPanel.open;
          const original = window.chatPanel.open.bind(window.chatPanel);
          window.chatPanel.open = (opts) => {
            window.__chatOpens.push(opts);
            return original(opts);
          };
        });
        chatPanelInstrumented = true;
        await card.locator('.btn-chat-comment').click();
        const opens = await page.evaluate(() => window.__chatOpens);
        expect(opens).toHaveLength(1);
        expect(opens[0].commentContext).toMatchObject({
          commentId: String(commentId),
          body: 'Canonical controls check.',
          file: 'docs/guide.md',
          line_start: 7,
          line_end: 7,
          source: 'user'
        });
        await expect(page.locator('.chat-panel')).toBeVisible();
        await page.locator('.chat-panel__close-btn').click();

        // --- edit: in-place, actions hidden while editing -----------------
        await card.locator('.btn-edit-comment').click();
        await expect(card.locator('.user-comment')).toHaveClass(/editing-mode/);
        await expect(card.locator('.user-comment-actions')).toBeHidden();
        await card.locator('.user-comment-body textarea').fill('Edited through the canonical controls.');
        await card.locator('.user-comment-body .submit').click();
        await expect(card.locator('.user-comment-body')).toContainText('Edited through the canonical controls.');
        await expect(card.locator('.user-comment')).not.toHaveClass(/editing-mode/);
        await expect(card.locator('.user-comment-actions')).toBeVisible();
        // The edit reached the Diff surface too.
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`))
          .toContainText('Edited through the canonical controls.');

        // --- dismiss: removes the comment from both surfaces --------------
        await card.locator('.btn-delete-comment').click();
        await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`)).toHaveCount(0);
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(0);
        commentId = null; // deleted through the UI; nothing left to clean up
        expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
          .toBe(countBefore);
      } finally {
        // Un-instrument the chat panel before anything else, so the page is
        // handed back to later tests exactly as it was found. Guarded by a
        // flag AND a try/catch: a navigation between here and the patch
        // would have discarded `window.__chatOpenOriginal`, and a cleanup
        // failure must not mask the assertion failure that got us here.
        if (chatPanelInstrumented) {
          try {
            await page.evaluate(() => {
              if (window.chatPanel && window.__chatOpenOriginal) {
                window.chatPanel.open = window.__chatOpenOriginal;
              }
              delete window.__chatOpenOriginal;
              delete window.__chatOpens;
            });
          } catch {
            // Page already gone; nothing to restore.
          }
        }
        // `deleteComments` filters out null ids, so the success path (which
        // sets `commentId = null` after deleting through the UI) is a no-op
        // here rather than a DELETE for `/comments/null`.
        await deleteComments(page, reviewId, [commentId]);
      }
    });
  });
}
