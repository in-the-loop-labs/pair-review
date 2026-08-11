---
"@in-the-loop-labs/pair-review": patch
---

Fix council save/run validation parity: saving a council now validates the same
normalized config the analyzer actually runs. Previously the create and update
endpoints validated the raw request body while every runtime path normalized
first, so a council the analyzer would happily execute could be rejected at save
time — most visibly when changing a council's type to voice-centric without
sending a new config. The config is still stored exactly as sent.
