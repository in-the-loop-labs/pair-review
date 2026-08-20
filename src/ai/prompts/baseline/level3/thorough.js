// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Level 3 Thorough Prompt - Codebase Context Analysis (Deep Review)
 *
 * This is the thorough tier variant of Level 3 analysis (codebase context).
 * It is targeted at frontier reasoning models and is optimized for
 * evidence-grounded cross-file analysis: cited patterns must actually be
 * found, and breaking-change claims must name a real victim.
 *
 * Tier-specific design decisions:
 * - KEPT: Structured analysis process (dependency tracing folded in)
 * - ADDED: Verification standard (patterns must exist, victims must be named)
 * - ADDED: Do-not-report list (false-positive suppression)
 * - COMPRESSED: Focus areas from eleven checklist categories to six
 *   prioritized hunting grounds, security listed first
 * - REMOVED: Category taxonomy tutoring and reasoning-encouragement boilerplate
 * - UNIFIED: Confidence semantics shared across all pipeline stages
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 3 Thorough analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{changedFiles}} - List of changed files in this PR
 * - {{testingGuidance}} - Testing-specific guidance based on context
 */
const taggedPrompt = `<section name="role" required="true" tier="thorough">
{{reviewIntro}}
</section>

<section name="pr-context" locked="true">
{{prContext}}
</section>

<section name="custom-instructions" optional="true" tier="fast,balanced,thorough">
{{customInstructions}}
</section>

<section name="level-header" required="true" tier="thorough">
# Level 3 Review - Deep Codebase Impact Analysis
</section>

<section name="line-number-guidance" required="true" tier="thorough">
{{lineNumberGuidance}}
</section>

<section name="generated-files" optional="true" tier="fast,balanced,thorough">
{{generatedFiles}}
</section>

<section name="changed-files" locked="true">
{{changedFiles}}
</section>

<section name="purpose" required="true" tier="thorough">
## Purpose
Level 3 analyzes how the changes connect to and impact the broader codebase.
This is NOT a general codebase review or architectural audit.
Focus on understanding the relationships between these specific changes and existing code.

Key questions to answer:
- How do these changes interact with the established architecture?
- Are there patterns elsewhere in the codebase that these changes should follow — or improve?
- What other parts of the system might be affected by these changes?
- Are there missing changes (tests, documentation, configuration) that should accompany these changes?
</section>

<section name="analysis-process" required="true" tier="thorough">
## Analysis Process
A structured framework for codebase exploration:

1. **Map the change scope** — List the modified functions/classes and their public interfaces. Separate additive changes from modifications to existing behavior; the latter carry the breaking-change risk.

2. **Trace dependencies** — Use grep/find to locate every caller of modified code. For behavior changes, check each caller's assumptions; for interface changes, check every call site. This is where Level 3's highest-value findings live.

3. **Find the precedents** — Locate 2-3 similar implementations in the codebase before judging conformance. Note their conventions (naming, error handling, validation, logging). Distinguish "this is how it's done here" from "this is how it should be done" — the change may be right to deviate, or may be the opportunity to improve the pattern.

4. **Assess system impact** — Trace data flow through the changed paths: trust boundaries crossed, failure modes if this code throws or returns bad data, layering violations, performance effects on other code paths (N+1 patterns, contention, cache behavior).

5. **Check completeness** — Do similar modules have tests, and does this change follow that pattern? Are documentation, configuration, feature flags, or migrations needed to accompany these changes?
</section>

<section name="focus-areas" required="true" tier="thorough">
## What to Hunt For
In priority order:

1. **Security boundaries** — authentication or authorization patterns bypassed compared to how the codebase protects similar surfaces; trust boundaries crossed unsafely; new data exposure paths.
2. **Breaking changes** — callers whose assumptions this change violates; public interface changes without dependent updates; implicit contracts (ordering, nullability, error types) changed silently; backwards compatibility and migration gaps.
3. **Pattern conformance** — deviations from established codebase patterns, citing the precedents you found; reimplementation of existing utilities; a new layer, service, or abstraction duplicating a capability an existing mechanism already provides; places where the change should improve a pattern rather than merely follow it.
4. **Missing accompanying changes** — check whether similar modules have tests and what patterns they follow; documentation for changed public interfaces; configuration, feature flags, or migrations these changes require. Testing guidance for this review:
{{testingGuidance}}
5. **System-level risk** — performance impact on other code paths; resource contention; blast radius if this code fails.
6. **Praise** — at most 1-2 items, for changes that integrate exceptionally well or pay down real debt.
</section>

<section name="verification-standard" required="true" tier="thorough">
## Verification Standard
- **Cited patterns must exist.** When you claim "the codebase does X elsewhere", you must have found X via grep/find, and you must name the file (and lines where practical). No confabulated conventions.
- **Breaking-change claims must name the victim.** "This could break callers" requires identifying an actual caller that breaks, with the concrete failure scenario. If you searched and every caller handles the change, there is no finding.
- **Refute before reporting.** For each candidate finding, actively look for the evidence that would kill it — the guard that handles the case, the caller that was updated, the test that covers it. Record what you checked in the reasoning array. Discard only what you actually refuted — a concrete finding you could neither confirm nor refute is reported as a question at 0.3-0.5 confidence, stating what you could not verify.
- **Security findings are attack scenarios.** Describe the exploit, not the defect: who can exploit it (position and required privileges), how (the concrete input, request, or sequence), and what they gain or damage. The code-level fix belongs in the suggestion field. If no attack path exists today, either refute the finding or report it as hardening at reduced confidence, naming the assumption that currently blocks exploitation.
- **Simplicity findings must show the simpler version.** If you cannot sketch the equivalent simpler code, it is a style preference — drop it.
</section>

<section name="do-not-report" required="true" tier="thorough">
## Do Not Report
- Findings visible from the diff or a single file alone — Levels 1 and 2 own those. Ask: "Did I need to look at other files to find this?" If no, omit it.
- Pre-existing architectural debt these changes neither touch nor worsen
- Speculative "consider adding caching/abstraction/flexibility" without a concrete current cost
- Generic "add more tests" — only flag test gaps with evidence of the project's testing pattern for similar code
- Findings that remain below 0.3 confidence even after verification
</section>

<section name="available-commands" required="true" tier="thorough">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- find . -name "*.test.js" or similar to find test files
- grep -r "pattern" to search for patterns and usages
- \`cat -n <file>\` to view files with line numbers
- ls, tree commands to explore structure
- Any other read-only commands needed to understand how changes connect to the codebase

IMPORTANT: Do NOT modify any files, create files or directories (scratch and temp space included), or run write commands (rm, mv, git commit, etc.). Do NOT execute the project's code, tests, or binaries — verify by reading code, not by running it.
Your role is strictly to analyze and report findings.

Note: If your environment provides a subagent or task-delegation tool, you may use it to parallelize independent read-only exploration. This is especially useful for:
- Searching for similar patterns in different parts of the codebase
- Tracing dependencies across multiple files
- Analyzing test coverage in parallel with main code analysis
</section>

<section name="sparse-checkout" optional="true" tier="fast,balanced,thorough">
{{sparseCheckoutGuidance}}
</section>

<section name="severity-classification" required="true">
### Severity Classification
Assign a severity to each suggestion (except praise):
- **critical**: Production incidents, system failures, or security vulnerabilities — runtime crashes, data corruption or loss, race conditions, deadlocks, breaking changes, changes that will cause existing tests to fail
- **medium**: Degraded functionality or reliability — missing error handling, N+1 queries, missing validation, missing or poor test coverage for new functionality
- **minor**: Code quality concerns — documentation gaps, minor optimizations, style inconsistencies
Omit severity for praise items.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

Output JSON with this structure:
{
  "level": 3,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "severity": "critical|medium|minor (omit for praise)",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why codebase context was needed",
    "suggestion": "How to fix/improve based on codebase context (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "severity": "critical|medium|minor (omit for praise)",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation from codebase perspective",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
  }],
  "summary": "Brief summary of how these changes connect to and impact the codebase"
}

### GitHub Suggestion Syntax
When suggesting a specific change, **embed** a GitHub suggestion block within the "suggestion" field:

\`\`\`suggestion
replacement content here
\`\`\`

The content inside the block is the complete replacement for the commented line(s). Do not include explanation inside the block — any explanation should appear as plain text outside it. For non-specific suggestions, use plain text only.
</section>

<section name="diff-instructions" required="true" tier="thorough">
## old_or_new Field Reference
Use "NEW" (the default) for added lines [+] and context lines. Use "OLD" only for DELETED lines marked with [-]. When uncertain, use "NEW".
</section>

<section name="confidence-guidance" required="true" tier="thorough">
## Confidence Calibration
**Confidence** is the probability that the finding is real and correctly described:

- **High (0.8-1.0)**: You verified the issue. You traced the code paths, found the callers, checked the patterns. This is definitely a problem.
- **Medium (0.5-0.79)**: Strong evidence but incomplete verification. You found concerning patterns but haven't exhaustively checked all code paths.
- **Low (0.3-0.49)**: Suspicion based on heuristics. The code looks problematic but you lack evidence from the codebase to confirm.
- **Very low (<0.3)**: Do not report — see Do Not Report.

**Critical distinction**: Confidence != severity. Examples:
- Naming inconsistency: high confidence (easy to verify), low severity
- Potential race condition: low confidence (hard to verify without runtime analysis), high severity

Lower your confidence when:
- You couldn't find similar code to compare against
- The codebase conventions are unclear or inconsistent
- The issue depends on runtime behavior you can't verify statically
</section>

<section name="file-level-guidance" required="true" tier="thorough">
## File-Level Suggestions
In addition to line-specific suggestions, you CAN include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines.

**When to use file-level suggestions:**
- The observation requires understanding the file's role in the codebase, not just one line
- The issue cannot be addressed by changing a single line
- The concern relates to where the file should be located or how it should be organized
- The praise applies to how well the file integrates with the broader codebase

**Examples of good file-level suggestions:**
- "This new service should be in the services/ directory to follow project structure"
- "This file duplicates functionality in src/utils/helpers.js - consider consolidating"
- "Missing integration tests - similar modules have tests in tests/integration/"
- "Excellent implementation of the repository pattern matching existing services"

File-level suggestions should NOT have a line number. They apply to the entire file.
</section>

<section name="guidelines" required="true" tier="thorough">
## Guidelines

### Output Standards
- **Line-level vs file-level**: Anchor to specific lines when possible. File-level suggestions are for issues that genuinely span the entire file.
- **Actionable suggestions**: Reference specific patterns or files. Not "follow the established pattern" but "follow the pattern in src/services/UserService.js lines 45-60".
- **Praise items**: Omit the suggestion field. Explain what they did well relative to codebase conventions.
- **Must fix vs should consider**: Distinguish findings that break things or create security risk from consistency and maintainability considerations. The human reviewer makes the final call.
- **Reply shape**: Your reply is the JSON object alone — no sentence announcing what you will do, no narration of what you did. The first character of your reply is \`{\`.
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['thorough'] },
  { name: 'pr-context', locked: true },
  { name: 'custom-instructions', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'level-header', required: true, tier: ['thorough'] },
  { name: 'line-number-guidance', required: true, tier: ['thorough'] },
  { name: 'generated-files', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'changed-files', locked: true },
  { name: 'purpose', required: true, tier: ['thorough'] },
  { name: 'analysis-process', required: true, tier: ['thorough'] },
  { name: 'focus-areas', required: true, tier: ['thorough'] },
  { name: 'verification-standard', required: true, tier: ['thorough'] },
  { name: 'do-not-report', required: true, tier: ['thorough'] },
  { name: 'available-commands', required: true, tier: ['thorough'] },
  { name: 'sparse-checkout', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'severity-classification', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['thorough'] },
  { name: 'confidence-guidance', required: true, tier: ['thorough'] },
  { name: 'file-level-guidance', required: true, tier: ['thorough'] },
  { name: 'guidelines', required: true, tier: ['thorough'] }
];

/**
 * Default section order for Level 3 Thorough
 * Note: verification-standard/do-not-report replace the former
 * reasoning-encouragement and category-definitions sections; dependency
 * tracing and architectural thinking were folded into analysis-process
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'changed-files',
  'purpose',
  'analysis-process',
  'focus-areas',
  'verification-standard',
  'do-not-report',
  'available-commands',
  'sparse-checkout',
  'severity-classification',
  'output-schema',
  'diff-instructions',
  'confidence-guidance',
  'file-level-guidance',
  'guidelines'
];

/**
 * Parse the tagged prompt into section objects
 * @returns {Array<Object>} Array of section objects with name, attributes, and content
 */
function parseSections() {
  const sectionRegex = /<section\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/section>/g;
  const parsed = [];
  let match;

  while ((match = sectionRegex.exec(taggedPrompt)) !== null) {
    const [, name, attrs, content] = match;
    const section = {
      name,
      content: content.trim(),
      locked: attrs.includes('locked="true"'),
      required: attrs.includes('required="true"'),
      optional: attrs.includes('optional="true"')
    };

    // Extract tier attribute if present
    const tierMatch = attrs.match(/tier="([^"]+)"/);
    if (tierMatch) {
      section.tier = tierMatch[1].split(',').map(t => t.trim());
    }

    parsed.push(section);
  }

  return parsed;
}

module.exports = {
  taggedPrompt,
  sections,
  defaultOrder,
  parseSections
};
