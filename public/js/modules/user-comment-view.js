// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * UserCommentView — the single presentation contract for a SAVED user
 * comment.
 *
 * WHY THIS EXISTS
 * Three independent surfaces display the same stored comment:
 *   - `CommentManager.displayUserComment`        (legacy diff2html rows)
 *   - `PierreBridge._renderCommentAnnotation`    (@pierre/diffs rows)
 *   - `RenderedDocumentView._buildCommentCard`   (Rendered Markdown)
 * They previously each hand-wrote the markup, and the Rendered surface had
 * drifted into a completely different visual object (grey card, text action
 * links, no line badge, no adopted metadata). One comment therefore looked
 * like two different things depending on which view the reviewer was in.
 *
 * This module owns the canonical fragment — the `.user-comment` shell, the
 * `.user-comment-header` / `.user-comment-header-left` metadata order, the
 * origin icon, the line badge, the adopted praise/title metadata, the
 * expanded-context indicator, the `.user-comment-actions` chat/edit/dismiss
 * icon buttons in that order, and the `.user-comment-body` — so all three
 * surfaces emit byte-identical structure and inherit the same
 * `public/css/pr.css` palette in both themes. No colours or dimensions are
 * declared here; this is markup only.
 *
 * WHAT IS SURFACE-SPECIFIC
 * Only two things:
 *   1. The `actionMode`. Diff rows keep their existing inline
 *      `onclick="prManager.editUserComment(id)"` handlers, which locate the
 *      comment by its `.user-comment-row`. The Rendered surface has no such
 *      row and owns an in-card edit form, so it asks for `'callback'` mode:
 *      the same buttons, same classes, same order, but carrying
 *      `data-comment-action` hooks instead of Diff-only inline handlers.
 *   2. `secondaryMetaHtml` — trusted, caller-built header metadata appended
 *      after the canonical metadata (the Rendered surface's nested-target
 *      chip). It never replaces the line badge.
 *
 * SECURITY: every value interpolated here goes through an attribute or text
 * escaper; the body is rendered through the caller's sanitized
 * `renderMarkdown`. All comment/repository data is untrusted.
 */

