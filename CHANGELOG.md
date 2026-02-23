# Changelog

## 2.0.0

### Major Changes

- fe5f3c9: Refactor API routes: rename and reorganize REST endpoints for reviews, analyses, and suggestions

### Minor Changes

- 3715410: Add "Chat about lines" action to diff panel gutter and comment forms

  - Gutter chat button alongside the existing + comment button, with drag-to-select line range support
  - Chat button in line-level and file-level comment forms to pivot unsaved comments into chat
  - Line context cards with structured metadata for the chat agent (file, lines, provenance)
  - AI suggestion provenance passed through comment context when comments originated from suggestions
  - Editing-mode properly hides action buttons on both line-level and file-level comments

- e393781: Add "Create comment" shortcut button and dismiss control to chat action bar

  - "Create comment" button appears when chat is opened from a diff line gutter icon, sending structured line metadata to the agent
  - Dismiss (×) button on the action bar to hide stale shortcuts mid-conversation
  - `chat.enable_shortcuts` config option to globally disable action bar shortcuts

- 6bb675f: Add copy-to-clipboard button on assistant chat messages for quick copying of raw markdown content
- 9a93ba9: Add chat instructions to repository settings for customizing chat session system prompts
- 506443b: Add session picker dropdown to chat panel

  The chat panel header now includes a dropdown to switch between previous
  conversations for the current review. Each session shows a preview of the first
  message and a relative timestamp, with the active session highlighted. Sessions
  are listed in most-recently-used order.

- dcb5a64: Chat with AI agent about review suggestions via Pi RPC
- 4f12587: Add context files feature: pin non-diff file ranges into the diff panel for review context. Context file headers include viewed checkbox, comment, chat, and collapse controls matching regular diff files. File navigator sidebar renamed and unified diff-file validation covers both PR and local review modes.
- ba5f6de: Add flexible panel group layout for Review and Chat panels with four arrangement options (side-by-side, stacked, and flipped variants)
- 7a2d34a: Add "Chat about this run" button to analysis history popover, allowing users to chat about any previous analysis run — not just the latest
- 62fbf54: Broadcast review events via the existing chat SSE connection so the frontend auto-refreshes comments, suggestions, and analysis results without a manual reload. Eliminates the second EventSource connection and adds background-tab recovery via visibilitychange.

### Patch Changes

- bc2a0be: Fix analysis runs dropdown being overlapped by the review panel resize handle due to CSS stacking context
- 9321adc: Auto-add context file when clicking a chat file link that references a non-diff file
- 52bdf02: Auto-add context file when commenting on a file outside the diff

  When a comment is created on a file not in the PR diff, the server now automatically creates a context file entry so the file appears in the diff panel. Inline comments on context file lines are also rendered correctly. Includes filesystem validation for context file paths and proper handling of multiple context file ranges per file.

- 2995050: Broadcast `review:analysis_started` SSE event so browser UI updates when chat agent triggers analysis
- e393781: Add dismiss (×) button to chat action bar and `chat.enable_shortcuts` config option

  - Small × button on the action bar to hide stale shortcut buttons mid-conversation
  - `chat: { enable_shortcuts: false }` in config globally disables action bar shortcuts
  - One-level deep merge for nested config objects prevents silent loss of defaults

- 83e2748: Enhance chat agent with task extension and review context guidance

  - Load the task extension (`-e .pi/extensions/task`) for chat agent sessions, enabling subagent delegation
  - Add review context to the system prompt so the agent knows the correct `git diff` command for the review type (local vs PR)
  - Pass the absolute path to the pair-review-api SKILL.md in the system prompt to reduce agent fumbling
  - Fix skill file read suppression to check both `path` and `file_path` arg names

