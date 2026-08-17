---
"@in-the-loop-labs/pair-review": patch
---

Councils created before councils had a type are now treated as **Advanced** everywhere. That is what they always were — their stored configuration is level-keyed, and the editors and the API have always read them as advanced — but the two places that label and preview a council disagreed with that.

What you will see change, for those legacy councils only:

- **Their type badge now reads "Advanced" where it read "Standard"** — in the council picker on the repository settings page, in "Default for Analysis" on the global settings page, and in the new Councils section. No configuration changed; only the label was wrong.
- **Their composition preview now lists their reviewers.** Both settings pages drew the standard (voice) layout for them, which cannot read a level-keyed configuration: you got an empty reviewer list under a meaningless level summary. They now render the per-level layout.

Councils saved with an explicit type are unaffected.
