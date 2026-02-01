# Level 3 — Analyze Changes in Codebase Context

Analyze how the changes **impact and interact with the broader codebase**. This level explores beyond the changed files to understand architectural implications.

This is NOT a general codebase audit. Stay focused on how the changes relate to and affect other parts of the codebase.

## Process

1. Run the `git-diff-lines` script (located in this skill's `scripts/` directory) to get an annotated diff with explicit OLD and NEW line numbers.
2. Start from the changed files and **explore outward**: find files that import/reference the changed code, related tests, configuration, documentation.
3. Assess impact: do the changes break contracts, violate patterns, or create inconsistencies at the project level?
4. Check for missing follow-up changes in the broader codebase.

## Focus areas

Look for issues that only become visible with codebase context:

- **Architecture & patterns**: Do the changes fit, improve, or disrupt the project's architecture? Are established patterns followed?
- **Contracts & compatibility**: Breaking changes to APIs, interfaces, or contracts? Backward compatibility issues? Are callers/consumers updated?
- **Testing gaps**: Missing tests for the changed functionality? Existing tests that should be updated?
- **Documentation**: README, API docs, or config docs that need updating?
- **Performance & security at scale**: Impact on connected components? System-level security implications?
- **Data flow**: Changes that affect data flow across module boundaries
- **Praise**: Changes that improve architectural consistency or address tech debt

## Output format

Return valid JSON only — no markdown, no commentary outside the JSON:

```json
{
  "level": 3,
  "suggestions": [
    {
      "file": "path/to/file",
      "line_start": 42,
      "line_end": 42,
      "side": "RIGHT",
      "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
      "title": "Brief title",
      "description": "Detailed explanation including cross-file context",
      "suggestion": "How to fix",
      "confidence": 0.8
    }
  ],
  "fileLevelSuggestions": [
    {
      "file": "path/to/file",
      "type": "design",
      "title": "Brief title",
      "description": "Architectural observation",
      "suggestion": "How to address",
      "confidence": 0.7
    }
  ],
  "summary": "Brief summary of codebase-level findings"
}
```

## Confidence and rules

- Same confidence calibration as other levels (0.8+ certain, 0.5-0.79 likely, below 0.5 omit).
- Suggestions can reference files NOT in the changed files list — if a change requires updates elsewhere, flag it. Mark these with `"outside_changeset": true` so orchestration can surface them appropriately.
- Don't repeat issues that are obvious from the diff or file context alone — Levels 1 and 2 cover those. Focus on what **codebase context** reveals.
- Use parallel tool calls when exploring multiple areas of the codebase.
- Praise should be genuine. 1-2 items max.