- 8e6029b: Fix chat auto-scroll fighting user during streaming responses. The chat panel no longer yanks the viewport to the bottom on every streaming chunk — if the user scrolls up, auto-scroll disengages and a "New content" pill appears. Clicking the pill or scrolling back to the bottom re-engages auto-scroll. User-initiated actions (sending messages, adding context cards) always scroll into view.
- 396bc3b: Add chat buttons to collapsed AI suggestions and Review panel findings for easier access to chat context
- e7b9bd3: Enrich chat context with diff hunks so the AI agent receives actual code when discussing suggestions or comments
- e8e9672: Add domain model to chat system prompt so the agent understands comments, suggestions, and analysis runs on every turn
- a367391: Polish chat panel: rolling transient tool badges, markdown rendering in context cards, and rich hover tooltips for suggestion/comment context
- 52b419b: Add dismiss buttons to chat panel action bar for suggestions and comments
- d725707: Auto-expand collapsed diff hunks when comments target hidden lines, and add a REST endpoint for agents to explicitly expand hunks via SSE
- e14482a: Fix chat agent CWD to use the review's worktree directory instead of the server's working directory. For PR reviews, the worktree path is now resolved from the worktrees table (matching analysis behavior). Previously, the chat agent could not explore the codebase in PR mode because it launched in the wrong directory.
- 6677758: Fix chat showing as unavailable on first load

  Await provider availability check before the server starts listening so the
  `/api/config` endpoint returns accurate `pi_available` status on the very first
  request. Previously the check ran in the background after `app.listen()`,
  causing a race where the frontend would fetch config before the cache was
  populated, making chat appear unavailable until a page reload.

- a047852: Fix chat panel layout issues: file location links now wrap within chat bubbles instead of overflowing, and panel resize constraints are dynamic based on viewport width. In vertical layout, closing the Review panel no longer locks the Chat panel at a fixed width — the per-panel resize handle is restored so the Chat panel can be freely resized.
- 84ff596: Fix review panel comment items being too short to accommodate stacked chat and dismiss buttons. Comment items now match the height of AI suggestion items.
- ec37372: Fix duplicate context file entries in sidebar nav and diff panel when the same file has multiple context ranges. Sidebar now deduplicates by path and yields to diff files; diff panel merges ranges into a single wrapper with per-chunk dismiss buttons.
- a78f818: Fix context files disappearing from the diff panel on review reload by clearing stale in-memory state in `renderDiff()` so that `loadContextFiles()` correctly re-renders them
- 62354d5: Prevent direct status transition to "adopted" and add atomic /adopt endpoint

  - Reject "adopted" in POST /suggestions/:id/status with 400 pointing to proper endpoints
  - Add POST /suggestions/:id/adopt for atomic adopt-as-is (creates linked user comment + sets status in one request)
  - Wrap /adopt and /edit DB operations in transactions for true atomicity
  - Migrate frontend adoption paths to use /adopt endpoint instead of two-request dance
  - Harmonize CATEGORY_EMOJI_MAP across all four locations to match AI prompt schema
  - Update pair-review-api skill documentation

- f4a7ca1: Gate chat panel behind config and Pi availability

  Chat UI is now hidden by default until both `enable_chat` is true in config and
  the Pi AI provider is detected. Three states control visibility: `disabled`
  (chat feature off — everything hidden), `unavailable` (enabled but Pi not
  installed — toggle button shown grayed-out with tooltip), and `available` (fully
  functional). Early inline script in HTML prevents flash of chat UI before config
  loads.

- 887041d: Hide tool badges for internal API calls in chat panel

  Suppress tool_use SSE events when the chat agent curls the pair-review server's own API, so implementation-detail badges don't appear in the chat panel. The regex is port-scoped to avoid accidentally hiding calls to other local services.

- e75ba8c: Hide skill file read from chat UI

  Suppress the Read tool badge when the chat agent loads the pair-review-api skill file, and instruct the agent not to mention it.

