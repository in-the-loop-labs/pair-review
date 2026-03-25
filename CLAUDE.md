# Pair-Review Project Requirements

## Overview
Pair-Review is a local web application that assists human reviewers with GitHub pull request reviews by providing AI-powered suggestions and insights. The AI acts as a pair programming partner, highlighting potential issues and noteworthy aspects to accelerate the review process while keeping the human reviewer in control.

## Core Value Propositions

1. **Tight Feedback Loop for AI Coding Agents**: Enable humans to review AI-generated code and provide structured feedback back to the coding agent (Claude Code, Cursor, etc.) for iteration. This creates a continuous improvement cycle where the human stays in control while working collaboratively with AI agents.

2. **AI-Assisted Human Review Partner**: Help humans perform better code reviews by acting as a collaborative partner that highlights issues, insights, and noteworthy aspects. This is not just an automated bug finder or AI review tool - it's a partner that assists the human reviewer in making informed decisions.

## Core Architecture
- **Backend**: Node.js with Express server
- **Frontend**: Vanilla JavaScript (no framework) - familiar GitHub-like UI
- **Database**: SQLite for local storage of reviews and drafts
- **AI Integration**: Claude CLI in SDK mode (`claude -p` for programmatic output), Gemini CLI, Codex
- **Distribution**: npm package executable via `npx pair-review`

## Key Design Principles
- **GitHub UI Familiarity**: Interface should feel instantly familiar to GitHub users
- **Human-in-the-loop**: AI suggests, human decides
- **Local-first**: All data and processing happens locally
- **Progressive Enhancement**: Start simple, add features incrementally

## Core Workflow
1. User runs `npx pair-review <PR-number-or-URL>`
2. App checks out PR branch locally (new worktree)
3. Web UI opens automatically in browser showing PR diff
4. User clicks button to trigger AI analysis (optional - simple PRs may not need it)
5. AI performs 3-level review analysis:
   - **Level 1**: Analyze changes in isolation (bugs/issues in changed lines only)
   - **Level 2**: Analyze changes in file context (consistency within file)
   - **Level 3**: Analyze changes in codebase context (architectural consistency)
6. AI suggestions appear inline with code, categorized by type
7. User adopts/edits/discards AI suggestions and adds own comments
8. User submits complete review to GitHub with inline comments and overall status

## AI Review Implementation
- **Execution**: Use AI provider CLI command to generate review in non-interactive mode
- **Input**: Pass PR diff and context to CLI via stdin or prompt
- **Output Format**: Structured JSON or parseable text with categorized suggestions
- **Categories**: Include "praise" category for highlighting good practices
- **Adapter Pattern**: Design for future support of other AI providers

## UI Requirements
### Layout
- Single-page application with GitHub-like design
- File navigator/tree on the left
- Main diff view in center
- All changed files in single scrollable view

### Diff Display
- Unified diff view
- Expandable context (click to show more lines around changes)
- Inline comments displayed with diff hunks

### Interactions
- Button to trigger AI analysis
- Adopt/edit/discard controls for each AI suggestion
- Add custom comment buttons
- Submit review with approval status selection

### Theme
- Support both dark and light themes

## Technical Specifications

### Configuration
- Location: `~/.pair-review/config.json`
- Contents:
  ```json
  {
    "github_token": "...",
    "port": 7247,
    "theme": "light"
  }
  ```

### Database Schema (SQLite)
- Reviews table: Track all reviews performed
- Comments table: Store draft comments and AI suggestions
- PR metadata table: Cache PR information

### GitHub Integration
- Authentication via Personal Access Token (PAT)
- Submit reviews with inline comments
- Support Approve/Comment/Request Changes status

### Command Line Interface
- `npx pair-review <PR-number>` - Review by PR number
- `npx pair-review <PR-URL>` - Review by full GitHub URL
- `npx pair-review --local` - (Coming soon) Review uncommitted changes
- Verbose stdout logging for debugging

### Server
- Express.js server
- Configurable port (not fixed)
- Auto-open browser on start
- Serve static files and API endpoints

## Testing
- `npm test` - Run all tests once
- `npm run test:watch` - Run tests in watch mode (re-runs on file changes)
- `npm run test:coverage` - Run tests with coverage report
- `npm run test:e2e` - Run E2E tests
- `npm run test:e2e:headed` - Run E2E tests with browser

Test structure:
- `tests/unit/` - Unit tests
- `tests/integration/` - Integration tests (database, API routes)

