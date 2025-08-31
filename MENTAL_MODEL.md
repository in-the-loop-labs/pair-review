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
- **Client** (`client.js`): GitHub API wrapper using Octokit for fetching PR data

### 5. Git Worktree Management (`src/git/worktree.js`)
- **Role**: Manages local git worktrees for PR analysis
- **Key Features**:
  - **Stale Cleanup**: Prunes registered but missing worktrees
  - **Force Creation**: Uses `--force` flag to override existing registrations
  - **Diff Generation**: Creates unified diffs between base and head branches
  - **File Analysis**: Extracts changed files with statistics

### 6. API Endpoints (`src/routes/pr.js`)
- **GET /api/pr/:owner/:repo/:number**: Full PR metadata and basic info
- **GET /api/pr/:owner/:repo/:number/diff**: Diff content and changed files
- **GET /api/pr/:owner/:repo/:number/comments**: Review comments (future AI suggestions)

### 7. GitHub-like UI with Sidebar Layout (`public/`)
- **Role**: Rich GitHub-like interface with sidebar file navigation and diff viewer
- **Key Components**:
  - **Sidebar Layout**: Files navigation in left sidebar, main diff in center (like GitHub)
  - **File Tree**: Hierarchical folder structure with expand/collapse functionality
  - **Diff Viewer**: GitHub-styled diff display using Diff2Html with custom enhancements
  - **Context Expansion**: Expandable sections for hidden lines between diff blocks
  - **Progress Modal**: AI analysis progress display with 3-level structure
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
  - Level 2: File context (placeholder)
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
- AI integration for generating review suggestions
- Comment management (adopt/discard AI suggestions)  
- GitHub review submission functionality
- Full context expansion functionality (requires API endpoints for file content)
- Inline commenting functionality
- Syntax highlighting for diff content
- Comment persistence and draft management
- Keyboard shortcuts for navigation

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