- fe6071e: Persist analysis tier on the analysis_runs database record instead of deriving it from the model name at query time
- 868f628: Add personality directives to chat system prompt and prevent direct SQLite access
- 3e9edd5: Fix chat panel suggestion bugs: hide lingering context tooltip when removing a pending suggestion card, and prevent "Chat" on a suggestion from loading the previous session instead of staying in the current new conversation
- e117b99: Update built-in model definitions for Gemini, Copilot, and Cursor Agent providers

  - Gemini: Drop `-preview` suffix from gemini-3-flash and gemini-3-pro (with aliases for backward compat), add gemini-3.1-pro
  - Copilot: Add claude-sonnet-4.6 (new default), gpt-5.3-codex, claude-opus-4.6-fast; demote sonnet-4.5
  - Cursor Agent: Add sonnet-4.6-thinking (new default), gemini-3.1-pro, gpt-5.3-codex-xhigh; demote sonnet-4.5-thinking
  - Extract default model constants to reduce duplication across constructor and getDefaultModel()

## 1.6.2

### Patch Changes

- 37c2bb3: Add Sonnet 4.6 model to Claude provider and fix model definitions

  - Add `sonnet-4.6` entry with pinned `cli_model: 'claude-sonnet-4-6'`
  - Rename `sonnet` entry to `sonnet-4.5` with pinned `cli_model: 'claude-sonnet-4.5'`
  - Move `opus-4.5` to end of model list so Opus 4.6 variants appear together
  - Fix `opus-4.5` tier from `balanced` to `thorough`
  - Fix `sonnet-4.5` badgeClass to `badge-balanced` to match its positioning

- 4287107: Add missing `showInfo()` method to Toast component

  The Toast class only defined `showSuccess`, `showError`, and `showWarning`, but `showInfo` was called in three places, causing runtime errors. Added the method with a GitHub-style info icon and blue styling for both light and dark themes.

- ee88013: Fix consolidation/orchestration streaming text not appearing in the progress modal during analysis
- 135008a: Fix progress modal not appearing on page refresh during single-model analysis

## 1.6.1

### Patch Changes

- c9d8788: Fix council config immediately showing as dirty when selecting a saved council from the dropdown

## 1.6.0

### Minor Changes

- 2b05496: Add configurable database names for per-worktree isolation. Set `db_name` in config or `PAIR_REVIEW_DB_NAME` env var to use a custom database file, preventing schema conflicts when switching branches during development. Also supports local `.pair-review/config.json` overrides.

### Patch Changes

- 633c49f: Add reasoning field to AI suggestions showing step-by-step explanation of why issues were flagged
- 51bd27e: Show reasoning popover button on collapsed AI suggestions alongside the restore button
- a0ee5c1: Add reasoning popover to AI suggestions with brain icon button in header

## 1.5.1

### Patch Changes

- 531d717: Fix cancelled analysis runs incorrectly showing as completed due to race condition
- 6e659d0: Fix council save button incorrectly prompting for a name when saving existing councils. Style save buttons blue to make unsaved changes more visible.
- fe3ccfb: Fix fork PR fetching by resolving the correct git remote for the base repository
- c2e13af: Fix progress dialog not reopening when clicking Analyzing button during single-model analysis

## 1.5.0

### Minor Changes

- 8f300d5: Add review-requests skill to batch-open outstanding GitHub review requests with auto-analysis
- e9d7642: Add Review Council for multi-model analysis with parallel voices, per-level consolidation, and cross-level orchestration. Includes council configuration UI with participant cards, slider toggles, dirty state tracking, auto-save, and a new hierarchical progress dialog showing per-participant status.

### Patch Changes

- 12487f5: Add council card UI and model card improvements to repo settings: council participant cards with speech-bubble arrows, static model display cards, CSS custom properties for theme-consistent styling, and safer model resolution with optional chaining.

## 1.4.4

### Patch Changes

- 3eabc92: Forbid openai/o3-pro from review model selection due to extreme cost

## 1.4.3

### Patch Changes

