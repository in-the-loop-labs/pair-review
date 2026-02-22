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
- Add a 'SPDX-License-Identifier: GPL-3.0-or-later' notice at the start of all source code files.
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
- Test both modes manually or with E2E tests before considering a feature complete

### Testing Practices
- NEVER duplicate production code in tests. Always import and test the actual implementation.
- If production code is structured in a way that makes it hard to test (e.g., browser-only IIFEs), refactor the production code to be testable rather than duplicating it.
- When adding database migrations or new tables, ALWAYS update the test schemas in:
  - `tests/e2e/global-setup.js` (E2E test database)
  - `tests/integration/routes.test.js` (Integration test database)
  - Ensure index names match the production schema exactly
- **Test coverage is mandatory for new functionality**: When adding new methods, parameters, or behavioral changes to existing code, add corresponding unit tests in the same task. Do not defer test writing to a separate task or leave it for later. Tests should cover: (1) the happy path, (2) edge cases like missing/null inputs, (3) error conditions. For bug fixes, add a regression test that would have caught the bug.

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
