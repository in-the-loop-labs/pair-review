---
"@in-the-loop-labs/pair-review": minor
---

Make the external code host's name, URL, and icon configurable for alt-host
repos, and use them consistently in the review UI.

- Add an optional `repos["owner/repo"].links.external.name` (e.g. `"Meteorite"`)
  that replaces the literal "GitHub" in user-facing text: the submit success
  toast, the pending-draft notice/indicator, and the "Save as Draft"
  description. Defaults to "GitHub" when unset.
- The post-draft-submit browser tab, the pending-draft "Manage" link, and the
  pending-draft indicator now open the URL built from the repo's configured
  `links.external.url_template` (host-correct) instead of the review's
  API-returned `html_url`, which some alt-hosts return as a wrong-host
  `github.com/.../issues/<n>` URL. No URL is ever fabricated as github.com.
- The configured `links.external.icon` is now also shown on the review-submit
  button.
- New `window.RepoLinks.hostName()` / `externalUrl()` / `externalIcon()`
  accessors and a server-side `resolveHostName()` helper expose the resolved
  host identity to the rest of the app.

Behaviour is unchanged for github.com repos with no `links.external` config.