- e4ee85c: Fix suggestion on modified lines including both old and new line content by making getCodeFromLines always filter by side, defaulting to RIGHT when not provided
- c30b251: Fix _f_ function context markers being lost during upward gap expansion. Stranded markers are now relocated to the nearest remaining gap boundary instead of being removed, preserving function scope context for collapsed code sections.

## 1.4.2

### Patch Changes

- cd4c3ba: Fix shell quoting across all AI providers when using multi-word CLI commands (e.g. `devx claude --`). The original regex in Claude's `_quoteShellArgs()` used `[]` which JavaScript treats as an empty character class matching nothing, so arguments with shell metacharacters like `Bash(git diff*)` were never quoted. Extracted a shared `quoteShellArgs()` utility into the base provider module and applied it to all 7 providers: Claude, Gemini, Copilot, Codex, Pi, OpenCode, and Cursor Agent.
- 83d7c3b: Route index page review starts through the setup page to show step-by-step progress matching the MCP/CLI flow, and fix bfcache form state bug
- 4157d8b: Update AI provider model configurations for Codex, Copilot, Cursor Agent, and Gemini providers

## 1.4.1

### Patch Changes

- d8f8bfb: Fix stale-check fetch blocking dialog by using AbortController

  The stale-check fetch used a simple sequential `await fetch()` with no timeout. If the
  underlying HTTP connection hung (e.g., slow git commands on some machines), it could
  exhaust the browser's per-origin connection limit (~6), blocking subsequent fetches and
  delaying or preventing the analysis config dialog from appearing.

  Switch to AbortController with a 2-second timeout so the fetch is truly cancelled,
  immediately freeing the connection. Additionally, run the stale check in parallel with
  the settings fetches via Promise.all to minimize dialog delay. Applied to both local
  and PR mode.

- 04465a9: Improve GitHub token help in web UI to match CLI quality: direct link to token creation page, required scopes, and GITHUB_TOKEN environment variable option

## 1.4.0

### Minor Changes

- 00f4cb8: Add Pi coding agent as a new AI provider with full feature parity
- b8f3d99: Add local reviews list to index page with browse, inline delete, and session management
- 1b50085: Add Pi task extension and review model guidance skill

  - Task extension (`.pi/extensions/task/`) provides a generic subagent tool for Pi that spawns isolated `pi` subprocess with full tool access, supporting single and parallel execution with per-task model selection
  - Review model guidance skill (`.pi/skills/review-model-guidance/`) teaches Pi when and how to switch models during code review, with model-specific recommendations for different review tasks

- eaad08a: Integrate Pi task extension into pi-provider

  - Pi provider now loads the task extension via `-e`, giving the model a subagent tool for delegating work to isolated subprocesses during analysis
  - Task extension propagates parent's active tool list to subtasks, preserving read-only security restrictions
  - PI_CMD environment variable propagated to subtasks for wrapper compatibility (e.g., `devx pi --`)
  - Auto-discovery disabled (`--no-extensions`, `--no-skills`, `--no-prompt-templates`) for deterministic runs
  - Full CLI command logged at debug level on every pi spawn

- 6ad494c: Add Review Roulette mode for Pi provider

  - New 'review-roulette' analysis mode dispatches reviews to 3 randomly-selected reasoning models in parallel for diverse perspectives
  - Skill instructs Pi to discover available thinking-capable models, pick 3 from different providers, forward the full review prompt, and merge all suggestions with model-attributed summaries
  - PI_TASK_MAX_DEPTH set to 2 for roulette mode so review subtasks can use their own subtasks for large PRs
  - Env merge ordering fixed: PI_TASK_MAX_DEPTH is an overridable default, PI_CMD always wins from the resolved command

## 1.3.3

### Patch Changes

- 894d8f0: Fix JSON extraction from LLM responses that contain preamble text before JSON output

## 1.3.2

### Patch Changes

