# GitHub Action Review Mode - Design Document

## Status: Implemented

This document describes the GitHub Action review mode for pair-review.

## Overview

Enable pair-review to run as a GitHub Action, performing AI code review and submitting comments directly to pull requests. This builds on the existing `--ai-draft` mode but adapts it for CI/CD environments.

## Goals

1. **Phase 1**: Create a workflow for reviewing pair-review itself ✅
2. **Phase 2**: Extract into a reusable GitHub Action for any repository (future)

## Key Differences from Interactive Mode

| Aspect | Interactive (`--ai`) | Draft (`--ai-draft`) | Action (`--ai-review`) |
|--------|---------------------|---------------------|----------------------|
| Worktree | Creates new | Creates new | Uses current checkout |
| Database | Persistent | Persistent | Ephemeral (temp) |
| Review Type | Human submits | DRAFT (pending) | COMMENT (submitted) |
| Browser | Opens | None | None |
| PR Detection | CLI argument | CLI argument | Auto from env |
| Exit Code | 0 | 0 or 1 | 0, 1, or 2 (configurable) |

## Proposed CLI Interface

### New Flags

```bash
# Submit review immediately (not draft)
pair-review 123 --ai-review

# Use current checkout instead of creating worktree
pair-review 123 --ai-review --use-checkout

# Auto-detect PR from GitHub Actions environment
pair-review --ai-review --use-checkout --github-action

# Exit with code 2 if issues found (for CI fail-on-issues)
pair-review --ai-review --fail-on-issues
```

### Environment Variable Auto-Detection

When `GITHUB_ACTIONS=true`, automatically:
- Infer `owner/repo` from `GITHUB_REPOSITORY`
- Infer PR number from `GITHUB_REF` (format: `refs/pull/{number}/merge`)
- Or parse PR number from `$GITHUB_EVENT_PATH` JSON payload
- Use `GITHUB_TOKEN` for authentication
- Enable `--use-checkout` behavior

### Proposed Flag Summary

| Flag | Description | Default |
|------|-------------|---------|
| `--ai-review` | Run AI analysis and submit as COMMENT review | - |
| `--use-checkout` | Use current directory instead of creating worktree | Auto in GA |
| `--github-action` | Enable all GitHub Action optimizations | Auto-detected |
| `--fail-on-issues` | Exit code 2 if any issues found | false |
| `--output-json` | Output structured JSON summary | false |

## Implementation Changes

### 1. New Handler: `handleActionReview()`

Create a new handler (or refactor `handleDraftModeReview`) for action mode:

```javascript
async function handleActionReview(args, config, db, flags) {
  // Detect GitHub Actions environment
  const isGitHubAction = process.env.GITHUB_ACTIONS === 'true' || flags.githubAction;

  // Auto-detect PR info in GitHub Actions
  let prInfo;
  if (isGitHubAction && args.length === 0) {
    prInfo = await detectPRFromGitHubEnvironment();
  } else {
    prInfo = await parser.parsePRArguments(args);
  }

  // Use current checkout if requested or in GitHub Actions
  const useCheckout = flags.useCheckout || isGitHubAction;
  let worktreePath;

  if (useCheckout) {
    worktreePath = process.cwd();
    // Generate diff directly against base SHA
  } else {
    // Existing worktree creation logic
    worktreePath = await worktreeManager.createWorktreeForPR(...);
  }

  // ... rest of analysis ...

  // Submit as COMMENT instead of DRAFT
  const reviewEvent = flags.submit ? 'COMMENT' : 'DRAFT';

  // Exit with appropriate code
  if (flags.failOnIssues && suggestionCount > 0) {
    process.exit(2);
  }
}
```

### 2. Diff Generation Without Worktree

When using current checkout, generate diff by comparing against base SHA:

```javascript
async function generateDiffFromCheckout(baseSha, headSha) {
  // Fetch base branch to ensure we have the commits
  await exec(`git fetch origin ${baseSha}`);

  // Generate unified diff
  const { stdout } = await exec(`git diff ${baseSha}...${headSha}`);
  return stdout;
}
```

### 3. Ephemeral Database

For CI, use an in-memory or temp file database:

```javascript
if (isGitHubAction) {
  const tempDbPath = path.join(os.tmpdir(), `pair-review-${Date.now()}.db`);
  db = await initializeDatabase(tempDbPath);
  // Auto-cleanup on exit
}
```

### 4. PR Detection from GitHub Environment

