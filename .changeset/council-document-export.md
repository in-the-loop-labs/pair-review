---
"@in-the-loop-labs/pair-review": minor
---

Council export now produces a versioned, named document and downloads a file. The Export button on both the Council and Advanced tabs writes `<council-name>.council.json` — a document carrying the format version, name, type, and config — where the previous export copied the bare config to the clipboard with no name, type, or version, so it could never be read back.

The same JSON is still copied to the clipboard, but the toast now tells the truth about it: "Council exported and copied to clipboard" only when the clipboard actually took it, and "Council exported" when the browser denied the copy or offers no clipboard. A denied copy never fails the download.

Export is also gated on the same validation Save As uses. An invalid council — no enabled levels, or no reviewers — can no longer be exported into a document the app would refuse to read back: the Export button is disabled while the config is invalid, and the validator's own message is shown if the export is triggered anyway.
