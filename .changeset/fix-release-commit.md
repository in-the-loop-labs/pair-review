---
"@in-the-loop-labs/pair-review": patch
---

Fix release script to commit all version-bumped files

The release script was staging plugin version files but never committing them,
leaving uncommitted changes after each release. This change disables changeset's
auto-commit and instead commits all version-related files (package.json,
package-lock.json, CHANGELOG.md, plugin manifests) in a single explicit commit.
