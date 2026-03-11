# Remote Environment Mode — TODO

## Open Issues

### git-diff-lines script not available on remote
The AI agent is instructed to use `git-diff-lines` (distributed in `plugin-code-critic/skills/analyze/scripts/`) for line-annotated diffs. In remote mode, this script doesn't exist on the River container. The existing SSH ControlMaster connection could be used to SCP it over during setup.

### Provider availability check is local-only
The provider availability check runs locally at server start. For remote repos, the provider (e.g., pi) may only be available on the remote. Currently this means pi might show as "unavailable" in the UI even though it works fine for remote analysis.

### Setup page UX during long connects
The initial River connection can take several seconds. The setup page shows progress but the "Connecting to remote environment" step could benefit from more granular feedback (e.g., "Authenticating...", "Establishing tunnel...", "Verifying connection...").

### Concurrent PR reviews create separate River sessions
Each PR gets its own River session (container). This provides isolation but is resource-heavy. Consider whether multiple PRs could share a single session with per-PR worktrees or branches.

### File content endpoint not remote-aware
`GET /api/pr/:owner/:repo/:number/file/:path` reads files from the local filesystem. In remote mode this would need to read via `remoteShell.exec('cat ...')` or `git show`.

### .gitattributes / generated file detection
Generated file detection reads `.gitattributes` locally. Not functional in remote mode — fails silently (acceptable for MVP).
