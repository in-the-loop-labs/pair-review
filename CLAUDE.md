# Pair-Review Project Requirements

## Overview
Pair-Review is a local web application that assists human reviewers with GitHub pull request reviews by providing AI-powered suggestions and insights. The AI acts as a pair programming partner, highlighting potential issues and noteworthy aspects to accelerate the review process while keeping the human reviewer in control.

## Core Architecture
- **Backend**: Node.js with Express server
- **Frontend**: Vanilla JavaScript (no framework) - familiar GitHub-like UI
- **Database**: SQLite for local storage of reviews and drafts
- **AI Integration**: Claude CLI in SDK mode (`claude -p` for programmatic output)
- **Distribution**: npm package executable via `npx pair-review`

## Key Design Principles
- **GitHub UI Familiarity**: Interface should feel instantly familiar to GitHub users
- **Human-in-the-loop**: AI suggests, human decides
- **Local-first**: All data and processing happens locally
- **Progressive Enhancement**: Start simple, add features incrementally

## Core Workflow
1. User runs `npx pair-review <PR-number-or-URL>`
2. App checks out PR branch locally (new worktree or separate branch to avoid conflicts)
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
- **Execution**: Use `claude -p` command to generate review in non-interactive mode
- **Input**: Pass PR diff and context to Claude via stdin or prompt
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
- Unified diff view (priority for MVP)
- Expandable context (click to show more lines around changes)
- Inline comments displayed with diff hunks
- No syntax highlighting required for MVP

### Interactions
- Button to trigger AI analysis
- Adopt/edit/discard controls for each AI suggestion
- Add custom comment buttons
- Submit review with approval status selection

### Theme
- Support both dark and light themes
- Match GitHub's default styling

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
- Verbose stdout logging for debugging

### Server
- Express.js server
- Configurable port (not fixed)
- Auto-open browser on start
- Serve static files and API endpoints

## MVP Features
✅ GitHub PR integration with local checkout
✅ AI-powered review suggestions via Claude CLI
✅ Categorized feedback including praise
✅ Draft/WIP review saving in SQLite
✅ Review history tracking
✅ Submit reviews with inline comments to GitHub
✅ Expandable diff context
✅ Dark/light theme support
✅ File navigator
✅ Unified diff view

## Future Features (Post-MVP)
- Interactive chat with AI about specific code sections
- Multiple AI provider support beyond Claude
- Split diff view option
- Syntax highlighting
- Multi-user support
- PR discovery/list UI in web interface
- Markdown formatting in comments
- Confidence levels or priority indicators on AI suggestions
- Progressive loading for large PRs
- Offline mode

## Development Notes
- Package name: `pair-review`
- No specific Node version requirement (use modern/recent)
- Adapter pattern for AI providers to enable future extensibility
- Verbose logging to stdout for debugging
- Handle errors gracefully with informative messages

## Implementation Priority
1. Core GitHub integration (checkout, API communication)
2. Basic web UI with diff display
3. Claude CLI integration for AI suggestions
4. SQLite persistence
5. Comment management (adopt/edit/discard)
6. Review submission to GitHub
7. UI polish and themes

## Project Documentation Structure
- **CLAUDE.md**: Stable requirements (this file)
- **AGENT_TEAM.md**: Agent definitions
- **MENTAL_MODEL.md**: Software Engineer's understanding of system architecture (maintained by Engineer)

## Prior Art and Reference Implementations

### 1. local-review
- **Location**: GitHub `in-the-loop-labs/local-review` or locally at `../local_review/local-review`
- **Key Learnings**: Excellent GitHub-like UI for displaying code diffs and commenting
- **What to copy**: The diff viewer implementation and commenting UI patterns
- **Different aims**: But the UI implementation is highly relevant

### 2. pair-review-v1
- **Location**: GitHub `in-the-loop-labs/pair-review-v1` or locally at `../pair_review_project`
- **Key Learnings**: AI suggestion implementation concepts
- **What to copy**: Parts of the AI suggestion logic may be useful
- **What to avoid**: Do NOT copy the UI or overall flow - has problems with persistence and display of AI suggestions
- **Issues**: Poor integration between AI suggestions and user comments

### 3. pair-review-gpt5
- **Location**: Locally at `../pair_review_gpt5`
- **Key Learnings**: Review setup process, worktree creation and management
- **What to copy**: The approach to setting up each review and managing git worktrees
- **Issues**: Incomplete UI that doesn't come together well

### Implementation Guidance from Prior Art
- **UI**: Use local-review's GitHub-like diff viewer as the foundation
- **AI Integration**: Learn from pair-review-v1's approach but ensure better persistence and display
- **Review Setup**: Adopt pair-review-gpt5's worktree management approach
- **Critical Improvement**: Ensure AI suggestions have seamless integration with user comments (a weakness in prior versions)

