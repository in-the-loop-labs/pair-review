# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2025-01-22

### Added

- Initial release of pair-review
- AI-powered code review assistance for GitHub pull requests
- Local mode for reviewing uncommitted changes
- Support for multiple AI providers: Claude CLI, Gemini CLI, OpenAI Codex
- GitHub-familiar diff view with inline comments
- Three-level AI analysis (isolation, file context, codebase context)
- SQLite database for local storage of reviews and drafts
- Dark and light theme support
- CLI commands: `pair-review <PR>` and `git-diff-lines`
