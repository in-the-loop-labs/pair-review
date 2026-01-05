# Pair-Review Project Requirements

## Overview
Pair-Review is a local web application that assists human reviewers with GitHub pull request reviews by providing AI-powered suggestions and insights. The AI acts as a pair programming partner, highlighting potential issues and noteworthy aspects to accelerate the review process while keeping the human reviewer in control.

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
    "port": 3000,
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

## Future Features (Post-MVP)
- Interactive chat with AI about specific code sections

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
- Package name: `pair-review`
- No specific Node version requirement (use modern/recent)
- Adapter pattern for AI providers to enable future extensibility
- Verbose logging to stdout for debugging
- Handle errors gracefully with informative messages
- CRITICAL: Complete, professional implementation - no stubs, prototypes, or partial work
- CRITICAL: Include appropriate test coverage when making changes
- CRITICAL: When completing a change, run the relevant tests
- CRITICAL: When completing changes that modify frontend code, use a Task tool run E2E tests

## Project Documentation Structure
- **CLAUDE.md**: Stable requirements (this file)

