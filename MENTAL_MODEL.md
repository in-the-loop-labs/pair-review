# Pair Review - System Architecture Mental Model

## High-Level Overview

Pair Review is a local web application that assists human reviewers with GitHub pull request reviews using AI-powered suggestions. The system follows a client-server architecture with local data persistence.

## Architecture Components

### 1. Entry Point & Distribution
- **Binary Script**: `bin/pair-review.js` - Executable entry point for `npx pair-review` command
- **Package**: Distributed as npm package with bin entry for global/npx execution
- **Node.js Requirements**: >=16.0.0

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

### 5. Frontend Layer (`public/`)
- **Technology**: Vanilla HTML/CSS/JavaScript (no frameworks)
- **Design**: GitHub-like UI patterns and styling
- **Theme**: White background (#ffffff), dark gray text (#24292f)
- **Typography**: System font stack matching GitHub
- **Current State**: Minimal landing page with only centered h1 "Pair Review - Coming Soon"

## Data Flow Architecture

### Configuration Flow
1. Application starts → Load/create `~/.pair-review/config.json`
2. Validate configuration values (especially port)
3. Use configuration throughout application lifecycle

### Database Initialization Flow
1. Connect to SQLite database at `~/.pair-review/database.db`
2. If corrupted → Recreate with fresh schema
3. Execute schema creation in transaction
4. Create performance indexes
5. Provide promise-based query interface

### Server Startup Flow
1. Load configuration
2. Initialize database
3. Create Express app with middleware
4. Find available port (with fallbacks)
5. Start server and log startup message
6. Set up graceful shutdown handlers

### Request Flow (Currently)
1. Client requests → Express middleware chain
2. Static files served from `public/` with cache headers
3. Root route (`/`) serves `index.html`
4. Health check available at `/health`
5. 404 handling for unknown routes

## Key Architectural Decisions

### Local-First Design
- All data stored locally in SQLite
- Configuration in user home directory
- No external service dependencies for core functionality

### Error Handling Strategy
- Strict error handling with process.exit(1) for critical failures:
  - Invalid configuration files
  - Invalid port numbers
  - Missing write permissions
  - Missing public directory
- Port conflict resolution with logging and fallback attempts
- Database corruption recovery with table recreation
- Comprehensive error logging with exact required messages

### Future Extension Points
- Database schema supports draft/submitted review states
- Comment system ready for AI suggestion integration
- Configuration system ready for GitHub token integration
- Server architecture ready for API endpoint expansion

## Development State

### Completed (Phase 1)
- ✅ Project structure and packaging
- ✅ Configuration management with validation
- ✅ SQLite database with complete schema
- ✅ Express server with middleware
- ✅ Error handling and graceful shutdown
- ✅ Basic HTML frontend
- ✅ Static file serving

### Next Development Areas (Phase 2+)
- GitHub API integration using Octokit
- Claude CLI wrapper for AI suggestions
- Frontend diff viewer and commenting UI
- Review workflow management
- Comment persistence and state management

## Integration Points

### External Services (Future)
- **GitHub API**: PR data fetching, comment submission
- **Claude CLI**: AI-powered review suggestions via `claude -p`

### Internal Module Communication
- Configuration → Server (port settings)
- Configuration → Database (file locations)
- Database → Server (data persistence)
- Server → Frontend (static files, API endpoints)

This mental model represents the current foundation state and provides clear extension points for upcoming features.