## Development workflow
- **Git workflow**: Ask before committing to main or pushing to remote
- **Releases**: Never run `npm run release` unless explicitly instructed—it publishes to npm and pushes tags
- **Changesets**: Create a changeset (`.changeset/*.md`) for user-facing changes that warrant a version bump. Package "@in-the-loop-labs/pair-review". Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes. Not needed for docs-only or internal refactoring changes. Name changesets based on the actual change.
- Add a 'Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0' notice at the start of all source code files.
- Package name: `pair-review`
- No specific Node version requirement (use modern/recent)
- Adapter pattern for AI providers to enable future extensibility
- Verbose logging to stdout for debugging
- Handle errors gracefully with informative messages
- Aim to keep file sizes below 20K tokens
- **CRITICAL** Requirements:
  - Complete, professional implementation - no stubs, prototypes, or partial work
  - All change must support BOTH Local mode and PR mode
  - Include appropriate test coverage when making changes, especially for bug fixes
  - Consider whether a change also requires a README update
  - Rename plan files under `plans/` to match the functionality described
  - When completing a change, run the relevant tests
  - When completing changes that modify frontend code, use a Task tool run E2E tests

### Plan Hazards Section
- When creating implementation plans or issues, include a **Hazards** section that lists:
  - All existing code paths that perform similar work to the change being made
  - Shared functions that will be modified, with all their callers listed
  - State that could change between scheduling and execution (async races)
  - Completion/error handlers that assume they're the only thing in flight
- Example:
  > **Hazards**
  > `_applyScopeResult` has two callers: `_handleScopeChange` and
  > `showBranchReviewDialog`. Verify both paths after any change.
  > The completion handler was recently guarded against stale overwrites.
  > Any scope-syncing change must preserve that guard.

## Project Documentation Structure
- **CLAUDE.md**: Stable requirements (this file)

## Learnings

### Directory Conventions
- When modifying code in a directory, check for a `CONVENTIONS.md` in that directory or its parent.

### Local Mode and PR Mode Parity
- Features must work in BOTH Local mode (`/local/:reviewId`) and PR mode (`/pr/:owner/:repo/:number`)
- These modes have parallel but separate implementations:
  - **Backend**: `src/routes/local.js` vs `src/routes/comments.js` (PR mode)
  - **Frontend**: `public/js/local.js` patches methods on `PRManager` from `public/js/pr.js`
- When adding features that involve comments, API endpoints, or UI interactions, you MUST update both code paths
- Common places that need parallel updates:
  - API endpoints for fetching/modifying comments
  - Event listeners in frontend JavaScript
  - Query parameters and their handling
- **CLI vs Web UI entry points**: Some actions have two entry points — the CLI startup path and the web UI route handler. For example, local review sessions are created in `src/local-review.js` (CLI) and `src/routes/local.js` (web UI `POST /api/local/start`). PR reviews are set up via the browser hitting the GET endpoint. When adding cross-cutting behavior (hooks, logging, side effects), verify it fires from BOTH entry points.
- **Analysis code paths in `src/ai/analyzer.js`**: There are three independent code paths that set up instructions and call analysis: (1) `analyzeAllLevels` (the main path), (2) `runReviewerCentricCouncil`, and (3) `runCouncilAnalysis`. When changing instruction handling, prompt construction, or analysis options, verify the change is applied to **all three paths**. The council paths build their own instructions objects and call `mergeInstructions` independently — they won't inherit changes made only to `analyzeAllLevels`.
- Test both modes manually or with E2E tests before considering a feature complete

### Testing Practices
- NEVER duplicate production code in tests. Always import and test the actual implementation. If a module lacks exports needed for testing, add them — see the `if (typeof module !== 'undefined')` pattern used in components like `ReviewModal.js` and `PanelGroup.js`.
- If production code is structured in a way that makes it hard to test (e.g., browser-only IIFEs), refactor the production code to be testable rather than duplicating it.
- When adding database migrations or new tables, ALWAYS update the test schemas in:
  - `tests/e2e/global-setup.js` (E2E test database)
  - `tests/integration/routes.test.js` (Integration test database)
  - Ensure index names match the production schema exactly
- **Test coverage is mandatory for new functionality**: When adding new methods, parameters, or behavioral changes to existing code, add corresponding unit tests in the same task. Do not defer test writing to a separate task or leave it for later. Tests should cover: (1) the happy path, (2) edge cases like missing/null inputs, (3) error conditions. For bug fixes, add a regression test that would have caught the bug.
- **Tests must NEVER open browser tabs or windows.** All calls to the `open` npm package in production code are gated behind `PAIR_REVIEW_NO_OPEN` env var. Vitest config sets this globally. Any test that spawns the CLI via `spawnSync`/`spawn` MUST include `PAIR_REVIEW_NO_OPEN: '1'` in its env. Playwright E2E tests must always run headless (`headless: true` in `playwright.config.js`). If you add a new code path that opens a browser, it must respect this env var.

