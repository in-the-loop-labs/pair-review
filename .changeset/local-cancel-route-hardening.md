---
"@in-the-loop-labs/pair-review": patch
---

Cancelling a tour or summary in Local mode now returns a clean 500 error instead of hanging when the database is briefly unavailable. The Local-mode cancel route was the only async handler missing a try/catch, so a transient SQLite lock or a database-closed-during-shutdown rejection escaped Express and left the client waiting until it timed out.
