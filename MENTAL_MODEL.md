# Mental Model: Pair-Review System Architecture

## Overview
Pair-Review is a local web application that helps human reviewers analyze GitHub pull requests with AI assistance. The system fetches PR data, creates local git worktrees for analysis, stores data in SQLite, and provides a web interface for review.

## Core Components

### 1. Entry Point (`src/main.js`)
- **Role**: Application orchestrator and entry point
- **Key Functions**:
  - Parses command line arguments for PR information
  - Initializes shared database instance
  - Coordinates PR fetching, worktree setup, and data storage
  - Passes shared database to server to ensure data persistence

### 2. Database Layer (`src/database.js`)
- **Role**: SQLite database management and schema
- **Key Features**:
  - **Persistent Schema**: Uses `CREATE TABLE IF NOT EXISTS` to preserve existing data
  - **Three Core Tables**: `pr_metadata`, `reviews`, `comments`
  - **Database Status**: Provides diagnostic information about stored data
- **Critical Fix**: Removed table dropping to ensure data persists between server restarts

### 3. Server (`src/server.js`)
- **Role**: Express web server with API endpoints
- **Key Features**:
  - **Shared Database**: Accepts database instance from main.js instead of creating new one
  - **Port Management**: Automatically finds available ports
  - **Status Logging**: Reports database contents on startup
  - **Static Files**: Serves web interface from `/public`

### 4. GitHub Integration (`src/github/`)
- **Parser** (`parser.js`): Extracts owner/repo/number from various PR URL formats
- **Client** (`client.js`): GitHub API wrapper using Octokit for fetching PR data and submitting reviews
  - **Review Submission**: `createReview()` method submits complete reviews with inline comments
  - **Position Calculation**: `calculateDiffPosition()` converts line numbers to GitHub API diff positions
  - **Enhanced Error Handling**: Specialized error handling for review submission failures
  - **Token Validation**: Validates GitHub tokens before attempting review submission

### 5. Git Worktree Management (`src/git/worktree.js`)
- **Role**: Manages local git worktrees for PR analysis
- **Key Features**:
  - **Stale Cleanup**: Prunes registered but missing worktrees
  - **Force Creation**: Uses `--force` flag to override existing registrations
  - **Diff Generation**: Creates unified diffs between base and head branches
  - **File Analysis**: Extracts changed files with statistics

### 6. AI Analysis System (`src/ai/analyzer.js`)
- **Role**: Multi-level AI analysis engine with real-time progress tracking
- **Key Features**:
  - **Real File Tracking**: Uses actual changed files from PR data instead of fake progress steps
  - **Multi-level Support**: Level 1 (diff analysis), Level 2 (file context), Level 3 (codebase context)
  - **Progress Callbacks**: Real-time file-by-file progress updates via Server-Sent Events
  - **Database Integration**: Stores suggestions in comments table with AI metadata
- **Level 1 Implementation**: Full implementation with Claude CLI integration analyzing diff changes
- **Level 2 Implementation**: Full implementation with file context analysis for complete files under 10,000 lines
- **Level 3 Implementation**: Placeholder implementation with realistic progress simulation
- **Progress Modal Integration**: Real-time updates to ProgressModal.js with file-by-file tracking

### 7. API Endpoints (`src/routes/pr.js`)
- **GET /api/pr/:owner/:repo/:number**: Full PR metadata and basic info
- **GET /api/pr/:owner/:repo/:number/diff**: Diff content and changed files
- **GET /api/pr/:owner/:repo/:number/comments**: Review comments (legacy endpoint)
- **GET /api/pr/:owner/:repo/:number/ai-suggestions**: AI-generated suggestions from analysis
- **POST /api/analyze/:owner/:repo/:pr**: Trigger Level 1 AI analysis with real-time progress
- **POST /api/analyze/:owner/:repo/:pr/level2**: Trigger Level 2 AI analysis (implemented but runs automatically after Level 1)
- **POST /api/analyze/:owner/:repo/:pr/level3**: Trigger Level 3 AI analysis (placeholder)
- **GET /api/analyze/status/:id**: Get analysis status by analysis ID
- **GET /api/pr/:id/ai-suggestions/status**: Server-Sent Events endpoint for real-time progress
- **POST /api/ai-suggestion/:id/status**: Update suggestion status (adopt/dismiss/active)
- **POST /api/ai-suggestion/:id/edit**: Edit suggestion text and adopt as user comment
- **POST /api/user-comment**: Create new user comment on any line
- **GET /api/pr/:id/user-comments**: Get all user comments for a PR
- **PUT /api/user-comment/:id**: Update existing user comment
- **DELETE /api/user-comment/:id**: Delete user comment (soft delete)
- **POST /api/pr/:owner/:repo/:number/submit-review**: Submit complete review to GitHub (IMPLEMENTED with full functionality)

