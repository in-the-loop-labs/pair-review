---
"@in-the-loop-labs/pair-review": minor
---

Editing a posted comment can now update the existing GitHub comment in place, including comments in pending draft reviews. Missing comment identities are recovered only by an exact match; failed updates never create duplicate comments. The submit dialog can also update edited comments after submission. A PR-only review history shows original sent text and subsequent edits.

Discarded drafts remain non-pending until authoritative deletion provenance is available. Dismissing a posted comment remains local-only.
