# Mental Model: Pair-Review System Architecture

## Overview
Pair-Review is a local web application that helps human reviewers analyze GitHub pull requests with AI assistance. The system fetches PR data, creates local git worktrees for analysis, stores data in SQLite, and provides a web interface for review.

## Core Components

### 1. Entry Point (`src/main.js`)
- **Role**: Application orchestrator that coordinates the entire PR review process
- **Key Functions**:
  - Parses command line arguments and handles `--ai` and `--direct` flags
  - `--ai` flag: Automatic analysis in web UI mode
  - `--direct` flag: Automated review mode that bypasses web UI entirely
  - Initializes shared database instance and coordinates data flow
  - Sets up PR fetching, worktree creation, and launches web server (except in direct mode)
  - Passes shared database to server to ensure data persistence

### 2. Database Layer (`src/database.js`)
- **Role**: SQLite-based persistence layer with three core tables
- **Schema Design**:
  - `pr_metadata`: Stores PR information and GitHub data
  - `reviews`: Tracks review status and metadata
  - `comments`: Stores both AI suggestions and user comments
- **Architecture**: Uses persistent schema with shared database instance pattern

### 3. Server (`src/server.js`)
- **Role**: Express web server that bridges frontend and backend services
- **Key Features**:
  - Accepts shared database instance to maintain data consistency
  - Auto-discovers available ports for conflict-free development
  - Serves both static files and REST API endpoints

### 4. GitHub Integration (`src/github/`)
- **Parser**: Extracts repository information from various PR URL formats
- **Client**: Octokit-based wrapper for GitHub API operations
  - Handles PR data fetching and review submission
  - Manages authentication via personal access tokens
  - Converts line numbers to GitHub API diff positions for inline comments

### 5. Git Worktree Management (`src/git/worktree.js`)
- **Role**: Manages isolated git environments for PR analysis
- **Architecture**: Creates temporary worktrees to avoid conflicts with main repository
- **Features**: Handles stale cleanup, diff generation, and file change analysis

### 6. AI Analysis System (`src/ai/analyzer.js`)

#### Multi-Level Analysis Architecture
- **Level 1**: Analyzes changes in isolation (diff-only context)
- **Level 2**: Analyzes changes within complete file context  
- **Level 3**: Analyzes changes within broader codebase context

#### AI Orchestration Layer
- **Revolutionary Architecture**: Memory-first processing that keeps all suggestions in memory until orchestration completes
- **Intelligent Curation**: Fourth AI pass that merges related suggestions and eliminates redundancy
- **Human-Centric Framing**: Positions AI as a pair programming partner providing guidance, not mandates
- **Priority-Based Organization**: Curates suggestions by importance (security > bugs > architecture > performance > style)
- **Quality Over Quantity**: Produces balanced output with limited praise and focused actionable insights
- **Robust JSON Parsing**: Multi-strategy extraction handles markdown blocks, mixed content, and various response formats
- **Error-Resilient Processing**: Graceful fallbacks ensure suggestions are never lost due to parsing failures

#### Test Detection System
- **Purpose**: Intelligently determines when to include test coverage analysis
- **Multi-Language Support**: Detects test frameworks across JavaScript, Python, Java, Go, Ruby, Rust, and others
- **Performance Optimized**: Caches detection results and limits file system scans

### 7. Web Interface (`public/`)
- **GitHub-like Design**: Familiar interface with sidebar file navigation and diff viewer
- **Component Architecture**: Modular JavaScript components with CSS variable theming
- **Real-time Updates**: Server-Sent Events for progress tracking during AI analysis
- **Responsive Layout**: Auto-collapsing sidebar with mobile-friendly design

### 8. Direct Review Mode (`src/ai/direct-reviewer.js`)
- **Purpose**: Fully automated review workflow that bypasses the web UI
- **Triggered by**: `--direct` command line flag
- **Workflow**:
  1. Runs complete AI analysis (all 3 levels automatically)
  2. Adopts ALL AI suggestions as user comments using parent_id linkage
  3. Submits review to GitHub as DRAFT status (always DRAFT, not configurable)
  4. Exits process with completion summary
- **Use Case**: Automated CI/CD integration or quick review generation
- **Output**: GitHub DRAFT review ready for human inspection

## Data Flow

### PR Processing Flow
1. **Command Line**: User runs `npx pair-review <PR-URL>` with optional `--ai` or `--direct` flag
2. **Initialization**: Application parses arguments, initializes shared database
3. **GitHub Integration**: Fetches PR metadata and commit information via API
4. **Local Setup**: Creates git worktree and generates unified diff
5. **Data Storage**: Persists all data in SQLite database
6. **Mode Selection**:
   - **Direct Mode** (`--direct`): Launches DirectReviewer, performs automated analysis and submission, exits
   - **Web Mode** (default): Launches Express server with shared database instance
7. **Browser Interface**: (Web mode only) Opens web interface, optionally auto-triggering AI analysis

### AI Analysis Architecture
- **Multi-Level Pipeline**: Sequential analysis at diff → file → codebase levels
- **Memory-First Processing**: All suggestions held in memory during analysis
- **Orchestration Layer**: Fourth AI pass curates and merges suggestions intelligently  
- **Database Persistence**: Only final orchestrated results stored to eliminate noise
- **Real-time Progress**: Server-Sent Events stream analysis progress to frontend

### Review Workflow
- **Suggestion Management**: Users can adopt, edit, or dismiss AI suggestions
- **Comment System**: Full CRUD operations for user comments with draft persistence
- **GitHub Integration**: Complete review submission with inline comments and approval status

## Key Architecture Decisions

### Local-First Design
- **No Cloud Dependencies**: All processing happens locally for privacy and control
- **SQLite Storage**: File-based database for simple, reliable local persistence
- **Git Worktrees**: Isolated environments prevent conflicts with main repository

### Shared Database Pattern  
- **Single Instance**: Database created once in main.js, passed to all components
- **Data Consistency**: Ensures all components see same data state
- **Persistent Schema**: Preserves data across application restarts

### AI Orchestration Architecture
- **Memory-First Processing**: Suggestions held in memory until final curation
- **Intelligent Merging**: AI-powered orchestration eliminates redundancy and noise
- **Human-Centric Output**: Balanced, actionable guidance over comprehensive lists

### Component Integration
- **Event-Driven Updates**: Server-Sent Events for real-time progress streaming
- **GitHub-Like UI**: Familiar interface patterns for immediate usability
- **Modular Design**: Component-based architecture for maintainability and extensibility