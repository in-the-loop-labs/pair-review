---
"@in-the-loop-labs/pair-review": patch
---

Fix a spurious "N comments lost their anchor" toast when loading a review on an alternate Git host ("alt-host"). Alt-hosts don't implement GitHub's deprecated diff-relative `position` field — they return external review comments with `position: null` but a valid modern `line`. The external-comments sync mapper previously keyed "outdated" off `position`, discarding the good `line` and mis-flagging current comments as lost anchors, which dropped them from the mirror.

Comment anchoring is now host-aware. For alt-host repos (a binding with `api_host`), `mapComment` anchors by `line`: a comment with a non-null `line` is current (`is_outdated = 0`); only a null `line` marks it outdated (anchored via `original_*`). The github.com path is unchanged and remains position-based.