```javascript
async function detectPRFromGitHubEnvironment() {
  // Method 1: Parse GITHUB_REF
  const ref = process.env.GITHUB_REF; // refs/pull/123/merge
  const prMatch = ref?.match(/refs\/pull\/(\d+)\//);

  // Method 2: Read event payload
  if (!prMatch && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH));
    const prNumber = event.pull_request?.number;
    // ...
  }

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

  return { owner, repo, number: parseInt(prNumber) };
}
```

### 5. Structured Output

```javascript
const output = {
  pr: {
    number: prInfo.number,
    url: `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`,
  },
  analysis: {
    total_comments: suggestions.length,
    by_category: categoryCounts,
    by_level: levelCounts,
  },
  review: {
    id: githubReview.id,
    url: githubReview.html_url,
    event: reviewEvent,
    comments_submitted: githubReview.comments_count,
  },
};

if (flags.outputJson) {
  console.log(JSON.stringify(output, null, 2));
}
```

## Phase 1: GitHub Workflow for pair-review

Create `.github/workflows/ai-review.yml`:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-review:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for diff generation
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Fetch base branch
        run: git fetch origin ${{ github.event.pull_request.base.sha }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Setup Claude CLI
        run: |
          # Install Claude CLI (method TBD based on availability)
          # Option 1: npm package
          npm install -g @anthropic-ai/claude-code
          # Option 2: Download binary
          # curl -fsSL https://... | sh

      - name: Run AI Review
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx pair-review --ai-review --use-checkout --output-json
```

### Environment Variables Needed

| Variable | Source | Purpose |
|----------|--------|---------|
| `GITHUB_TOKEN` | Auto-provided by GA | GitHub API auth |
| `ANTHROPIC_API_KEY` | Repository secret | Claude API auth |
| `GITHUB_REPOSITORY` | Auto-provided | owner/repo |
| `GITHUB_REF` | Auto-provided | PR ref |
| `GITHUB_EVENT_PATH` | Auto-provided | Event payload location |

## Phase 2: Reusable Action

Extract into a composite action or Docker-based action:

### Option A: Composite Action

```yaml
# action.yml
name: 'Pair Review'
description: 'AI-powered code review assistant'

inputs:
  github-token:
    description: 'GitHub token for API access'
    required: true
  anthropic-api-key:
    description: 'Anthropic API key for Claude'
    required: true
  model:
    description: 'AI model to use (haiku, sonnet, opus)'
    default: 'sonnet'
  fail-on-issues:
    description: 'Fail workflow if issues found'
    default: 'false'

runs:
  using: 'composite'
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '22'

    - name: Install pair-review
      shell: bash
      run: npm install -g pair-review

    - name: Run review
      shell: bash
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
      run: |
        pair-review --ai-review \
          --model ${{ inputs.model }} \
          ${{ inputs.fail-on-issues == 'true' && '--fail-on-issues' || '' }}
```

### Option B: Docker Action (More Isolated)

```dockerfile
FROM node:22-slim

RUN npm install -g pair-review @anthropic-ai/claude-code

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

## Open Questions

1. **Claude CLI in CI**: How do we provision Claude CLI in GitHub Actions?
   - Is there an npm package?
   - Binary download?
   - Does it require a specific auth flow?

2. **Rate Limiting**: Should we add rate limiting protection for large PRs?

3. **Diff Size Limits**: Maximum diff size before truncating or skipping analysis?

4. **Comment Deduplication**: If the action runs multiple times, how do we avoid duplicate comments?
   - Option: Delete previous pair-review comments before posting new ones
   - Option: Update existing comments in place
   - Option: Only comment on changed hunks since last review

5. **Approval Logic**: Should the action ever auto-approve PRs?
   - Conservative: Always use COMMENT, never APPROVE
   - Configurable: Allow APPROVE if no issues found

## Implementation Order

1. Add `--use-checkout` flag to skip worktree creation
2. Add `--ai-review` flag for COMMENT (not DRAFT) submission
3. Add GitHub Actions environment auto-detection
4. Add `--output-json` flag for structured output
5. Add `--fail-on-issues` flag for CI failure on issues
6. Create workflow file for pair-review itself
7. Test and iterate
8. Extract into reusable action

## Security Considerations

1. **Token Permissions**: Workflow uses `pull-requests: write` permission only
2. **Secret Handling**: `ANTHROPIC_API_KEY` stored as repository secret
3. **AI Tool Restrictions**: Claude provider already restricts to read-only operations
4. **Fork PRs**: Consider whether to run on PRs from forks (security risk)
