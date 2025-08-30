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

### 7. GitHub-like Diff Viewer (`public/js/pr.js` + `public/css/styles.css`)
- **Role**: Rich diff display using Diff2Html library for GitHub-like appearance
- **Key Features**:
  - **Unified Diff View**: Single-column diff display matching GitHub's style
  - **Line Number Display**: Dual line numbers (old/new) with "8 8" format
  - **Color-coded Changes**: Green for additions, red for deletions, white for context
  - **File Headers**: Clean file name headers with proper styling
  - **DOM Generation**: Manual DOM creation for precise control over structure
- **Implementation**: Copied from local-review project with adaptations for pair-review

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
- ✅ GitHub-like diff viewer with Diff2Html integration
- ✅ Color-coded line changes (additions/deletions/context)
- ✅ Proper line numbering and file headers

### API Endpoints Verified
- ✅ `/api/pr/owner/repo/number` - Returns full PR data
- ✅ `/api/pr/owner/repo/number/diff` - Returns diff and file changes
- ✅ `/api/pr/owner/repo/number/comments` - Returns comments (empty for now)

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
- Context expansion controls for diff viewer
- Inline commenting functionality
- File navigator/tree sidebar

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