- d1d43ee: Expand Claude Opus model definitions with granular variants and make Opus the default model

  - Replace single `opus` model with five variants: `opus-4.5`, `opus-4.6-low`, `opus-4.6-medium`, `opus` (high effort, default), and `opus-4.6-1m` (1M context)
  - Add `cli_model` field to decouple app-level model ID from CLI `--model` argument
  - Add `env` and `extra_args` support with three-way merge (built-in → provider config → per-model config)
  - Add alias support (`opus-4.6-high` resolves to `opus`)
  - Extract `_resolveModelConfig()` to consolidate model lookup logic
  - Extract `_quoteShellArgs()` for shell-safe argument quoting with POSIX escaping
  - Update default model from `sonnet` to `opus` across all code paths
  - Remove hardcoded fallback model list from repo-settings frontend

- cb52043: Fix server crash from unhandled EPIPE error when AI provider process exits before stdin write completes

## 1.3.1

### Patch Changes

- db90e67: Fix clearing user comments not working after diff refresh

  After refreshing the diff (in both Local and PR mode), the DOM is cleared by `renderDiff()` but comments and AI suggestions were not re-rendered. This caused `clearAllUserComments()` to find zero DOM elements and bail with "No comments to clear". Now both `refreshDiff()` and `refreshPR()` reload user comments and AI suggestions after re-rendering the diff, preserving the selected analysis run ID.

- e0f7360: Add pagination to the index page worktree list with "Show more" button. Uses cursor-based pagination for stability during background stale cleanup.

## 1.3.0

### Minor Changes

- 52784e1: Add monorepo sparse-checkout support

  - New `monorepos` config option to specify explicit paths for large monorepos with `~` expansion
  - Monorepo paths take highest priority (Tier -1) in repository discovery
  - Auto-detect and expand sparse-checkout to include all PR directories
  - Inject sparse-checkout guidance into Level 3 analysis prompts so AI agents know they can run `git sparse-checkout add` to explore related code

## 1.2.2

### Patch Changes

- 883996c: Fix repository location validation when reviewing PRs from different repositories

  Previously, when running `pair-review <PR-URL>` from a directory containing a different repository, the current working directory was incorrectly registered as the repository location. This caused git operations to fail with errors like "couldn't find remote ref" because the wrong repository was being used.

  Now the current directory is validated against the target PR's owner/repo before use. If there's a mismatch, pair-review falls back to finding an existing checkout or cloning the repository to `~/.pair-review/repos/`.

## 1.2.1

### Patch Changes

- 36ecef0: Fix release script to commit all version-bumped files

  The release script was staging plugin version files but never committing them,
  leaving uncommitted changes after each release. This change disables changeset's
  auto-commit and instead commits all version-related files (package.json,
  package-lock.json, CHANGELOG.md, plugin manifests) in a single explicit commit.

## 1.2.0

### Minor Changes

- 789ea9a: Add Cursor Agent CLI as a new AI provider with streaming JSON output, sandbox mode, and built-in model definitions
- fdad840: Enhance code-critic:loop skill with history tracking and merge readiness

  - Add directory-based history structure (.critic-loop/{id}/) with numbered analysis and implementation files that persist across iterations
  - Aggregate custom instructions into analysis with objective context, iteration tracking, and history references to prevent re-suggesting already-addressed issues
  - Add merge readiness assessment (ready/needs-fixes/blocked) to analysis output for smarter completion logic
  - Update evaluation to stop early when merge readiness is "ready" instead of chasing perfection to max iterations
  - Add implementation summary files documenting what was built/fixed in each iteration
  - Fix iteration naming ambiguity: clarify that `iteration: 0` tracks completed cycles, use glob patterns instead of bash-like notation, and introduce explicit `CURRENT = N + 1` variable to eliminate off-by-one confusion

