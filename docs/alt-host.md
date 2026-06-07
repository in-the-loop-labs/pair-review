# Alternate Git-Host Support

pair-review can review pull requests on self-hosted Git platforms that expose a
GitHub-compatible REST API. This guide explains how to configure pair-review
against such a host on a per-repository basis.

## When to Use This

Use alt-host configuration when you have repositories on a Git host that:

- Is **not** `github.com`.
- Exposes a GitHub-compatible REST API surface (e.g. `pulls.list`,
  `pulls.createReview`, `pulls.submitReview`).
- Does **not** implement GitHub's GraphQL API. (pair-review uses GraphQL by
  default against `github.com`; alt-hosts must use REST.)

If your repositories live on `github.com`, you do not need any of this — the
existing top-level `github_token` / `GITHUB_TOKEN` configuration continues to
work unchanged.

## Configuration Shape

All alt-host settings live under a per-repository entry in
`~/.pair-review/config.json`:

```jsonc
{
  "repos": {
    "owner/repo": {
      // Existing keys (path, worktree_directory, ...) still apply

      // REST API base URL for this host. When set, pair-review routes all
      // API traffic for this repo to this host instead of api.github.com.
      "api_host": "https://althost.example/api/v3",

      // Token resolution for this repo. Use exactly one of these.
      "token": "...",            // literal token
      "token_command": "...",    // shell command whose stdout is the token

      // Optional regex for matching pasted URLs to this repo entry.
      "url_pattern": "^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)",

      // Per-area dispatch mode (see "Feature Areas" below).
      "features": {
        "pending_review_check": "rest",
        "stack_walker": "rest",
        "review_lifecycle": "rest",
        "pending_review_comments": "host"
      },

      // Optional UI link customisation (see "UI Links" below).
      "links": {
        "external": {
          "label": "Open on AltHost",
          "url_template": "https://althost.example/{owner}/{repo}/pull/{number}",
          "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>"
        },
        "github": false,
        "graphite": false
      }
    }
  }
}
```

### `api_host`

The REST API base URL for the host, e.g. `https://althost.example/api/v3`.
When this key is present, pair-review treats the repository as an alt-host
repo and dispatches API calls accordingly.

When `api_host` is unset, the repo uses the default `github.com` behaviour
and all other alt-host keys are ignored.

### `token` / `token_command`

Per-repo authentication. Provide one of:

- **`token`** — a literal access token string.
- **`token_command`** — a shell command whose standard output is the token
  (e.g. `gh auth token`, `op read op://vault/item/token`).

When neither is set, pair-review falls back to the top-level `github_token`
/ `github_token_command` / `GITHUB_TOKEN` resolution.

Per-repo tokens are cached separately per host, so a `github.com` token will
never be sent to an alt-host (or vice versa).

### `url_pattern`

A regular expression used to recognise URLs pasted on the command line and
resolve them to this repo entry. Use named capture groups for the three
canonical identifiers:

- `(?<owner>...)` — the owner / organisation name.
- `(?<repo>...)` — the repository name.
- `(?<number>...)` — the pull request number.

Anchor the pattern with `^` so it matches a whole URL rather than a
substring. Example:

```jsonc
"url_pattern": "^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)"
```

When a URL pasted on the CLI matches this pattern, pair-review uses the
captured groups as the canonical identifiers and looks up the repo entry by
its key (`owner/repo`) — regardless of how the URL was actually written.

Invalid regexes are reported with a clear error at startup.

### `git_remote_pattern`

An optional escape-hatch regex for matching the git remote URL of a local
checkout to this repo entry. Without it, pair-review derives the expected
HTTPS and SSH remote URL shapes from `api_host` and the canonical
`owner/repo` config key — which works for hosts whose remote URLs follow
the standard `<host>/<owner>/<repo>(.git)?` layout. Use `git_remote_pattern`
for hosts that use a different remote URL layout (e.g. an extra
namespace segment, a path prefix, or a non-standard SSH form).

