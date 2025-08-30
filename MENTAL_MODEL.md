# Pair Review - System Architecture Mental Model

## High-Level Overview

Pair Review is a local web application that assists human reviewers with GitHub pull request reviews using AI-powered suggestions. The system follows a client-server architecture with local data persistence, GitHub API integration, and git worktree management for PR code analysis.

## Architecture Components

### 1. Entry Point & Distribution
- **Binary Script**: `bin/pair-review.js` - Spawns main application with command line arguments
- **Main Application**: `src/main.js` - Orchestrates PR processing workflow
- **Package**: Distributed as npm package with bin entry for global/npx execution
- **Node.js Requirements**: >=16.0.0
- **CLI Argument Handling**: Supports PR numbers and full GitHub URLs

### 2. Server Layer (`src/server.js`)
- **Framework**: Express.js web server
- **Port Management**: Configurable port (default 3000) with automatic fallback if in use (logs "Port [PORT] is already in use" when incrementing)
- **Public Directory Check**: Validates public directory exists at startup, exits with "Public directory not found" if missing
- **Middleware Stack**:
  - Request logging with timestamps
  - JSON body parsing
  - Static file serving with cache headers
  - Error handling and 404 responses
- **Graceful Shutdown**: Handles SIGINT/SIGTERM with proper cleanup
- **Health Check**: `/health` endpoint for monitoring

### 3. Configuration Management (`src/config.js`)
- **Location**: `~/.pair-review/config.json`
- **Auto-creation**: Creates directory and default config if missing
- **Schema**:
  ```json
  {
    "github_token": "",
    "port": 3000,
    "theme": "light"
  }
  ```
- **Validation**: Port range validation (1024-65535) - exits with error code 1 on invalid port
- **Error Handling**: 
  - Malformed config.json: logs "Invalid configuration file at ~/.pair-review/config.json" and exits with code 1
  - Missing write permissions: logs "Cannot create configuration directory at ~/.pair-review/" and exits with code 1

### 4. Database Layer (`src/database.js`)
- **Technology**: SQLite with sqlite3 package
- **Location**: `~/.pair-review/database.db`
- **Schema Design**:
  - **reviews**: Core review tracking (PR metadata, status with CHECK constraint for 'draft'|'submitted'|'pending', timestamps)
  - **comments**: Individual comments with file/line associations (comment_type with CHECK constraint for 'user'|'ai'|'system', status with CHECK constraint for 'draft'|'adopted'|'discarded')
  - **pr_metadata**: GitHub PR data caching with unique constraint
- **Indexes**: Exact names - idx_reviews_pr, idx_comments_review, idx_comments_file, idx_pr_metadata_unique (UNIQUE)
- **Transaction Safety**: All schema operations wrapped in transactions
- **Corruption Recovery**: Detects and recreates corrupted databases
- **Performance**: Comprehensive indexes for common queries
- **API**: Promise-based query/run/queryOne functions

### 5. GitHub Integration Layer
- **GitHub API Client**: `src/github/client.js` - Octokit wrapper with error handling and rate limiting
- **Argument Parser**: `src/github/parser.js` - Parses CLI arguments and git remotes
- **Authentication**: GitHub Personal Access Token (PAT) from config
- **Rate Limiting**: Exponential backoff with 1s, 2s, 4s delays
- **Error Handling**: Specific error messages for auth, not found, rate limits, network issues

### 6. Git Integration Layer
- **Worktree Manager**: `src/git/worktree.js` - Creates isolated worktrees for PR branches
- **Worktree Location**: `~/.pair-review/worktrees/[owner]-[repo]-[pr-number]/`
- **Branch Management**: Fetches PR head branch and checks out to specific commit
- **Diff Generation**: Creates unified diff between base and head branches
- **Cleanup**: Automatic worktree cleanup on failure and between reviews

### 7. API Layer
- **PR Routes**: `src/routes/pr.js` - Express routes for PR data access
- **Endpoints**:
  - `GET /api/pr/:owner/:repo/:number` - PR metadata and review status
  - `GET /api/pr/:owner/:repo/:number/diff` - PR diff and changed files
  - `GET /api/pr/:owner/:repo/:number/comments` - PR comments
  - `GET /api/prs` - List of cached PRs
  - `GET /api/pr/health` - API health check

### 8. Frontend Layer (`public/`)
- **Technology**: Vanilla HTML/CSS/JavaScript (no frameworks)
- **Design**: GitHub-like UI patterns and styling
- **PR Manager**: `public/js/pr.js` - Single-page PR display and management
- **Styling**: `public/css/pr.css` - GitHub-style responsive design
- **Features**:
  - PR information display with metadata, stats, and description
  - Tabbed interface: Files Changed, Diff View, Comments
  - Loading states with spinners and error handling
  - Responsive design for mobile/desktop

## Data Flow Architecture

