# pair-review

> Your AI-powered code review partner - Close the feedback loop between you and AI coding agents

[![npm version](https://img.shields.io/npm/v/@in-the-loop-labs/pair-review)](https://www.npmjs.com/package/@in-the-loop-labs/pair-review)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

[GitHub Repository](https://github.com/in-the-loop-labs/pair-review)

![pair-review screenshot](https://raw.githubusercontent.com/in-the-loop-labs/pair-review/main/docs/screenshot.png)

## What is pair-review?

pair-review is a local web application for keeping humans in the loop with AI coding agents. Calling it an AI code review tool would be accurate but incomplete — it supports multiple workflows beyond automated review, from reviewing agent-generated code before committing, to judging AI suggestions instead of reading every line, to using AI to guide your attention during a thorough review. You pick what fits your situation.

### Two Core Value Propositions

1. **Tight Feedback Loop for AI Coding Agents**
   - Review AI-generated code with clarity and precision
   - Provide structured feedback in markdown format
   - Copy and paste feedback directly back to your coding agent
   - Create a continuous improvement cycle where you stay in control

2. **AI-Assisted Human Review Partner**
   - Get AI-powered suggestions to accelerate your reviews
   - Highlight potential issues and noteworthy code patterns
   - You make the final decisions - adopt, edit, or discard AI suggestions
   - Add your own comments alongside AI insights

## Why pair-review?

- **Local-First**: All data and processing happens on your machine - no cloud dependencies
- **GitHub-Familiar UI**: Interface feels instantly familiar to GitHub users
- **Human-in-the-Loop**: AI suggests, you decide
- **Multiple AI Providers**: Support for Claude, Gemini, Codex, Copilot, OpenCode, and Cursor. Use your existing subscription!
- **Progressive**: Start simple with manual review, add AI analysis when you need it

## Workflows

There are no hard boundaries between these — mix and match as needed.

### 1. Local Review: Human Reviews Agent-Generated Code

**When to use:** You're working with a coding agent and want to review its changes before committing.

This is the core feedback loop workflow. When an agent generates code, open `pair-review` to review the uncommitted changes. With the GitHub-like UI, you can add comments at specific file and line locations, then copy that formatted feedback and paste it back into whatever coding agent you're using (or use MCP/skills to read comments directly into Claude Code).

Compared to giving feedback in chat, this feels like moving from a machete to a scalpel. Instead of trying to capture everything in one message, you can leave targeted comments at dozens of specific locations — and the agent addresses each one with surgical precision.

**How it works:**
1. Run `pair-review --local` to open the diff UI
2. Review changes in a familiar GitHub-like interface
3. Add comments with specific file and line locations
4. Copy formatted feedback and paste into your coding agent
5. Iterate until you're satisfied

**Tips:**
- Stage previous changes in git, then only review new modifications in the next round
- Local mode only shows unstaged changes and untracked files (opinionated by design)
### 2. Meta-Review: Judging AI Suggestions

**When to use:** You're not going to read every line of code. Let AI be your reader.

Instead of reviewing thousands of lines of code, you review a dozen AI suggestions. The AI reads the code; you review its recommendations. Each suggestion comes with enough context to evaluate it — even when you're not deeply familiar with the language or codebase.

Adopt suggestions you agree with, dismiss the rest, then feed adopted suggestions back to your coding agent. This is "supervised collaboration" — you stay in the loop without getting in the weeds.

**How it works:**
1. Open `pair-review --local` or `pair-review <PR-URL>` and click **Run Analysis**
2. AI performs three levels of review in parallel (see [Three-Level AI Analysis](#three-level-ai-analysis) below)
3. Results are deduplicated and combined by an orchestration step
4. Adopt suggestions you agree with, dismiss the rest
5. Feed adopted suggestions back to your coding agent

### 3. AI-Guided Review: When You're Accountable

**When to use:** You're reviewing code where someone is relying on your judgment. You're still reading the code — AI helps guide your attention and articulate feedback.

You're responsible for the review, but `pair-review` helps you be more thorough. Kick off the AI analysis and either wait for it to finish or start reading while it runs in the background. The AI suggestions guide you to areas worth attention and help you write clearer explanations. You can also do your own review first, then check whether the AI found the same things — a useful sanity check in both directions.

**How it works:**
1. Run AI analysis on the PR (in background or wait for results)
2. Read through the code with AI suggestions visible
3. Adopt suggestions you agree with, dismiss the rest, add your own comments
4. Submit as a rich, detailed review to GitHub

## Quick Start

### Installation

**Option 1: No installation required (npx)**

```bash
npx @in-the-loop-labs/pair-review <PR-number-or-URL or --local>
```

**Option 2: Global install**

```bash
npm install -g @in-the-loop-labs/pair-review
pair-review <PR-number-or-URL>
```

> **Tip:** Create an alias for frequent use:
> ```bash
> alias pr='npx @in-the-loop-labs/pair-review'
> ```

Either way, pair-review will:
1. Check out the PR branch locally (using git worktrees)
2. Open the web UI in your browser
3. Show you a familiar diff view

> **Note:** The examples below use the shorter `pair-review` command. If you're using npx without a global install, substitute `npx @in-the-loop-labs/pair-review` instead.

### Review a Pull Request

```bash
# By PR number (in a GitHub repo)
pair-review 123

# By full GitHub URL
pair-review https://github.com/owner/repo/pull/123

# Review local uncommitted changes
pair-review --local
```

### Basic Workflow

1. **Review the diff** - See all file changes in a familiar GitHub-like interface
2. **Optional: Trigger AI analysis** - Get 3-level AI review insights:
   - Level 1: Issues in changed lines only
   - Level 2: Consistency within file context
   - Level 3: Architectural consistency across codebase
3. **Add comments** - Adopt AI suggestions or write your own
4. **Export feedback** - Copy as markdown to paste back to your coding agent
5. **Submit review** - Post to GitHub with approval status (or keep it local)

## Command Line Interface

### Basic Usage

```bash
# Review a pull request by number
pair-review <PR-number>

# Review a pull request by URL
pair-review <PR-URL>

# Review local uncommitted changes in the current directory or a specified path
pair-review --local [path]
```

### Options

| Option | Description |
|--------|-------------|
| `<PR-number>` | PR number to review (requires being in a GitHub repo) |
| `<PR-URL>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`) |
| `--ai` | Automatically run AI analysis when the review loads |
| `--ai-draft` | Run AI analysis and save suggestions as a draft review on GitHub |
| `--configure` | Show setup instructions and configuration options |
| `-d`, `--debug` | Enable verbose debug logging for troubleshooting |
| `-h`, `--help` | Show help message with full CLI documentation |
| `-l`, `--local [path]` | Review local uncommitted changes. Optional path defaults to current directory |
| `--model <name>` | Override the AI model for any provider. Model availability depends on provider configuration. |
| `-v`, `--version` | Show version number |

### Examples

```bash
pair-review 123                        # Review PR #123 in current repo
pair-review https://github.com/owner/repo/pull/456
pair-review --local                    # Review uncommitted local changes
pair-review 123 --ai                   # Auto-run AI analysis
```

## Configuration

On first run, pair-review will prompt you to configure the application.

**Token Requirements:**
- **Local mode** (`--local`): Works without a GitHub token - no configuration needed
- **PR review mode**: Requires a GitHub Personal Access Token to fetch PR data and submit reviews

Configuration is stored in `~/.pair-review/config.json`:

```json
{
  "github_token": "ghp_your_token_here",
  "port": 7247,
  "theme": "light",
  "default_provider": "claude",
  "default_model": "opus"
}
```

On first run, pair-review creates `~/.pair-review/config.example.json` with comprehensive examples of all available options, including custom provider and model configurations. Use this as a reference when customizing your setup.

For advanced configuration with custom providers and models, see [AI Provider Configuration](#ai-provider-configuration) below.

### Environment Variables

pair-review supports several environment variables for customizing behavior:

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token (takes precedence over config file) | - |
| `PAIR_REVIEW_CLAUDE_CMD` | Custom command to invoke Claude CLI | `claude` |
| `PAIR_REVIEW_GEMINI_CMD` | Custom command to invoke Gemini CLI | `gemini` |
| `PAIR_REVIEW_CODEX_CMD` | Custom command to invoke Codex CLI | `codex` |
| `PAIR_REVIEW_COPILOT_CMD` | Custom command to invoke Copilot CLI | `copilot` |
| `PAIR_REVIEW_OPENCODE_CMD` | Custom command to invoke OpenCode CLI | `opencode` |
| `PAIR_REVIEW_CURSOR_AGENT_CMD` | Custom command to invoke Cursor Agent CLI | `agent` |
| `PAIR_REVIEW_MODEL` | Override the AI model to use (same as `--model` flag) | Provider default |

**Note:** `GITHUB_TOKEN` is the standard environment variable used by many GitHub tools (gh CLI, GitHub Actions, etc.). When set, it takes precedence over the `github_token` field in the config file.

**Note:** The `--model` CLI flag is shorthand for setting `PAIR_REVIEW_MODEL`. If both are specified, the CLI flag takes precedence.

These variables are useful when:
- Your CLI tools are installed in a non-standard location
- You need to use a wrapper script or custom binary
- You want to force a specific model for all reviews

**Examples:**

```bash
# Use GitHub token from environment variable (CI/CD friendly)
GITHUB_TOKEN="ghp_xxxx" pair-review 123

# Use a custom path for Claude CLI
PAIR_REVIEW_CLAUDE_CMD="/usr/local/bin/claude" pair-review 123

# Use a wrapper command (supports multi-word commands)
PAIR_REVIEW_CLAUDE_CMD="devx claude" pair-review 123

# Use Gemini with npx
PAIR_REVIEW_GEMINI_CMD="npx gemini" pair-review --local

# Force a specific model for this review
PAIR_REVIEW_MODEL="opus" pair-review 123

# Combine multiple settings
PAIR_REVIEW_CLAUDE_CMD="/opt/claude/bin/claude" PAIR_REVIEW_MODEL="haiku" pair-review 123
```

**Note:** Multi-word commands (containing spaces) are supported. The application automatically handles these by using shell mode for execution.

### GitHub Token

Create a Personal Access Token (PAT) with these scopes:
- `repo` (full control of private repositories)
- `read:org` (if reviewing organization repos)

[Create token on GitHub](https://github.com/settings/tokens/new)

### AI Provider Configuration

pair-review integrates with AI providers via their CLI tools:

- **Claude**: Uses Claude Code CLI
- **Gemini**: Uses Gemini CLI
- **Codex**: Uses Codex CLI
- **GitHub Copilot**: Uses Copilot CLI
- **OpenCode**: Uses OpenCode CLI (requires model configuration)
- **Cursor**: Uses Cursor Agent CLI (streaming output with sandbox mode)

You can select your preferred provider and model in the repository settings UI.

#### Built-in vs. Configurable Providers

Most providers (Claude, Gemini, Codex, Copilot) come with built-in model definitions. **OpenCode is different** - it has no built-in models and requires you to configure which models to use.

#### Configuring Custom Models

You can override provider settings and define custom models in your config file. This is useful for:
- Adding models to OpenCode (required)
- Overriding default commands or arguments
- Setting provider-specific environment variables

**Full provider configuration example:**

```json
{
  "github_token": "ghp_your_token_here",
  "default_provider": "opencode",
  "default_model": "anthropic/claude-sonnet-4",
  "providers": {
    "opencode": {
      "command": "opencode",
      "extra_args": ["--verbose"],
      "env": { "OPENCODE_TELEMETRY": "off" },
      "models": [
        {
          "id": "anthropic/claude-sonnet-4",
          "tier": "balanced",
          "default": true,
          "name": "Claude Sonnet 4",
          "description": "Fast and capable for most reviews",
          "tagline": "Best balance of speed and quality"
        },
        {
          "id": "anthropic/claude-opus-4",
          "tier": "premium",
          "name": "Claude Opus 4",
          "description": "Most capable model for complex reviews"
        },
        {
          "id": "openai/gpt-4.1",
          "tier": "thorough",
          "name": "GPT-4.1",
          "description": "OpenAI's latest model"
        }
      ]
    }
  }
}
```

#### Provider Configuration Fields

| Field | Description |
|-------|-------------|
| `command` | CLI command to execute (overrides default and environment variable) |
| `extra_args` | Additional arguments to pass to the CLI |
| `env` | Environment variables to set when running the CLI |
| `installInstructions` | Custom installation instructions shown in UI |
| `models` | Array of model definitions (see below) |

#### Model Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Model identifier passed to the CLI |
| `tier` | Yes | One of: `fast`, `balanced`, `thorough` (aliases: `free`→`fast`, `premium`→`thorough`) |
| `name` | No | Display name in the UI |
| `description` | No | Longer description of the model |
| `tagline` | No | Short description shown in model picker |
| `badge` | No | Badge text (e.g., "NEW", "BETA") |
| `badgeClass` | No | CSS class for badge styling |
| `default` | No | Set to `true` to make this the default model for the provider |
| `extra_args` | No | Model-specific CLI arguments |
| `env` | No | Model-specific environment variables |

#### Model Tiers

Models are grouped by tier to help users choose appropriately:

- **fast**: Quick analysis, lower cost, good for simple reviews
- **balanced**: Best mix of speed and quality (recommended)
- **thorough**: Most comprehensive analysis, higher cost

Aliases are available for convenience: `free` (maps to `fast`), `premium` (maps to `thorough`).

#### Command Precedence

The CLI command used for a provider follows this precedence (highest to lowest):

1. Environment variable (e.g., `PAIR_REVIEW_OPENCODE_CMD`)
2. Config file `providers.<provider>.command`
3. Built-in default

#### Migration Notes

If you have an older config file using `provider` and `model` keys at the top level, they are automatically treated as `default_provider` and `default_model`. No migration is required.

## Features

### Three-Level AI Analysis

pair-review's AI analysis system examines your code changes at increasing levels of context:

- **Level 1 - Isolation**: Analyzes only the changed lines for bugs and issues
- **Level 2 - File Context**: Checks consistency within the entire file
- **Level 3 - Codebase Context**: Validates architectural patterns across the codebase

This progressive approach keeps analysis focused while catching issues at every scope.

### Customization

Tailor AI analysis to your team's standards and your current needs:

- **Repo-level instructions**: Always included when generating suggestions for a specific repo. Point to codebase best practices docs, highlight common review mistakes, or include other helpful resources. Reviews will actively cite this guidance when relevant.
- **Review-level instructions**: Customize individual reviews on the fly. Request deeper analysis with detailed code suggestions, ask for a "blockers only" final review, or adjust the focus for a particular set of changes.

There's a compounding benefit: if you run `pair-review` with the same coding agent you use for development — one already configured with your rules and instructions — it will actively search for violations and enforce them. The review reflects your standards, not generic best practices.

### Review Feedback Export

The killer feature for AI coding agent workflows:

1. Add comments during your review (manual or AI-assisted)
2. Click "Preview Review" to see formatted markdown
3. Copy the markdown
4. Paste into your coding agent's chat
5. Agent iterates based on your feedback

The markdown includes file paths, line numbers, and your comments - everything the agent needs to understand and act on your feedback.

### Inline Comments

- Add comments directly on specific lines
- See all comments in context with the diff
- Edit or discard AI suggestions before finalizing
- Comments include file and line number for precision

### Local Mode

Review **unstaged**, uncommitted changes before creating a PR:

```bash
pair-review --local
```

Perfect for:
- Self-review before committing
- Getting AI feedback on work-in-progress
- Iterating with a coding agent on local changes
- Reviewing only the unstaged files that are still changing
- Staging the files you've already reviewed and viewing the next round of changes

## Claude Code Plugins

pair-review provides two [Claude Code plugins](https://code.claude.com/docs/en/plugins) that bring AI-powered code review directly into Claude Code.

### code-critic — Standalone Analysis

AI-powered code review analysis that works without any server or MCP dependency. Install this plugin for three-level AI analysis and implement-review-fix loops directly in your coding agent.

**Install via Marketplace:**

```
/plugin marketplace add in-the-loop-labs/pair-review
/plugin install pair-review@code-critic
```

**Available Skills:**

| Skill | Description |
|-------|-------------|
| `/code-critic:analyze` | Run three-level AI analysis using Task agents directly (standalone, no server needed) |
| `/code-critic:loop` | Implement code, review with AI, fix issues, and repeat until clean |

These skills work standalone. If the pair-review MCP server happens to be available (from the pair-review plugin), `code-critic:analyze` will use it for prompts and push results to the web UI — but it's entirely optional.

### pair-review — App Integration

Full integration with the pair-review web UI via MCP. Install this plugin to open reviews in the browser, run server-side AI analysis, and address review feedback.

**Install via Marketplace:**

```
/plugin marketplace add in-the-loop-labs/pair-review
/plugin install pair-review@pair-review
```

**Available Skills:**

| Skill | Description |
|-------|-------------|
| `/pair-review:pr` | Open the current branch's GitHub PR in the pair-review web UI |
| `/pair-review:local` | Open local uncommitted changes in the pair-review web UI |
| `/pair-review:analyze` | Run AI analysis via the pair-review MCP server (results appear in web UI) |
| `/pair-review:user-critic` | Fetch and address human review comments from pair-review |
| `/pair-review:ai-critic` | Fetch and address AI-generated suggestions from pair-review |

This plugin includes the pair-review MCP server, which starts automatically when the plugin is enabled.

### Alternative: Load Plugins Locally

If you prefer not to use the marketplace, load plugins directly from an npm-installed or cloned copy:

```bash
# From a local clone
claude --plugin-dir ./path/to/pair-review/plugin-code-critic
claude --plugin-dir ./path/to/pair-review/plugin

# From a globally installed npm package
claude --plugin-dir "$(npm root -g)/@in-the-loop-labs/pair-review/plugin-code-critic"
claude --plugin-dir "$(npm root -g)/@in-the-loop-labs/pair-review/plugin"
```

### Team Setup

To pre-configure plugins for all contributors on a repository, add this to your `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "pair-review": {
      "source": {
        "source": "github",
        "repo": "in-the-loop-labs/pair-review"
      }
    }
  },
  "enabledPlugins": {
    "pair-review@code-critic": true,
    "pair-review@pair-review": true
  }
}
```

Team members will be prompted to install the marketplace and plugins when they trust the repository folder.

## MCP Integration

pair-review exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) interface, allowing AI coding agents to programmatically read review feedback. The MCP server is included automatically when you install the pair-review Claude Code plugin. For standalone MCP setup (without the plugin), see [Standalone MCP Setup](#standalone-mcp-setup-without-plugin) below.

### Transport Modes

**stdio (recommended)** — run pair-review as a stdio MCP server. The agent communicates via stdin/stdout JSON-RPC while the web UI launches on a local port for the human reviewer:

```bash
npx @in-the-loop-labs/pair-review --mcp
```

**HTTP** — the Streamable HTTP endpoint at `http://localhost:7247/mcp` (stateless mode) is available whenever the pair-review web server is running.

### Available Tools

| Tool | Description | Availability |
|------|-------------|--------------|
| `get_server_info` | Get pair-review server info including web UI URL and version | stdio only |
| `get_analysis_prompt` | Get rendered analysis prompts for a review level and tier | stdio + HTTP |
| `get_user_comments` | Get human-curated review comments (authored or adopted), grouped by file | stdio + HTTP |
| `get_ai_analysis_runs` | List all AI analysis runs for a review | stdio + HTTP |
| `get_ai_suggestions` | Get AI-generated suggestions from the latest analysis run, or from a specific run via `runId` | stdio + HTTP |
| `start_analysis` | Start an AI analysis in the app for local or PR changes | stdio + HTTP |

All review tools accept lookup parameters:
- **Local reviews**: `path` + `headSha`
- **PR reviews**: `repo` (e.g. `"owner/repo"`) + `prNumber`

`get_ai_suggestions` also accepts an optional `runId` to target a specific analysis run (discovered via `get_ai_analysis_runs`), bypassing the need for review lookup parameters.

### Standalone MCP Setup (Without Plugin)

If you want just the MCP tools without the full plugin (no skills), you can add the MCP server directly to any coding agent that supports MCP (Claude Code, Cursor, Windsurf, etc.).

#### Generic MCP Configuration

**stdio transport (recommended)** — run pair-review as a child process. The agent communicates via stdin/stdout JSON-RPC:

- **Command:** `npx @in-the-loop-labs/pair-review --mcp`
- **Environment variables:** Set `GITHUB_TOKEN` if you want PR review support (not needed for local-only reviews). GitHub token will also be read from `~/.pair-review/config.json` if configured.

**HTTP transport** — connect to a running pair-review instance:

- **URL:** `http://localhost:7247/mcp` (stateless Streamable HTTP)
- Start the server first with `npx @in-the-loop-labs/pair-review` or by opening a PR review, then point your agent at the HTTP endpoint.

You can also copy the `plugin/.mcp.json` file from this package into your project for agents that support `.mcp.json` discovery.

#### Claude Code Specific

Add the MCP server via the Claude Code CLI:

**stdio transport (recommended):**

```bash
claude mcp add pair-review -- npx @in-the-loop-labs/pair-review --mcp
```

**HTTP transport:**

```bash
claude mcp add --transport http pair-review http://localhost:7247/mcp
```

These commands update your MCP configuration in `~/.claude/settings.json` (user-level) or your project's `.claude/settings.json` (project-level).

## Development

### Prerequisites

- Node.js 20.0.0 or higher
- Git

### Running Locally

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run E2E tests
npm run test:e2e

# Run E2E tests with visible browser
npm run test:e2e:headed

# Start development server
npm run dev
```

### Architecture

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JavaScript (no framework)
- **Database**: SQLite for local storage
- **AI Integration**: CLI-based adapter pattern for multiple providers
- **Git**: Uses git worktrees for clean PR checkout

## FAQ

**Q: Does my code get sent to the cloud?**
A: Not by pair-review. Pair-review keeps all its data locally. AI providers that you use for review may communicate with their servers.

**Q: Do I need to use AI analysis?**
A: No. pair-review works great as a local review UI without AI. Trigger analysis only when you want it.

**Q: Which AI provider should I use?**
A: Any that you have configured locally. Claude excels at code review, but try different providers to see what works best for you.

**Q: Can I use this for non-GitHub repos?**
A: Local mode (`--local`) works with any git repository. PR review mode requires GitHub.

**Q: How do I give feedback to a coding agent?**
A: Add comments during review, click "Preview Review", copy the markdown, and paste it into your coding agent's chat interface.

**Q: Something isn't working right. What should I try first?**
A: Try refreshing your browser. Many transient issues resolve with a simple page refresh.

**Q: How do I use OpenCode as my AI provider?**
A: OpenCode has no built-in models, so you must configure them in your `~/.pair-review/config.json`. Add a `providers.opencode.models` array with at least one model definition. See the [AI Provider Configuration](#ai-provider-configuration) section for a complete example.

## Contributing

Contributions welcome! Please:

1. Check existing issues or create a new one
2. Fork the repository
3. Create a feature branch
4. Write tests for changes, especially bug fixes
5. Submit a pull request

## License

GPL-3.0 License - see LICENSE file for details

---

**Start reviewing better code today:**

```bash
npx @in-the-loop-labs/pair-review <PR-number-or-URL or --local>
```
