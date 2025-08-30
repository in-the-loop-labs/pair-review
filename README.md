# pair-review

AI-powered GitHub pull request review assistant

## Quick Start

1. Install the package:
   ```bash
   npm install -g pair-review
   ```

2. Configure your GitHub token:
   ```bash
   npx pair-review --configure
   ```

3. Review a pull request:
   ```bash
   npx pair-review 123
   # or
   npx pair-review https://github.com/owner/repo/pull/123
   ```

## Features

- 🔍 Automatic PR fetching from GitHub
- 🌳 Git worktree management for isolated review
- 💾 Local database for review history
- 🎨 GitHub-style web interface
- 🤖 AI-powered review suggestions (coming soon)

## Requirements

- Node.js 14 or higher
- Git installed locally
- GitHub Personal Access Token

## Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Run tests
npm test
```

## License

MIT