### PR Processing Workflow
1. **CLI Invocation**: User runs `npx pair-review <PR-number-or-URL>`
2. **Argument Parsing**: `PRArgumentParser` extracts owner/repo/number
3. **Configuration Check**: Validate GitHub PAT exists
4. **GitHub API**: Fetch PR metadata, validate access
5. **Worktree Setup**: Create isolated git worktree with PR branch
6. **Diff Generation**: Generate unified diff and file change stats
7. **Data Storage**: Store PR data and diff in SQLite
8. **Server Launch**: Start Express server with PR context
9. **Browser Opening**: Auto-open to PR review interface

### Configuration Flow
1. Application starts → Load/create `~/.pair-review/config.json`
2. Validate GitHub token and configuration values
3. Use configuration throughout application lifecycle

### Database Initialization Flow
1. Connect to SQLite database at `~/.pair-review/database.db`
2. If corrupted → Recreate with fresh schema
3. Execute schema creation in transaction
4. Create performance indexes
5. Provide promise-based query interface

### Server Startup Flow
1. Load configuration and initialize database
2. Create Express app with middleware stack
3. Register PR API routes with database context
4. Find available port (with fallbacks)
5. Start server and setup graceful shutdown handlers

### Frontend Request Flow
1. **Welcome Page**: Default landing page with usage instructions
2. **PR Loading**: URL parameter triggers PR data fetch
3. **API Requests**: Frontend fetches PR data via REST endpoints
4. **Dynamic Display**: PR information rendered with GitHub-style UI
5. **Tab Navigation**: Files, diff, and comments loaded on demand
6. **Error Handling**: User-friendly error messages and retry options

## Key Architectural Decisions

### Local-First Design
- All data stored locally in SQLite
- Configuration in user home directory
- Git worktrees created locally for isolation
- No external service dependencies for core functionality

### Error Handling Strategy
- Strict error handling with process.exit(1) for critical failures
- GitHub API specific error messages for auth, rate limits, not found
- Git operation error handling with cleanup
- Port conflict resolution with fallback attempts
- Database corruption recovery with table recreation
- User-friendly error messages throughout UI

### GitHub Integration Architecture
- **Authentication**: PAT-based with validation
- **Rate Limiting**: Exponential backoff with retry logic
- **Data Caching**: Store PR data locally to reduce API calls
- **Isolation**: Each PR gets dedicated worktree to avoid conflicts

### Git Worktree Strategy
- **Isolation**: Each PR review in separate worktree directory
- **Cleanup**: Automatic removal on failure or completion
- **Branch Management**: Fetch PR-specific branches dynamically
- **Path Convention**: `~/.pair-review/worktrees/[owner]-[repo]-[pr-number]/`

### Frontend Architecture
- **No Framework**: Pure HTML/CSS/JavaScript for simplicity
- **Single Page**: Dynamic content loading without page refreshes
- **GitHub Styling**: Match familiar GitHub UI patterns
- **Progressive Enhancement**: Features load incrementally

## Development State

### Completed (Phase 1)
- ✅ Project structure and packaging
- ✅ Configuration management with validation
- ✅ SQLite database with complete schema
- ✅ Express server with middleware
- ✅ Error handling and graceful shutdown
- ✅ Basic HTML frontend
- ✅ Static file serving

### Completed (Phase 2)
- ✅ GitHub API integration using Octokit
- ✅ CLI argument parsing (PR numbers and URLs)
- ✅ Git worktree management for PR isolation
- ✅ PR data fetching and storage
- ✅ REST API endpoints for PR data
- ✅ Frontend PR display with GitHub-style UI
- ✅ Diff viewer and file change display
- ✅ Loading states and error handling
- ✅ Responsive design and tabbed interface
- ✅ Auto-browser opening with PR context

### Next Development Areas (Phase 3+)
- Claude CLI wrapper for AI suggestions
- AI suggestion display and management
- Comment creation and editing UI
- Review submission to GitHub
- Expandable diff context
- Dark/light theme support

## Integration Points

### External Services
- **GitHub API**: PR data fetching, repository access validation, authentication
- **Git Operations**: Worktree creation, branch fetching, diff generation
- **Claude CLI**: AI-powered review suggestions via `claude -p` (Phase 3)

### Internal Module Communication
- **CLI → Main**: Command line arguments and process orchestration
- **Main → Parser**: Argument parsing and repository detection
- **Main → GitHub Client**: API authentication and PR data fetching
- **Main → Worktree Manager**: Git operations and diff generation
- **Main → Database**: PR data storage and retrieval
- **Main → Server**: Web server startup with database context
- **Server → Routes**: API endpoint handling with database access
- **Frontend → API**: PR data fetching and display
- **Configuration**: Used by all modules for GitHub tokens and settings

### Data Storage Flow
- **PR Metadata**: GitHub API → SQLite pr_metadata table
- **Diff Data**: Git worktree → JSON in pr_metadata.pr_data
- **Review State**: UI interactions → SQLite reviews table
- **Comments**: User input → SQLite comments table (Phase 3)

This mental model represents the system architecture after completing Phase 2: GitHub Integration. The foundation now includes complete PR processing workflow, GitHub API integration, git worktree management, and a functional web interface for PR review. The system is ready for Phase 3: AI Integration and comment management features.