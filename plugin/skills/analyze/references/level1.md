# Level 1 — Analyze Changes in Isolation

This is a fast, focused pass on what changed. The primary focus should be the diff itself — but you may read files or explore context if it helps you understand what the diff is doing.

## Process

1. Run the `git-diff-lines` script (located in this skill's `scripts/` directory) to get an annotated diff with explicit OLD and NEW line numbers.
2. For each changed file, analyze the diff hunks. Read surrounding context if needed to understand the change.

## Focus areas

Look for these in the changed lines:

- **Bugs & logic errors**: Off-by-one, null handling, race conditions, incorrect comparisons
- **Security vulnerabilities**: Injection, XSS, hardcoded secrets, unsafe input handling
- **Performance issues**: N+1 queries, unnecessary allocations, missing early returns
- **Code style**: Naming inconsistencies, dead code, unclear logic
- **Design patterns**: Misuse of patterns, coupling issues visible in the diff
- **Praise**: Genuinely good patterns, clever solutions, thorough error handling

## Line references

- For added lines (`+`) and context lines, reference the **new file** line number.
- For deleted lines (`-`), reference the **old file** line number and set `side` to `"LEFT"`.
- Default `side` is `"RIGHT"` (new file).

## Output format

Return valid JSON only — no markdown, no commentary outside the JSON:

```json
{
  "level": 1,
  "suggestions": [
    {
      "file": "path/to/file",
      "line_start": 42,
      "line_end": 42,
      "side": "RIGHT",
      "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
      "title": "Brief title (under 80 chars)",
      "description": "Detailed explanation of the issue and why it matters",
      "suggestion": "How to fix (omit for praise)",
      "confidence": 0.8
    }
  ],
  "summary": "Brief summary of findings"
}
```

## Confidence calibration

- **0.8–1.0**: Clear, certain issues (definite bugs, obvious security holes)
- **0.5–0.79**: Likely issues with some uncertainty
- **Below 0.5**: Omit — not worth the noise

## Rules

- Only create suggestions for files in the changed files list.
- Quality over quantity — fewer high-confidence suggestions beat many low-value ones.
- Praise should be genuine, not filler. 1-2 items max.
- If a file has no issues, skip it entirely.