```jsonc
"git_remote_pattern": "^git@althost\\.example:scm/myteam/myproject(\\.git)?$"
```

The value is compiled as a JavaScript `RegExp` and tested against the git
remote URL with `RegExp#test`. If it matches, the canonical `owner/repo`
from the config key is used (named capture groups in this pattern are
ignored — the contract is "if the regex matches the remote URL, this
repo entry applies"). When set, it is tried BEFORE the derived
`api_host` patterns.

Invalid regexes are reported with a clear error at startup.

### `features`

Per-area dispatch mode. Each key selects how pair-review performs a given
operation for this repo. Allowed values:

- **`"graphql"`** — use GitHub's GraphQL API. Only valid when `api_host` is
  unset.
- **`"rest"`** — use GitHub's REST API. Available everywhere.
- **`"host"`** — use a host extension endpoint (see "Host Extensions"
  below). Only valid when `api_host` is set.

| Area | Default (no `api_host`) | Default (with `api_host`) | What it covers |
|---|---|---|---|
| `pending_review_check` | `graphql` | `rest` | Detecting an existing pending review for the current user. |
| `stack_walker` | `graphql` | `rest` | Walking parent/child PRs for stack-aware review. |
| `review_lifecycle` | `graphql` | `rest` | Creating, submitting, and deleting pending reviews. |
| `pending_review_comments` | `graphql` | `host` (see below) | Attaching inline comments to a pending review. |

You only need to specify areas where you want to override the default for
the host kind. Omitted areas use the defaults above.

#### `pending_review_comments` requires `"host"` on alt-hosts

GitHub's REST API has no reliable way to attach inline comments to a
*pending* (draft) review in a single call — the documented per-comment
endpoint does not consistently anchor to the draft. For alt-hosts, the only
supported value for `pending_review_comments` is `"host"`, which routes
through the host extension contract described below.

Setting `"rest"` here on an `api_host`-configured repo will fail at the
workflow boundary when a draft review with comments is created. Setting
`"graphql"` is rejected at startup.

#### `pending_review_comments_endpoint` (optional)

If your host implements the extension contract at a non-default path,
override it per repo:

```jsonc
"features": {
  "pending_review_comments": "host",
  "pending_review_comments_endpoint": "/custom/path/{owner}/{repo}/pull/{pull_number}/draft/{review_id}/comments"
}
```

The placeholders `{owner}`, `{repo}`, `{pull_number}` (PR number), and
`{review_id}` are substituted at request time. If omitted, the default
endpoint described in "Host Extensions" is used.

### `links`

Customise the link buttons shown in the review header.

- **`links.external`** — declare a new link with these fields:
  - `name` (optional) — display name of the host (e.g. `"Meteorite"`). Used
    in place of the literal "GitHub" in user-facing text: the review-submit
    success toast, the pending-draft notice and indicator, and the
    "Save as Draft" description. Defaults to `"GitHub"` when unset.
  - `label` (required) — display text for the header link button.
  - `url_template` (required) — URL with `{owner}`, `{repo}`, `{number}`,
    `{branch}`, `{base_branch}`, `{head_sha}` placeholders. The resolved
    URL must use `https://`. In addition to the header link, this template
    is the **authoritative source** for the URL opened after a draft submit
    and the pending-draft "Manage" / indicator links — preferred over the
    PR's API-returned `html_url`, which some hosts return on a different
    (or wrong) domain.
  - `icon` (optional) — inline SVG string for the button icon. Also shown on
    the review-submit button. Sanitised server-side (script tags, `on*`
    handlers, and `javascript:` URLs are stripped).
- **`links.github: false`** — hide the default "Open on GitHub" link.
- **`links.graphite: false`** — hide the Graphite stack link.

When `links` is unset, the default link set is preserved and all host-named
text reads "GitHub".

Note that the host's web URL frequently cannot be derived from `api_host`
(the API host, web host, and the host returned in PR `html_url` values may
be three different domains), which is why `url_template` exists and is used
for every host-facing link.

## Host Extensions

Some operations cannot be expressed in GitHub's REST surface (most notably,
attaching inline comments to a pending review in a single request). For
these, pair-review supports a documented extension contract that an
alt-host can implement.