- c0ee7bc: Add MCP server and Claude Code plugins for AI coding agent integration

  - Expose MCP server via `--mcp` stdio transport and `/mcp` HTTP endpoint with tools for reading review comments, AI suggestions, analysis runs, and prompts, plus triggering new analyses
  - Ship two Claude Code plugins: `code-critic` (standalone three-level analysis and critic-loop skills) and `pair-review` (app-integrated review, feedback, and analysis skills)
  - Add setup UI with SSE progress streaming for PR and local review initialization
  - Add external analysis results import endpoint so standalone analysis can push results into the web UI
  - Change default port from 3000 to 7247 to avoid conflicts with common dev servers

- 8785ab1: Add provider availability checking at server startup

  - Check all AI providers in the background when server starts, caching availability status
  - Default provider is checked first for faster initial availability
  - Claude provider now uses fast `claude --version` check instead of running a prompt
  - Analysis config modal only shows available providers (unavailable ones are hidden)
  - Added refresh button to manually re-check provider availability
  - Provider buttons now wrap to multiple lines when there are many providers
  - Shows helpful message when no providers are available
  - Auto-selects first available provider if currently selected one becomes unavailable

## 1.1.1

### Patch Changes

- 637212a: Fix Markdown syntax highlighting so underscores within words (e.g. `update_policy`) are no longer incorrectly treated as italic/bold markers. Added `fixMarkdownHighlighting()` post-processing that strips mid-word emphasis/strong spans from highlight.js output.
- 523866a: Add hover-to-copy for branch name on the PR page toolbar, mirroring the existing hover-to-copy SHA functionality.

## 1.1.0

### Minor Changes

- b120f82: Add GitHub Action review mode for CI-based code reviews

  - New `--ai-review` flag that runs AI analysis and submits a published review (COMMENT event) to GitHub, designed for CI pipelines
  - Auto-detect PR number, owner, and repo from GitHub Actions environment variables (`GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_EVENT_PATH`)
  - New `--use-checkout` flag to skip worktree creation and use the current working directory (automatic in GitHub Actions)
  - Support `PAIR_REVIEW_MAX_BUDGET_USD` environment variable to cap Claude API spend per review
  - Include a ready-to-use GitHub Actions workflow (`.github/workflows/ai-review.yml`)
  - Drop the `validateToken()` pre-flight call that failed with `GITHUB_TOKEN` in Actions ("Resource not accessible by integration")
  - Show AI suggestions with `submitted` status in the web UI after headless review

- d0ef29b: Add keyboard shortcuts for common operations

  - Press `?` to show keyboard shortcuts help overlay
  - Press `c c` to copy all comments to clipboard as markdown
  - Press `c x` to clear all comments (with confirmation)
  - Press `j`/`k` to navigate between AI suggestions
  - Press `Enter` to confirm dialogs, `Escape` to cancel

  Shortcuts use chord detection (e.g., press `c` then `c` within 500ms) and are disabled when typing in input fields or when modals are open.

- 6284608: Add OpenCode as AI provider with configurable models system

  - Add OpenCode provider for flexible model configuration via CLI
  - Introduce `providers` config section for customizing any provider's models, command, extra_args, and env
  - Rename config keys: `provider` → `default_provider`, `model` → `default_model` (with auto-migration)
  - Add `config.example.json` reference file copied to user's config directory on first run
  - Support model tiers: fast, balanced, thorough (with free/premium as aliases)

- 5c4cada: Add GitHub draft review tracking with `github_reviews` table

  - Track GitHub review submissions in a new `github_reviews` table with full lifecycle management (pending, submitted, dismissed)
  - Detect existing pending drafts on GitHub and add comments to them instead of creating duplicate reviews
  - Sync draft state with GitHub, including drafts created outside pair-review
  - Show pending draft indicator in toolbar and context-aware labels in the Submit Review dialog
  - Unify CLI `--ai-draft` and web UI to use the same GraphQL API and database tracking

- faffdeb: Add option to skip Level 3 codebase-wide analysis

  - Added "Analysis Scope" section to the AI Analysis config modal with a checkbox to skip Level 3 analysis
  - Fast-tier models automatically have Level 3 skipped with an informational banner explaining why
  - Switching between model tiers automatically updates the checkbox state to match
  - Backend properly handles skipped Level 3 by passing empty results to orchestration
  - Reduces analysis time for simple PRs or when using faster models