### 8. GitHub-like UI with Sidebar Layout (`public/`)
- **Role**: Rich GitHub-like interface with sidebar file navigation and diff viewer
- **Key Components**:
  - **Sidebar Layout**: Files navigation in left sidebar, main diff in center (like GitHub)
  - **File Tree**: Hierarchical folder structure with expand/collapse functionality
  - **Diff Viewer**: GitHub-styled diff display using Diff2Html with custom enhancements
  - **Context Expansion**: Expandable sections for hidden lines between diff blocks
  - **Progress Modal**: AI analysis progress display with 3-level structure and real-time file tracking
    - **Enhanced Progress Bars**: Shows animated progress bars for active levels only
    - **File-by-File Updates**: Real-time display of "Analyzing file X of Y" with actual file names
    - **Multi-Level Support**: Level 2 and Level 3 ready with progress bar activation
  - **Status Indicator**: Background analysis status in toolbar
  - **Responsive Design**: Auto-collapses sidebar on mobile, maintains usability
- **Architecture**:
  - **Component-Based**: Modular JavaScript components for modal and status indicator
  - **Single-View**: All files displayed in single scrollable diff with file navigation
  - **CSS Variables**: Theme support with light/dark mode capabilities
  - **Event-Driven**: File tree clicks scroll to corresponding diff sections
  - **Real-time Updates**: SSE connection for live progress updates

## Data Flow

### PR Processing Flow
1. **User runs**: `npx pair-review <PR-URL-or-number>`
2. **main.js**: Initializes database, parses arguments
3. **GitHub API**: Fetches PR metadata and commit information
4. **Worktree Setup**: Creates local checkout of PR branch
5. **Diff Generation**: Generates unified diff between base and head
6. **Data Storage**: Stores all data in SQLite database
7. **Server Start**: Launches web server with shared database instance
8. **Browser Opens**: Automatically opens to PR review interface

### Database Persistence Architecture
- **Single Instance**: Main.js creates database, passes to server
- **Persistent Storage**: Database preserves data between application runs
- **Schema Evolution**: Uses `CREATE IF NOT EXISTS` for safe schema updates

### AI Analysis Progress Architecture (Phase 4.2)
- **Modal-Based UI**: Progress modal shows 3-level analysis structure
  - Level 1: Analyzing diff (implemented)
  - Level 2: File context (implemented - runs automatically after Level 1)
  - Level 3: Codebase context (placeholder)
- **Background Execution**: Modal can be dismissed to run in background
- **Status Indicator**: Toolbar indicator shows progress when in background
- **Real-time Updates**: Server-Sent Events (SSE) for live progress streaming
- **Progress Broadcasting**: Server broadcasts status changes to connected clients

## Key Fixes Implemented

### 1. Database Instance Sharing (Critical)
**Problem**: main.js and server.js created separate database instances
- Main stored data in one database
- Server queried different database (always empty)

**Solution**: Modified `startServer()` to accept shared database parameter
- `startServer(sharedDb)` uses passed instance instead of creating new one
- Ensures single source of truth for data

### 2. Worktree Registration Cleanup
**Problem**: Git worktrees became "orphaned" - registered but directory missing
- Caused `already registered worktree` errors

**Solution**: Enhanced cleanup process
- Added `pruneWorktrees()` to clean stale registrations
- Uses `--force` flag for worktree creation when conflicts exist
- Graceful fallback handling for various failure modes

### 3. Database Schema Persistence
**Problem**: Database dropped all tables on every initialization
- Lost all stored PR data between runs

**Solution**: Changed to preservation-first approach
- Removed `DROP TABLE` statements
- Uses `CREATE TABLE IF NOT EXISTS` for safe initialization
- Added database status logging for visibility

## Current System State

### Working Features
- ✅ PR fetching from GitHub API
- ✅ Local git worktree creation and management  
- ✅ Unified diff generation
- ✅ SQLite data persistence across runs
- ✅ Web server with API endpoints
- ✅ Automatic browser opening
- ✅ Port conflict resolution
- ✅ GitHub-like UI with sidebar file navigation
- ✅ Hierarchical file tree with expand/collapse folders
- ✅ File navigation with click-to-scroll functionality
- ✅ Sidebar toggle with responsive collapse/expand
- ✅ Enhanced diff viewer with context expansion UI
- ✅ Color-coded line changes (additions/deletions/context)
- ✅ Proper line numbering and file headers
- ✅ Theme support (CSS variables for light/dark modes)
- ✅ AI analysis progress modal with 3-level structure
- ✅ Background execution with status indicator
- ✅ Real-time progress updates via SSE
- ✅ AI suggestion display and management (adopt/dismiss)
- ✅ Level 2 AI analysis with file context examination
- ✅ Level 2 suggestions labeled as "File Context" in UI
- ✅ Automatic Level 2 analysis after Level 1 completion
- ✅ File size limits for Level 2 analysis (10,000 line threshold)
- ✅ Edit AI suggestions before adopting feature
  - ✅ Edit button positioned between Adopt and Dismiss buttons
  - ✅ Textarea with pre-filled suggestion text
  - ✅ Save/Cancel buttons with proper styling
  - ✅ Keyboard shortcuts (Ctrl/Cmd+Enter to save, Escape to cancel)
  - ✅ Validation for empty comments with error display
  - ✅ Loading states during save operation
  - ✅ Only one suggestion can be in edit mode at a time
  - ✅ Creates user comment record and links to original suggestion
  - ✅ API endpoint for editing suggestions (/api/ai-suggestion/:id/edit)
