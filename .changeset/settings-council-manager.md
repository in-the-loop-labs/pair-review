---
"@in-the-loop-labs/pair-review": minor
---

Councils can now be managed outside a review. The global settings page (`/settings`) has a new **Councils** section listing every council — saved ones and the read-only `~/.pair-review/councils/` file overlay — with create, edit, duplicate, export and delete. Previously a council could only be built or changed from the analysis dialog of a review you already had open.

Adding a council starts with a type choice (Council or Advanced) and then drops you into the same tab editors the analysis dialog uses, so everything they support is available here too: per-reviewer provider/model, tier, timeout and instructions, level selection, and the consolidation model. Clicking a row expands the same composition preview the repository settings page shows, and any change made in the section immediately refreshes the page's own "Default for Analysis" picker.

File councils stay read-only in the UI, as they are everywhere else. They carry a File badge (hover it for the path) and offer only Duplicate — which forks them into an editable saved copy — and Export. Export writes the versioned `.council.json` document, which can be dropped straight back into `~/.pair-review/councils/`; to change a file council in place, edit the file and restart pair-review.

Deleting a chat snippet from the settings page now asks with the app's styled confirmation dialog rather than the browser's native one — the settings page loads that dialog for the first time alongside the new section.
