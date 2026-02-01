# Level 2 — Analyze Changes in File Context

Analyze how the changes fit within their **file's structure, patterns, and conventions**. This level reads full files to understand context that Level 1 misses.

## Process

1. Run the `git-diff-lines` script (located in this skill's `scripts/` directory) to get an annotated diff with explicit OLD and NEW line numbers.
2. For each changed file, **read the full file** to understand its structure.
3. Analyze how the changes fit (or don't fit) within the file's existing patterns.
4. Skip files with no issues — don't force suggestions.

## Focus areas

Look for issues that only become visible with file context:

- **Inconsistencies**: Changes that break patterns established elsewhere in the file (naming, error handling, style)
- **Missing related changes**: Updated a function but not its callers within the file, changed a type but not its usage
- **Security in context**: Input validation gaps visible when you see the full data flow within the file
- **Style violations**: Divergence from the file's established conventions
- **Design patterns**: Changes that don't follow patterns used elsewhere in the same file
- **Documentation**: Missing or outdated comments/docstrings given the changes
- **Praise**: Changes that improve file-level consistency or fix pre-existing issues

## Line-level vs file-level suggestions

Most suggestions should reference specific lines. But some observations apply to the whole file:
- Architecture or structural concerns
- Missing test coverage for the file
- Naming convention shifts
- File organization issues

Put these in `fileLevelSuggestions` with no line numbers.

## Output format

Return valid JSON only — no markdown, no commentary outside the JSON:

```json
{
  "level": 2,
  "suggestions": [
    {
      "file": "path/to/file",
      "line_start": 42,
      "line_end": 45,
      "side": "RIGHT",
      "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
      "title": "Brief title",
      "description": "Detailed explanation",
      "suggestion": "How to fix",
      "confidence": 0.8
    }
  ],
  "fileLevelSuggestions": [
    {
      "file": "path/to/file",
      "type": "improvement",
      "title": "Brief title",
      "description": "Detailed explanation",
      "suggestion": "How to address",
      "confidence": 0.7
    }
  ],
  "summary": "Brief summary of findings"
}
```

## Confidence and rules

- Same confidence calibration as Level 1 (0.8+ certain, 0.5-0.79 likely, below 0.5 omit).
- Only suggest for files in the changed files list.
- Don't repeat issues that are obvious from the diff alone — Level 1 covers those. Focus on what the **file context** reveals.
- Praise should be genuine. 1-2 items max.
