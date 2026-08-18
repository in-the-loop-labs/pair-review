---
"@in-the-loop-labs/pair-review": patch
---

Councils that store a legacy model alias — `opus`, `fable`, `opus-4.5`, `gpt-5.4`, `gemini-3.5-flash`, `muse-spark` — no longer lose reviewers when they are saved again. Loading such a council into either council editor left its model dropdown on no selection at all (the dropdown offers canonical ids; the alias matched none of them), and the next Save silently dropped that reviewer from the council: no error, and a success message. The editors now resolve aliases to the canonical model the same way analysis does, and refuse to blank a dropdown when a stored model cannot be resolved at all, keeping the valid default instead.

The council composition preview now escapes its level summary, the one field in that card that was interpolated raw.