- 4a56ec7: Show real-time AI activity snippets in the progress modal during analysis

  - Display live assistant text and tool usage under each analysis level while running
  - Side-channel StreamParser reads provider stdout incrementally without affecting existing output handling
  - Support streaming from Claude, Codex, Gemini, and OpenCode providers (Copilot excluded — no JSONL output)
  - Smart filtering: prefer assistant text, show tool calls only after 2s gap
  - Throttled broadcasts (300ms per level) to avoid UI flicker
  - Strip worktree path prefixes from file paths for cleaner display
  - Extract meaningful detail from tool calls: commands, file paths (snake_case and camelCase), and Task descriptions

- bdcdc37: Add `--yolo` flag to skip fine-grained AI provider permission restrictions

### Patch Changes

- 0fb3683: Fix AI suggestions from `--ai-draft` not appearing in web UI

  - Include `'draft'` status in AI suggestions API query filters so suggestions submitted via `--ai-draft` remain visible when viewing the PR in the browser

## 1.0.7

### Patch Changes

- b9a4663: Support .gitattributes generated file detection in local mode, collapsing linguist-generated files in the diff UI to match PR mode behavior

## 1.0.6

### Patch Changes

- 724ecb2: Fix file-level user comment styling to match line-level comments

  - Add purple gradient background, border, and shadow to file-level user comment cards in both light and dark themes
  - Use `var(--file-comment-bg)` as gradient end color so cards blend with their container zone background
  - Set file-comment headers to transparent so the gradient shows through consistently

- 12c8b47: Fix duplicate lines in diff display for new files

  - New files showed all added lines AND an expandable "hidden lines" gap that, when expanded, repeated the entire file content
  - Root cause: `patch.split('\n')` on newline-terminated diff output produces a trailing empty string that gets misclassified as a context line with oldNumber=0, making `prevBlockEnd.old = 0` instead of staying unset — this caused the EOF gap check to pass when it shouldn't
  - Strip trailing empty strings from parsed hunk blocks before rendering
  - Tighten EOF gap guard from `prevBlockEnd.old + 1 > 0` to `prevBlockEnd.old > 0` so files with no old-side content (new files) never get a trailing expand section
  - Also guard EOF validation to immediately remove gaps with startLine <= 0

- 52ef1e1: Sharpen orchestration prompts to focus on synthesis over revalidation. Replace generic line number guidance with orchestration-specific guidance that preserves analysis results while retaining investigative capability. Remove file-line-counts section and dead code chain. Clean up unused fileLineCountMap parameter threading.

## 1.0.5

### Patch Changes

- bf87dc9: Fix AI suggestions not displayed for renamed files and improve rename UI

  - Resolve git rename syntax upstream in `getChangedFiles()` so plain new filenames flow through the DOM consistently
  - Display GitHub-style rename icon in file navigator sidebar with tooltip showing old path
  - Show old → new path in diff file headers for renamed files
  - Distinguish pure renames from renamed+modified files in sidebar status
  - Color additions green and deletions red independently in file navigator
  - Fix leading-slash and double-slash bugs in rename path resolution
  - Support compact rename syntax without spaces around arrow

## 1.0.4

### Patch Changes

- 3aff8c4: Fix dismissing AI suggestions when multiple suggestions exist on the same line

  - Fix `collapseAISuggestion` to target the correct suggestion div instead of always finding the first one via `querySelector('.ai-suggestion')`
  - Move `hiddenForAdoption` tracking from the row element to individual suggestion divs so each suggestion is tracked independently
  - Move `hiddenForAdoption` assignment inside the null guard to prevent errors when the suggestion div is not found
  - Only set `hiddenForAdoption` when the suggestion status is `adopted`, not for other dismiss reasons