### Pending-review comments contract

> `POST {api_host}/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments`
>
> Request body:
>
> ```json
> { "comments": [ ... ] }
> ```
>
> Appends one or more inline comments to the pending (draft) review
> identified by `{review_id}`. Each entry in `comments` follows the same
> shape as a single inline comment in GitHub's REST
> `pulls.createReviewComment` request body (`path`, `body`, `line`,
> `side`, `start_line`, `start_side`, etc.).

Hosts that implement this default contract work out-of-the-box with
`features.pending_review_comments: "host"`. Hosts that need a different
path can override it via `features.pending_review_comments_endpoint`.

Authentication uses the same `token` / `token_command` configured for the
repo. The request is sent via the same HTTP client used for every other
API call, against the configured `api_host` base URL.

## Worked Example

A complete configuration for a repo `myteam/myproject` hosted on
`althost.example`:

```jsonc
{
  "github_token": "ghp_token_for_github_com_repos",
  "port": 7247,
  "theme": "light",

  "repos": {
    "myteam/myproject": {
      "api_host": "https://althost.example/api/v3",
      "token_command": "althost-cli auth token",

      "url_pattern": "^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)",

      "features": {
        "pending_review_check": "rest",
        "stack_walker": "rest",
        "review_lifecycle": "rest",
        "pending_review_comments": "host"
      },

      "links": {
        "external": {
          "label": "Open on AltHost",
          "url_template": "https://althost.example/{owner}/{repo}/pull/{number}"
        },
        "github": false,
        "graphite": false
      }
    }
  }
}
```

With this configuration:

- Running `pair-review https://althost.example/myteam/myproject/pull/42`
  resolves to `myteam/myproject` via `url_pattern` and routes API traffic
  to `https://althost.example/api/v3`.
- The auth token is obtained by running `althost-cli auth token` and
  cached per-host.
- All GitHub operations use REST, except draft-review comments which use
  the host extension.
- The review header shows an "Open on AltHost" link and hides the default
  GitHub and Graphite links.
- Other repos in `~/.pair-review/config.json` — including any on
  `github.com` — continue to use the top-level `github_token` and the
  default GraphQL-preferred behaviour.

## Troubleshooting

pair-review validates the alt-host configuration at startup and fails
loudly with actionable errors. Common failures:

### `api_host is set but feature "<area>" requests "graphql"`

The alt-host has no GraphQL endpoint. Change the offending `features.<area>`
entry to `"rest"` (or `"host"` where applicable), or remove it to take
the default.

### `feature "<area>" requests "host" but api_host is unset`

Host extensions only make sense against a configured `api_host`. Either
set `api_host` for this repo or remove the `"host"` value.

### `Invalid regex in repos["<repo>"].url_pattern`

The `url_pattern` value could not be compiled as a regular expression.
Check the pattern syntax — common issues include unescaped backslashes in
JSON (use `\\` for a literal `\` inside a JSON string) and missing
closing brackets.

### `pending_review_comments must be "host" when api_host is set` (runtime)

A workflow tried to attach inline comments to a draft review on an
alt-host but `features.pending_review_comments` is set to `"rest"`. Set
it to `"host"` and ensure your alt-host implements the extension
contract.

### Inline comments do not appear on the draft review

Verify that your host implements the documented extension contract (or
override `features.pending_review_comments_endpoint`). Check the
pair-review server log — failed extension calls are logged with the full
request path and the host's response.

### URL pasted on CLI is not recognised

Confirm that your `url_pattern` is anchored with `^` and that all three
named capture groups (`owner`, `repo`, `number`) are present. Test the
pattern in your editor's regex tool against a known PR URL.