/* eslint-disable no-undef */
(function () {
  /** Canonical origin/action icons. Single definition for every surface. */
  const ICONS = {
    ai: `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
    <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
  </svg>`,
    person: `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
    <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
  </svg>`,
    chat: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`,
    edit: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
              </svg>`,
    dismiss: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>`,
    praise: `<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>`,
    expandedContext: `<svg viewBox="0 0 16 16" width="14" height="14">
             <path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"></path>
           </svg>`
  };

  /**
   * The canonical action-button classes, in the canonical left-to-right
   * order. Exported so parity tests can assert every surface emits exactly
   * this sequence rather than re-stating it per surface.
   */
  const ACTION_ORDER = Object.freeze(['btn-chat-comment', 'btn-edit-comment', 'btn-delete-comment']);

  /** Tooltip text for each action, also shared so the surfaces cannot drift. */
  const ACTION_TITLES = Object.freeze({
    chat: 'Chat about comment',
    edit: 'Edit comment',
    dismiss: 'Dismiss comment'
  });

  const EXPANDED_CONTEXT_TITLE =
    'This expanded context comment will be posted to GitHub as a file-level comment';

  /**
   * Capability token a caller must present to have `secondaryMetaHtml`
   * interpolated as HTML.
   *
   * `secondaryMetaHtml` is the ONE option here that is not escaped — it is
   * raw markup spliced into the header — and it exists for exactly one
   * caller: `RenderedDocumentView._buildCommentCard`, which builds the
   * nested-target chip itself from its own validated descriptors and runs
   * the label through its attribute escaper before wrapping it. That is a
   * sharp edge sitting on an option named like an ordinary string, in a
   * module three surfaces call. So it FAILS CLOSED: without this token the
   * HTML is dropped and the mistake is logged, instead of a future caller
   * turning the shared card into an injection sink on all three surfaces at
   * once by passing a label derived from repository/document text.
   *
   * This is a wrong-by-default guard, NOT a sanitizer and NOT a security
   * boundary against code that can already read this module: any caller can
   * fetch the token. Its job is to make "I am passing raw HTML" impossible
   * to do by accident, and greppable when it is done on purpose.
   */
  const TRUSTED_SECONDARY_META = Object.freeze({
    token: 'UserCommentView.TRUSTED_SECONDARY_META'
  });

  /**
   * Resolve `options.secondaryMetaHtml` against the trust token.
   * @param {object} options
   * @returns {string} the caller's HTML, or '' when absent/untrusted
   */
  function resolveSecondaryMetaHtml(options) {
    const html = options ? options.secondaryMetaHtml : null;
    if (!html) return '';
    if (options.secondaryMetaTrust !== TRUSTED_SECONDARY_META) {
      // eslint-disable-next-line no-console
      console.error(
        '[UserCommentView] secondaryMetaHtml was dropped: raw header HTML requires '
        + '`secondaryMetaTrust: UserCommentView.TRUSTED_SECONDARY_META`. Pass application-'
        + 'generated, already-escaped markup only — never repository or comment text.'
      );
      return '';
    }
    return String(html);
  }

  /**
   * Intrinsically-safe attribute escaper, used when the host has not
   * installed `window.escapeHtmlAttribute` (Node unit tests, and any caller
   * that forgets). Never an identity passthrough: comment bodies are
   * untrusted and land in a live attribute value.
   * @param {*} value
   * @returns {string}
   */
  function defaultEscapeHtmlAttribute(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Resolve an escaper and make it total: every host escaper in this
   * codebase (`window.escapeHtmlAttribute`, `PRManager.escapeHtml`) assumes
   * a string, but the values interpolated here include numeric ids and line
   * numbers straight from the API. Coercing here — once — keeps every
   * call site free of `String(...)` noise and guarantees nothing reaches a
   * template un-escaped.
   * @param {function(*):string|undefined} supplied
   * @param {function(*):string} fallback
   * @returns {function(*):string}
   */
  function toTotalEscaper(supplied, fallback) {
    const fn = typeof supplied === 'function' ? supplied : fallback;
    return (value) => (value == null ? '' : fn(String(value)));
  }

  /** @returns {function(*):string} */
  function resolveAttrEscaper(supplied) {
    const host = typeof window !== 'undefined' && typeof window.escapeHtmlAttribute === 'function'
      ? window.escapeHtmlAttribute
      : defaultEscapeHtmlAttribute;
    return toTotalEscaper(supplied, host);
  }

  /** @returns {function(*):string} */
  function resolveTextEscaper(supplied) {
    return toTotalEscaper(supplied, defaultEscapeHtmlAttribute);
  }

  /**
   * `Line 12` / `Lines 12-15` — the canonical line badge text every surface
   * shows. Both Diff producers and the Rendered card must agree here or the
   * same comment reads as two different anchors.
   * @param {object} comment
   * @returns {string}
   */
  function formatLineInfo(comment) {
    const start = comment ? comment.line_start : null;
    const end = comment ? comment.line_end : null;
    return end && end !== start ? `Lines ${start}-${end}` : `Line ${start}`;
  }

  /**
   * Origin modifier for the OUTER placement element a surface owns (the
   * legacy `<tr>`, the Pierre annotation div, the Rendered card adapter).
   * @param {object} comment
   * @returns {string}
   */
  function originModifierClass(comment) {
    return comment && comment.parent_id ? 'comment-ai-origin' : 'comment-user-origin';
  }

  /**
   * Class list for the canonical `.user-comment` shell itself.
   * @param {object} comment
   * @returns {string[]}
   */
  function commentShellClasses(comment) {
    const classes = ['user-comment'];
    if (comment && comment.parent_id) classes.push('adopted-comment', 'comment-ai-origin');
    else classes.push('comment-user-origin');
    return classes;
  }

  /**
   * The origin icon: AI sparkle for an adopted suggestion, person glyph for
   * a comment the reviewer wrote themselves.
   * @param {object} comment
   * @returns {string}
   */
  function originIconSvg(comment) {
    return comment && comment.parent_id ? ICONS.ai : ICONS.person;
  }

  /**
   * Adopted-comment metadata: the "Nice Work" praise badge and the adopted
   * title. Only adopted comments (`parent_id` + a non-plain type) carry
   * either; a missing optional field omits only its own element.
   * @param {object} comment
   * @param {function(*):string} escapeText
   * @returns {string}
   */
  function buildAdoptedMetaHtml(comment, escapeText) {
    if (!comment || !comment.parent_id || !comment.type || comment.type === 'comment') return '';
    const badgeHtml = comment.type === 'praise'
      ? `<span class="adopted-praise-badge" title="Nice Work">${ICONS.praise}Nice Work</span>`
      : '';
    return `
        ${badgeHtml}
        ${comment.title ? `<span class="adopted-title">${escapeText(comment.title)}</span>` : ''}
      `;
  }

  /**
   * WORKAROUND indicator: comments whose line is outside every diff hunk get
   * submitted to GitHub as file-level comments, because GitHub's API has no
   * line-level comment for those lines. Shown identically on every surface.
   * @param {boolean} isExpandedContext
   * @returns {string}
   */
  function buildExpandedContextIndicatorHtml(isExpandedContext) {
    if (!isExpandedContext) return '';
    return `<span class="expanded-context-indicator" title="${EXPANDED_CONTEXT_TITLE}">
           ${ICONS.expandedContext}
         </span>`;
  }

  /**
   * The chat / edit / dismiss icon controls, always in that order.
   *
   * `mode === 'diff'` keeps the long-standing inline handlers, which resolve
   * the comment through its `.user-comment-row`. `mode === 'callback'` emits
   * the same buttons with no inline handler and a `data-comment-action`
   * hook, for a surface that owns its own edit/delete lifecycle — it must
   * never be given the Diff handlers, which would search for a row it does
   * not have.
   * @param {object} comment
   * @param {object} opts
   * @param {'diff'|'callback'} opts.mode
   * @param {function(*):string} opts.escapeAttr
   * @returns {string}
   */
  function buildActionsHtml(comment, { mode, escapeAttr }) {
    const id = comment ? comment.id : '';
    // The Diff handlers are inline attributes, so the id is embedded as a
    // JSON literal and then attribute-escaped. For the integer primary keys
    // the API actually returns this is byte-identical to the previous
    // `${comment.id}` interpolation (`editUserComment(101)`); for anything
    // else it stays inside the attribute as a quoted string instead of
    // being able to close it.
    const literalId = mode === 'diff' ? escapeAttr(JSON.stringify(id)) : '';
    const editHandler = mode === 'diff'
      ? ` onclick="prManager.editUserComment(${literalId})"`
      : ' data-comment-action="edit"';
    const deleteHandler = mode === 'diff'
      ? ` onclick="prManager.deleteUserComment(${literalId})"`
      : ' data-comment-action="delete"';

    // `type="button"` on all three: these are icon controls, never submits.
    // Stated explicitly so the fragment is safe wherever a surface slots it
    // (a Diff `<tr>`, a Pierre light-DOM div, a Rendered card) without the
    // caller having to remember.
    //
    // ACCESSIBLE NAME: `aria-label` duplicates `title` on every one of these
    // controls, in BOTH action modes. Their only visible content is an
    // `<svg>`, so without it the accessible name falls back to the tooltip —
    // which assistive technology exposes inconsistently, and which touch
    // users never see at all. `aria-label` wins over `title` when both are
    // present, so the two strings are deliberately the same string constant:
    // there is exactly one label per action and no way for them to drift.
    // Purely semantic — no rule in pr.css keys off either attribute, so this
    // changes nothing about how the buttons look on any surface.
    return `<button type="button" class="btn-chat-comment" title="${ACTION_TITLES.chat}" aria-label="${ACTION_TITLES.chat}" data-chat-comment-id="${escapeAttr(id)}" data-chat-file="${escapeAttr(comment && comment.file ? comment.file : '')}" data-chat-line-start="${escapeAttr(comment && comment.line_start != null ? comment.line_start : '')}" data-chat-line-end="${escapeAttr((comment && (comment.line_end || comment.line_start)) || '')}" data-chat-parent-id="${escapeAttr(comment && comment.parent_id ? comment.parent_id : '')}">
              ${ICONS.chat}
            </button>
            <button type="button" class="btn-edit-comment"${editHandler} title="${ACTION_TITLES.edit}" aria-label="${ACTION_TITLES.edit}">
              ${ICONS.edit}
            </button>
            <button type="button" class="btn-delete-comment"${deleteHandler} title="${ACTION_TITLES.dismiss}" aria-label="${ACTION_TITLES.dismiss}">
              ${ICONS.dismiss}
            </button>`;
  }

  /**
   * Build the canonical `.user-comment` fragment for a saved comment.
   *
   * @param {object} comment - the stored comment (untrusted data)
   * @param {object} [options]
   * @param {'diff'|'callback'} [options.actionMode='diff'] - see buildActionsHtml
   * @param {boolean} [options.isExpandedContext=false] - render the
   *   out-of-hunk indicator. Computed by the caller, which owns the patch.
   * @param {string} [options.lineInfo] - override the line badge text
   * @param {string} [options.secondaryMetaHtml=''] - raw, caller-built HTML
   *   appended after the canonical header metadata (the Rendered surface's
   *   nested-target chip). Never replaces the line badge. IGNORED unless
   *   `options.secondaryMetaTrust` is `UserCommentView.TRUSTED_SECONDARY_META`
   *   — see that constant. Must be application-generated and already
   *   escaped; it is the only value on this path that is not escaped here.
   * @param {object} [options.secondaryMetaTrust] - the
   *   `UserCommentView.TRUSTED_SECONDARY_META` token, required to opt in to
   *   `secondaryMetaHtml`.
   * @param {string} [options.extraBodyClasses=''] - extra classes on
   *   `.user-comment-body` (a surface-owned behavioural hook only)
   * @param {function(string):string} [options.renderMarkdown] - sanitized
   *   markdown renderer; falls back to escaping the body as plain text
   * @param {function(*):string} [options.escapeHtml] - text escaper
   * @param {function(*):string} [options.escapeHtmlAttribute] - attribute escaper
   * @returns {string}
   */
  function buildCommentHtml(comment, options = {}) {
    const escapeAttr = resolveAttrEscaper(options.escapeHtmlAttribute);
    const escapeText = resolveTextEscaper(options.escapeHtml);
    const renderMarkdown = typeof options.renderMarkdown === 'function'
      ? options.renderMarkdown
      : (typeof window !== 'undefined' && typeof window.renderMarkdown === 'function'
        ? window.renderMarkdown
        : null);

    const body = comment && comment.body != null ? comment.body : '';
    const bodyHtml = renderMarkdown ? renderMarkdown(body) : escapeText(body);
    const bodyClasses = options.extraBodyClasses
      ? `user-comment-body ${options.extraBodyClasses}`
      : 'user-comment-body';

    return `
      <div class="${commentShellClasses(comment).join(' ')}">
        <div class="user-comment-header">
          <div class="user-comment-header-left">
            <span class="comment-origin-icon">
              ${originIconSvg(comment)}
            </span>
            <span class="user-comment-line-info">${escapeText(options.lineInfo || formatLineInfo(comment))}</span>
            ${buildExpandedContextIndicatorHtml(!!options.isExpandedContext)}
            ${buildAdoptedMetaHtml(comment, escapeText)}
            ${resolveSecondaryMetaHtml(options)}
          </div>
          <div class="user-comment-actions">
            ${buildActionsHtml(comment, { mode: options.actionMode === 'callback' ? 'callback' : 'diff', escapeAttr })}
          </div>
        </div>
        <div class="${bodyClasses}" data-original-markdown="${escapeAttr(body)}">${bodyHtml}</div>
      </div>
    `;
  }

  const UserCommentView = {
    ICONS,
    ACTION_ORDER,
    ACTION_TITLES,
    EXPANDED_CONTEXT_TITLE,
    TRUSTED_SECONDARY_META,
    formatLineInfo,
    originModifierClass,
    commentShellClasses,
    originIconSvg,
    buildAdoptedMetaHtml,
    buildExpandedContextIndicatorHtml,
    buildActionsHtml,
    buildCommentHtml,
    defaultEscapeHtmlAttribute
  };

  if (typeof window !== 'undefined') {
    window.UserCommentView = UserCommentView;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UserCommentView;
  }
})();