### Skill Prompt Regeneration
- When modifying prompt templates or line number guidance in `src/ai/prompts/`, run `node scripts/generate-skill-prompts.js` to regenerate the static reference files in `plugin-code-critic/skills/analyze/references/`
- These reference files are used by the `code-critic:analyze` skill when no MCP connection is available, so they must stay in sync with the source prompts

### Logging Convention
- Always use `logger` (from `src/utils/logger.js`) instead of `console.log/error/warn` in server-side code. The logger provides consistent formatting and can be configured for different output levels. This applies to all route handlers, middleware, and utility code.

### Research Before Implementation
- **Look for official documentation before guessing at technical specs**. When integrating with external tools or APIs (Claude CLI, Gemini CLI, etc.), search for and consult official documentation rather than inferring behavior from trial and error. This prevents bugs from incorrect assumptions about data formats, message types, or API contracts.
- Key documentation sources for AI provider CLIs:
  - Claude Code: https://code.claude.com/docs/en/cli-reference and https://platform.claude.com/docs/en/agent-sdk/typescript
  - The Agent SDK TypeScript docs define all message types (`SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKSystemMessage`, etc.) and their exact field structures

### Import Conventions
- Always import dependencies at the top of the file. Never use inline `require()` calls inside functions or route handlers when the module is already imported at the top level. This keeps the dependency list visible and consistent across the codebase.

### Dependency Injection for OS/External Interactions
- For modules with heavy OS-level or external dependencies (child_process, fs, etc.), use the `defaults` object + `_deps` override pattern established in `src/protocol-handler.js`.
- Define a module-level `defaults` object containing real dependencies.
- Accept an optional `_deps` parameter that merges over defaults: `const deps = { ...defaults, ..._deps }`.
- In tests, use a `createMockDeps()` helper to provide explicit mocks.
- This avoids brittle `jest.mock()` / `vi.mock()` patterns and makes test setup self-documenting.
- **Never re-resolve config values.** When a module needs values from user config (tokens, paths, preferences), accept them via `_deps` from the caller — do not re-read or reconstruct config internally. The canonical config is loaded once via `loadConfig()` in the route/CLI entry point. Re-resolving creates silent divergences (e.g., skipping config-file tokens, ignoring custom commands). Pass resolved values down, don't reach up.

### ESM-Only Dependencies
- This project is CommonJS. Some dependencies ship as ESM-only (`"type": "module"` in their package.json). Using `require()` on these will crash on Node <22 with `ERR_REQUIRE_ESM`.
- When adding a new dependency, check its `package.json` for `"type": "module"`. If present, use a lazy `async function` with dynamic `import()` instead of top-level `require()`. See `loadAcp()` in `src/chat/acp-bridge.js` for the pattern.
- **Vitest cannot catch this bug.** Vitest's module system transparently handles `require()` of ESM packages, so tests pass even when the code would crash in plain Node. Do not rely on unit tests to guard against ESM/CJS interop issues.

### ACP Chat Provider Configuration
- For ACP (Agent Client Protocol) providers, use protocol-level methods for configuration, not CLI arguments.
- CLI arguments like `--model` are for interactive mode; ACP server mode (`opencode acp`, `gemini --experimental-acp`, etc.) ignores them.
- Use `unstable_setSessionModel({ sessionId, modelId })` after session creation to set the model.
- Configuration via protocol is more reliable and consistent across different ACP implementations.

### Team-Based Implementation: Integration Review

When using agent teams to implement features in parallel, always spawn a final "integration reviewer" teammate after all implementation teammates complete. This teammate should:

1. **Trace cross-boundary contracts**: Verify that producer outputs match consumer expectations (e.g., data formats, nullability assumptions, API naming conventions like `window.toast` vs `window.Toast`).
2. **Diff duplicated flows**: Find code paths that should behave identically and verify they don't diverge (e.g., missing steps like re-anchoring comments, updating titles, rolling back on failure).
3. **Walk end-to-end user flows**: Trace at least one happy path from UI interaction through frontend → API → backend → response → UI update, verifying each handoff.
4. **Check variable lifecycle**: Ensure variables are declared before use across the full execution path, especially when different teammates wrote different sections of the same function.

This pattern addresses coordination failures where individual pieces are well-implemented but the wiring between them breaks. Assign this teammate zero implementation files — read-only access, review-only role.
