// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Markdown Rendering (html:true + DOMPurify)
 *
 * Verifies, through the real browser + server, that the shared markdown
 * renderer (window.renderMarkdown) now:
 *   - renders the GitHub-supported inline HTML subset (e.g. <sub>) as real
 *     elements instead of visible escaped text, and
 *   - strips HTML comment markers (e.g. <!-- thread-id:... -->) so they are
 *     not shown in the rendered comment body.
 *
 * markdown-it is configured with html:true and the output is sanitized with
 * DOMPurify (both loaded via CDN <script> in public/pr.html before
 * /js/utils/markdown.js). This affects ALL comment rendering, so it is exercised
 * here through the real comment-creation flow used by comment-crud.spec.js.
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, openCommentFormOnLine } from './helpers.js';

// Helper to clean up all user comments (call via API to ensure clean state).
// Mirrors the cleanupAllComments pattern in comment-crud.spec.js.
async function cleanupAllComments(page) {
  await page.evaluate(async () => {
    const commentsResponse = await fetch('/api/reviews/1/comments?includeDismissed=true');
    const data = await commentsResponse.json();
    const comments = data.comments || [];
    for (const comment of comments) {
      await fetch(`/api/reviews/1/comments/${comment.id}`, { method: 'DELETE' });
    }
  });
}

// Create a user comment on the first diff line with the given body and return
// the rendered comment body locator (the element produced by renderMarkdown).
async function createComment(page, body) {
  await openCommentFormOnLine(page, 0);
  const textarea = page.locator('.user-comment-form textarea');
  await expect(textarea).toBeVisible();
  await textarea.fill(body);
  await page.locator('.save-comment-btn').click();
  await expect(page.locator('.user-comment-form')).not.toBeVisible({ timeout: 5000 });
  const commentRow = page.locator('.user-comment-row').first();
  await expect(commentRow).toBeVisible({ timeout: 5000 });
  return commentRow.locator('.user-comment-body').first();
}

test.describe('Markdown Rendering (html:true + DOMPurify)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllComments(page);
  });

  test('renders GitHub inline HTML like <sub> as a real element', async ({ page }) => {
    const commentBody = await createComment(page, 'Water formula: H<sub>2</sub>O');

    // The <sub> must render as a real element (not escaped text) inside the body.
    const subEl = commentBody.locator('sub');
    await expect(subEl).toBeVisible({ timeout: 5000 });
    await expect(subEl).toHaveText('2');

    // Sanity: the rendered body must NOT contain the escaped tag as literal text,
    // which is what the old escape-only renderer would have produced.
    await expect(commentBody).not.toContainText('<sub>');
  });

  test('strips HTML comment markers from the rendered body', async ({ page }) => {
    const marker = 'thread-id:abc123';
    const commentBody = await createComment(
      page,
      `Visible comment text. <!-- ${marker} -->`
    );

    // The visible text still renders.
    await expect(commentBody).toContainText('Visible comment text.');

    // The HTML comment marker must be stripped from the rendered output: neither
    // the marker payload nor the comment delimiter should appear as text or HTML.
    await expect(commentBody).not.toContainText('thread-id');
    await expect(commentBody).not.toContainText('<!--');

    const innerHTML = await commentBody.evaluate((el) => el.innerHTML);
    expect(innerHTML).not.toContain('thread-id');
    expect(innerHTML).not.toContain('<!--');
  });
});
