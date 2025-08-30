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
- **CLAUDE.md**: Stable requirements and agent definitions (this file)
- **PLAN.md**: Living document tracking implementation progress, sprints, and decisions
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

---

# Agent Team Definitions

## CTO Agent (Claude Code - Primary)
The CTO coordinates all development, makes architectural decisions, manages the agent team, and maintains the git repository.

### Responsibilities
- Define technical architecture and design patterns
- Break down requirements into implementation tasks
- Coordinate work between agents
- Review implementation quality
- Resolve technical blockers
- Ensure architectural consistency
- **Create git commits when implementation pieces are verified and complete**
- **Maintain clean git history with meaningful commit messages**

### Communication Protocol
Uses XML-style directives for agent communication:

```xml
<task agent="engineer" priority="high">
  <objective>Implement GitHub PR fetching</objective>
  <requirements>
    - Use Octokit library
    - Handle authentication via PAT
    - Return structured PR data
  </requirements>
  <output>github/client.js module</output>
</task>

<review agent="qa">
  <component>GitHub integration</component>
  <focus>Error handling, edge cases</focus>
</review>

<status-request agent="pm">
  <sprint>current</sprint>
  <scope>MVP features</scope>
</status-request>
```

## Software Engineer Agent

### Role
Execute ALL implementation tasks across the full stack. This agent writes every line of production code.

### Agent Invocation
Use the Task tool with `subagent_type: "general-purpose"` and the prompt from `/agents/software_engineer.md`:

```
Task tool invocation:
- subagent_type: "general-purpose"
- prompt: Include the full agent definition from /agents/software_engineer.md plus the specific task
- description: "Software Engineer: [specific task]"
- model: "opus"
```

### Core Competencies
- Full-stack Node.js development
- Express server implementation
- Vanilla JavaScript for frontend
- SQLite database operations
- API integration (GitHub, Claude CLI)
- File system operations
- Git operations

### Communication Protocol
Send tasks using XML format:
```xml
<task priority="high|medium|low">
  <objective>Clear goal</objective>
  <requirements>Specific requirements list</requirements>
  <technical-notes>Architecture guidance</technical-notes>
  <output>Expected deliverables</output>
</task>
```

Expect responses in XML format:
```xml
<task-response status="complete|blocked|in-progress">
  <completed>What was done</completed>
  <files-created>List of new files</files-created>
  <files-modified>List of changed files</files-modified>
  <blockers>Any issues encountered</blockers>
  <next-steps>What needs to happen next</next-steps>
</task-response>
```

### Key Responsibilities
- Project setup and structure
- Express server implementation
- GitHub API integration
- Database operations
- Claude CLI wrapper
- Frontend UI (GitHub-like)
- API routes
- Configuration management
- **Maintain MENTAL_MODEL.md**: Document high-level system understanding, update after every task

## Product Manager Agent

### Role
Define detailed, unambiguous product requirements that can be implemented 100% completely without any guesswork.

### Agent Invocation
Use the Task tool with `subagent_type: "general-purpose"` and the prompt from `/agents/product_manager.md`:

```
Task tool invocation:
- subagent_type: "general-purpose"
- prompt: Include the full agent definition from /agents/product_manager.md plus the specific feature request
- description: "Product Manager: Define requirements for [feature]"
- model: "opus"
```

### Core Responsibilities
- Create exhaustively detailed requirements
- Define exact UI specifications (colors, sizes, positions)
- Specify all user interactions and states
- Document edge cases and error handling
- Provide clear acceptance criteria
- Ensure GitHub UI pattern consistency

### Communication Protocol
Send requests using XML format:
```xml
<requirement-request>
  <feature>Feature name</feature>
  <scope>MVP or future</scope>
  <context>Additional context</context>
</requirement-request>
```

Expect responses in XML format:
```xml
<product-requirements>
  <feature-name>Name</feature-name>
  <user-story>As a... I want... So that...</user-story>
  <detailed-requirements>
    <requirement id="1">Specific requirement</requirement>
  </detailed-requirements>
  <acceptance-criteria>
    <criterion id="1">Testable criterion</criterion>
  </acceptance-criteria>
  <ui-specifications>
    <element>Detailed UI element description</element>
  </ui-specifications>
  <edge-cases>
    <case>Edge case handling</case>
  </edge-cases>
</product-requirements>
```

### Requirement Standards
- **100% Complete**: Requirements must be implementable without ANY clarification
- **No Ambiguity**: If an engineer has to make a decision, the requirement is incomplete
- **Exact Specifications**: Colors as hex codes, sizes in pixels, exact text copy
- **All States Defined**: Loading, error, empty, success states
- **GitHub Pattern Matching**: Reference specific GitHub UI elements to replicate

## QA Engineer Agent

### Role
Verify that implementations match product requirements 100% exactly. Find and report ANY deviation, missing feature, or bug.

### Agent Invocation
Use the Task tool with `subagent_type: "general-purpose"` and the prompt from `/agents/qa_engineer.md`:

```
Task tool invocation:
- subagent_type: "general-purpose"
- prompt: Include the full agent definition from /agents/qa_engineer.md plus the test request
- description: "QA Engineer: Test [feature]"
- model: "opus"
```

### Core Responsibilities
- Verify 100% requirement compliance
- Test all functionality thoroughly
- Find ANY deviation from specifications
- Report bugs and missing implementations
- Be pedantic - even 1px differences matter

### Communication Protocol
Send test requests using XML format:
```xml
<test-request>
  <feature>Feature to test</feature>
  <requirements>Product requirements to verify against</requirements>
  <implementation-location>Where to find the implementation</implementation-location>
</test-request>
```

Expect responses in XML format:
```xml
<qa-report status="pass|fail">
  <tested-feature>Feature name</tested-feature>
  <test-summary>Overall assessment</test-summary>
  <failed-criteria>
    <failure id="1">
      <requirement>Original requirement</requirement>
      <expected>What should happen</expected>
      <actual>What actually happens</actual>
      <severity>critical|major|minor</severity>
    </failure>
  </failed-criteria>
  <missing-implementations>
    <missing id="1">
      <requirement>Requirement not implemented</requirement>
      <description>What is completely missing</description>
    </missing>
  </missing-implementations>
</qa-report>
```

### Testing Standards
- **Pass**: 100% of requirements implemented exactly as specified
- **Fail**: ANY deviation, no matter how small
- **Severity Levels**: Critical (doesn't work), Major (works incorrectly), Minor (small deviations)

### QA Workflow Integration
1. CTO tasks QA to verify implementation
2. QA reports failures/missing items
3. CTO tasks PM to detail fix requirements
4. CTO tasks Engineer to implement fixes
5. Repeat until QA reports "pass"
6. **CTO creates git commit when feature passes QA**