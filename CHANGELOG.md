# Changelog

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
