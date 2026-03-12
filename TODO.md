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

### Per-repo provider configuration for remote environments
The provider availability check and UI model picker are global — they show what's installed locally. For remote repos, different providers may be available (e.g., pi on River but not locally). Need a way to declare available providers per-repo, something like `remote_env.providers: ["pi"]`. This intersects with a broader question: `remote_env` is currently connection plumbing, but what's really needed is per-repo context — providers, tools, paths, availability. The config is doing double duty and the local vs remote split is getting complicated. May need a rethink of how repo-specific config works overall.

### Replace river-pr-connect script with `river attach --control-socket`
The `~/.local/bin/river-pr-connect` bash script (~80 lines) replicates most of what `river attach` already does (ADC auth, broker API, cert writing, SSH with ProxyCommand) — just in background/ControlMaster mode instead of interactive. This should be a small extension of the `river` CLI itself:

```
river attach SESSION --control-socket /path/to/sock [--reverse-port 7247]
```

Implementation in `//areas/tools/river/src/main.rs`:
- Add `--control-socket <PATH>` flag to `Cmd::Attach` (and optionally `Cmd::Up`)
- Add `--reverse-port <PORT>` flag for SSH reverse tunnel (`-R port:localhost:port`)
- When `--control-socket` is set: use `ssh -fNM -S <socket>` instead of `exec ssh`
- Add idempotent check: if socket exists and `ssh -S <socket> -O check` succeeds, exit 0
- Redirect stdout/stderr to /dev/null so the backgrounded SSH doesn't hold FDs (Node's exec waits on FD close)

The pair-review config would simplify from:
```json
"connect_command": "RIVER_SESSION={user}-pr-{pr_number} RIVER_REVERSE_PORT={port} ~/.local/bin/river-pr-connect {socket_path}"
```
To:
```json
"connect_command": "river attach {user}-pr-{pr_number} --control-socket {socket_path} --reverse-port {port}"
```

Eliminates the glue script entirely. The `disconnect_command` stays the same (`ssh -S {socket_path} -O exit river@tunnel`).

### Index page should list from pr_metadata, not worktrees
The index page (`/api/worktrees/recent`) uses the `worktrees` table as source of truth for "what PRs exist". This is an implementation detail that leaks into the UI — remote PRs have no worktree record and required a graft to appear. The proper fix: list from `pr_metadata` (or `reviews`), include storage status as a property (local worktree, remote, orphaned), and let the delete endpoint clean up all associated data (worktree dir, DB records, etc.) based on what actually exists. This isn't remote-specific — it's a general architectural improvement that remote mode exposes.
