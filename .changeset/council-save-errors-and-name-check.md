---
"@in-the-loop-labs/pair-review": patch
---

Saving a council now tells you what actually went wrong, and stops you a step earlier.

- **Failures show the server's reason.** Save, Save As and Delete reported a flat "Failed to save council" / "Failed to delete council" no matter the cause. They now surface the message the API sent — a name conflict, a rejected config, a validation error — falling back to the generic wording only when the response carries no message at all.
- **The reviewer check counts reviewers that will actually be saved.** A reviewer row whose provider or model is unset is dropped from the saved configuration, so a Council whose provider is no longer available could pass the old row-counting check and then be rejected by the server. The check now reads the configuration being sent and says "Add at least one reviewer with both a provider and a model selected." Advanced configurations gained the matching per-level check ("Level 2 needs at least one reviewer with both a provider and a model selected."), which the server already enforced but the editor let through.
- **Council names must now be unique across both types.** Save As only compared against councils of the same type, so a Standard "Dream Team" could be created alongside an Advanced "Dream Team". That breaks `--council "Dream Team"` for *both* of them — the handle is ambiguous and only the raw id still resolves. The name scan now covers every council, of either type.
- **Fixed: a new council seeded from an alias could not be saved.** Starting a review with an aliased model (`pair-review <pr> --model opus`, or a stored default that is an alias) seeded the reviewer row with a value the model dropdown does not carry, so nothing was selected, the reviewer was dropped, and Save As failed with "config.voices must be a non-empty array". The alias is now resolved to the model the dropdown actually offers. The same fix covers a seeded provider that reports no models or is unavailable.