- 3a81a20: Fix suggestion line text extraction to use correct side when inserting suggestions on modified lines

## 1.0.3

### Patch Changes

- c4fba4b: Fix panel width CSS variable and layout issues

  - Fix --sidebar-width and --ai-panel-width CSS variables not updating when panels collapse
  - Fix flicker when toggling file navigator sidebar by removing max-width transitions and batching updates in requestAnimationFrame
  - Fix asymmetric spacing on comments and suggestions using margin: auto and reduced max-width padding
  - Extract helper method for sidebar initialization and improve code consistency

- 925d8d3: Fix comment count synchronization issues

  - Fixed ReviewModal.submitReview() and PRManager.submitReview() to count both line-level and file-level comments for validation
  - Added updateSegmentCounts() call in AIPanel.updateComment() to ensure UI updates when comment status changes
  - Added documentation explaining the intentional difference between segment counts (inbox size) and submission counts (active only)

## 1.0.2

### Patch Changes

- e21c103: Fixed large reviews failing to submit to GitHub. Reviews with many comments are now submitted in batches with automatic retry logic, removing the previous limitation on comment count.
- 0488753: Disable hooks when invoking Claude CLI for AI analysis

  When pair-review invokes Claude CLI for AI analysis, it now passes `--settings '{"disableAllHooks":true}'` to prevent project-configured hooks from running during the analysis. This avoids slowdowns or interference from hooks configured in the repository being reviewed.

- c624e5c: Add GitHub-style emoji support in comments

  - Render emoji shortcodes (e.g., `:smile:`) as actual emoji in displayed comments
  - Add autocomplete popup when typing `:` in comment textareas with keyboard navigation

- 22fec3b: Fix unreliable Clear All button in review dropdown menu

  The Clear All button in the split button dropdown was sometimes unresponsive, requiring a page refresh. This was caused by event listeners being orphaned when the dropdown menu was rebuilt during async operations. Fixed by using event delegation so clicks are always handled regardless of DOM updates.

- 336220e: Fix text wrapping in diff panel suggestions and comments

  AI suggestions and user comments now wrap long text properly instead of overflowing the diff panel.

- 2dfda66: Add help modal and improve onboarding experience

  - Add help modal with "?" button in header for accessing help anytime
  - Fix loading state flash where help content briefly appeared before reviews loaded
  - Include local mode instructions (`--local [path]`) in help content
  - Dynamically show correct command based on npx vs npm install
  - Add ARIA attributes for accessibility (role="dialog", aria-labelledby, aria-modal)
  - Add E2E tests for help modal interactions

- fb0e1d7: Added LLM-based JSON extraction fallback for all AI providers. When regex-based JSON extraction fails to parse AI responses, providers now attempt to use a fast-tier LLM to extract the JSON content, improving reliability of AI analysis across all providers.
- 7901880: Pass full suggestion JSON to orchestration level instead of truncated text. Previously, the orchestration AI received only partial data (truncated descriptions, missing line_end, old_or_new, suggestion, and confidence fields), forcing it to re-derive information already computed by lower analysis levels. Now orchestration receives complete suggestion data, enabling accurate deduplication, proper confidence aggregation, and correct line positioning for comments.

## 1.0.1

### Patch Changes

- 12ec0ff: Add first-run welcome message with getting started guidance
- 47a5dd8: Fixed restoring dismissed AI suggestions when multiple suggestions target the same line. Previously, clicking "Restore" on the second suggestion would incorrectly restore the first one.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2025-01-22

### Added

- Initial release of pair-review
- AI-powered code review assistance for GitHub pull requests
- Local mode for reviewing uncommitted changes
- Support for multiple AI providers: Claude CLI, Gemini CLI, OpenAI Codex
- GitHub-familiar diff view with inline comments
- Three-level AI analysis (isolation, file context, codebase context)
- SQLite database for local storage of reviews and drafts
- Dark and light theme support
- CLI commands: `pair-review <PR>` and `git-diff-lines`