- ✅ Review Workflow Features (Phase 5)
  - ✅ User comment creation with "+ Add comment" button on hover
  - ✅ Inline comment forms with textarea and save/cancel buttons
  - ✅ Auto-save draft functionality with "Draft saved" indicator
  - ✅ User comment display with edit/delete functionality
  - ✅ Fixed bottom review panel with approval status dropdown
  - ✅ Comment count display in review panel
  - ✅ Review submission to GitHub API (FULLY IMPLEMENTED)
  - ✅ Support for Approve/Comment/Request Changes review types
  - ✅ Complete user comment CRUD operations via API
  - ✅ Draft persistence using localStorage
  - ✅ GitHub-like UI styling for all comment elements
- ✅ GitHub Review Submission (Phase 6)
  - ✅ Complete review submission functionality in GitHubClient
  - ✅ Position calculation for inline comments in diffs
  - ✅ Token validation before submission attempts
  - ✅ Comprehensive error handling for all submission failure scenarios
  - ✅ Support for APPROVE/REQUEST_CHANGES/COMMENT review events
  - ✅ Automatic comment formatting for GitHub API compatibility
  - ✅ Real GitHub submission via submit-review API endpoint
  - ✅ Database transaction handling for submission tracking
  - ✅ Comment limit validation (50 comments per review)
  - ✅ GitHub token availability through app context
  - ✅ Response includes GitHub review URL and review ID
  - ✅ Proper error status codes and messages for all failure scenarios
- ✅ Enhanced Review Modal UI (Phase 6.1)
  - ✅ Toast notification component for success/error feedback
  - ✅ Loading spinner with "Submitting review..." text during submission
  - ✅ Success toast with GitHub review link (green #1f883d background)
  - ✅ Detailed error messages displayed inline in modal (red #d1242f)
  - ✅ Modal non-dismissible during submission (no close button, no backdrop click)
  - ✅ Large review warning for >50 comments with warning dialog
  - ✅ Toast auto-dismiss after 5000ms with 300ms fade-out animation
  - ✅ Dark theme support for all toast and modal elements
  - ✅ 16px spinner positioned left of "Submitting review..." text
  - ✅ Error messages at 16px below submit button with proper styling

### API Endpoints Verified
- ✅ `/api/pr/owner/repo/number` - Returns full PR data
- ✅ `/api/pr/owner/repo/number/diff` - Returns diff and file changes
- ✅ `/api/pr/owner/repo/number/comments` - Returns comments (empty for now)
- ✅ `/api/analyze/owner/repo/number` - Start AI analysis (POST)
- ✅ `/api/analyze/status/id` - Get analysis status
- ✅ `/api/pr/id/ai-suggestions/status` - SSE endpoint for real-time progress

### Database Schema
```sql
pr_metadata: Stores PR basic info and GitHub data blob
reviews: Tracks review status and metadata  
comments: Will store AI suggestions and user comments
```

## Development Notes

### Testing the System
- **Demo PR**: Use `npm run dev -- 1` to test with PR #1 from in-the-loop-labs/pair-review
- **Data Verification**: Check database status in server logs
- **API Testing**: Use curl to verify endpoints return data
- **Persistence Testing**: Restart server and confirm data remains

### Key Architecture Decisions
- **Local-First**: All processing happens locally, no cloud dependencies
- **SQLite Choice**: Simple, file-based database for local storage
- **Shared Database Pattern**: Single instance passed between components
- **Graceful Port Handling**: Automatically finds available ports for development

### Future Enhancements
- Full context expansion functionality (requires API endpoints for file content)
- Syntax highlighting for diff content
- Keyboard shortcuts for navigation
- Multi-user support with proper authentication
- Comment threading and replies
- Markdown support in comments
- Comment history and versioning
- Retry logic for failed review submissions
- Review draft saving before submission
- Multiple AI provider support beyond Claude

## Troubleshooting

### Common Issues
1. **"Pull request not found"**: Database instance not shared - check server logs for "Using shared database"
2. **Worktree creation fails**: Run `git worktree prune` manually or restart application
3. **Port conflicts**: Application automatically finds available ports
4. **GitHub API errors**: Check GitHub token configuration in `~/.pair-review/config.json`

### Diagnostic Commands
```bash
# Check database contents
sqlite3 ~/.pair-review/database.db "SELECT COUNT(*) FROM pr_metadata;"

# List current worktrees  
git worktree list

# Clean stale worktrees
git worktree prune
```

This mental model reflects the current working state after fixing the critical database persistence and worktree management issues.