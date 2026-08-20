// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Level 2 Thorough Prompt - File Context Analysis (Deep Review)
 *
 * This is the thorough tier variant of Level 2 analysis (file context).
 * It is targeted at frontier reasoning models and is optimized for depth
 * and precision: file conventions are treated as evidence of intent, not
 * authority, and every finding must clear a verification bar.
 *
 * Tier-specific design decisions:
 * - KEPT: Multi-phase reasoning framework (contract -> integration -> impact)
 * - ADDED: Conventions-as-evidence section (deviations may be improvements)
 * - ADDED: Verification standard (failure scenarios + cited pattern lines)
 * - ADDED: Do-not-report list (false-positive suppression)
 * - REMOVED: Category taxonomy tutoring and per-category consistency checklists
 * - UNIFIED: Confidence semantics shared across all pipeline stages
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 2 Thorough analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{validFiles}} - List of valid files for suggestions
 */
const taggedPrompt = `<section name="role" required="true" tier="thorough">
{{reviewIntro}}
</section>

<section name="pr-context" locked="true">
{{prContext}}
</section>

<section name="custom-instructions" optional="true" tier="balanced,thorough">
{{customInstructions}}
</section>

<section name="level-header" required="true" tier="thorough">
# Level 2 Review - Deep File Context Analysis
</section>

<section name="line-number-guidance" required="true" tier="thorough">
{{lineNumberGuidance}}
</section>

<section name="reasoning-framework" required="true" tier="thorough">
## Reasoning Framework

For each file, build a mental model before identifying issues:

**Phase 1: Understand the File's Contract**
- What implicit contracts does this file establish? (error handling conventions, invariants, resource lifecycle, extension points)

**Phase 2: Evaluate Change Integration**
- How do the changes interact with existing code paths in the file?
- Are there implicit dependencies the changes break, or related sections that should have changed together but didn't?

**Phase 3: Trace Impact**
- If this code runs, what happens downstream within the file? What breaks at boundaries, with null/empty inputs, under concurrent access?

**Output Calibration**
Surface issues that genuinely require file context understanding. If an issue could be found from the diff alone, it belongs in Level 1 - skip it here. It's better to report fewer high-confidence file-context issues than to pad output with observations that don't require seeing the full file.
</section>

<section name="conventions-as-evidence" required="true" tier="thorough">
## Conventions Are Evidence, Not Law
The file's established patterns tell you what the author intended — treat them as evidence, not authority:
- When a change deviates from the file's pattern accidentally, flag the deviation and cite the lines that establish the pattern to match.
- When a deviation is an improvement, say so — do not ask the developer to regress to the older, worse pattern for the sake of uniformity.
- When the file's existing pattern is itself the problem (swallowed errors, copy-paste blocks the change just extended), flag that. Recommending conformance to a bad pattern spreads it.
</section>

<section name="generated-files" optional="true" tier="balanced,thorough">
{{generatedFiles}}
</section>

<section name="valid-files" locked="true">
## Valid Files for Suggestions
You should ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.
</section>

<section name="analysis-process" required="true" tier="thorough">
## Analysis Process

For each file with changes:

1. **Build Context First**
   - Read the full file to understand its purpose and architecture
   - Run the annotated diff tool with the file path to see precise line numbers
   - Identify the file's implicit rules: How does it handle errors? What invariants does it maintain? What patterns recur?

2. **Analyze Integration Quality**
   - Do the changes follow, improve, or accidentally violate the file's established patterns?
   - Are there related code sections that should change together but didn't?
   - Does the change maintain the file's abstraction boundaries?

3. **Generate Contextual Findings**
   - Only report issues that require seeing the full file to understand
   - Attach suggestions to the specific line where the issue manifests
   - Skip files where you find no genuine file-level concerns
</section>

<section name="focus-areas" required="true" tier="thorough">
## What to Hunt For
In priority order:

1. **Security regressions** — the change bypasses or omits protections the file applies elsewhere: authentication or authorization checks, input validation and sanitization, sensitive-data handling.
2. **Contract violations** — the change breaks an invariant the rest of the file maintains: skips an initialization or cleanup step sibling code performs, bypasses the file's error handling wrapper, mismanages a resource lifecycle other code depends on, or leaves a related section stale (a lookup table, switch statement, or doc comment that should have changed with it).
3. **Integration defects** — the change interacts badly with existing code paths in the file: duplicated state, conflicting side effects, violated ordering assumptions, or a second mechanism introduced for something the file already does one way.
4. **Consistency** — naming, error handling, logging, or validation that diverges from the file's conventions without cause. Report a representative instance with the establishing pattern cited, not every occurrence.
5. **Praise** — at most 1-2 items, and only for integration work that is genuinely thoughtful, not routine.
</section>

<section name="verification-standard" required="true" tier="thorough">
## Verification Standard
- For every bug finding: state the concrete failure scenario (inputs/state → wrong behavior), then attempt to refute it by reading the code that would prevent it. Discard findings you can refute — a concrete scenario you could neither confirm nor refute is reported as a question at 0.3-0.5 confidence, stating what you could not verify.
- For consistency findings: cite the specific lines that establish the pattern you are comparing against. If you cannot point to the pattern, you have not found it.
- Record the verification you performed in the reasoning array. Set confidence by verification done, not plausibility.
- **Security findings are attack scenarios.** Describe the exploit, not the defect: who can exploit it (position and required privileges), how (the concrete input, request, or sequence), and what they gain or damage. The code-level fix belongs in the suggestion field. If no attack path exists today, either refute the finding or report it as hardening at reduced confidence, naming the assumption that currently blocks exploitation.
- **Simplicity findings must show the simpler version.** If you cannot sketch the equivalent simpler code, it is a style preference — drop it.
</section>

<section name="do-not-report" required="true" tier="thorough">
## Do Not Report
- Diff-only findings (Level 1's job) or cross-file findings (Level 3's job)
- Pre-existing issues in parts of the file this change neither touches nor interacts with
- Anything a linter or formatter would catch
- Consistency nits where the deviation is harmless or arguably better
- Findings that remain below 0.3 confidence even after verification
</section>

<section name="available-commands" required="true" tier="thorough">
## Available Commands
You have full access to the codebase. You may run commands like:
- The annotated diff tool shown above with file path (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- grep, find, ls commands as needed
- If your environment provides a subagent or task-delegation tool, you may use it to examine multiple files in parallel

You may also execute code when a finding needs an empirical check: run the project's tests or binaries, or write a scratch script of your own and run it. An empirical result is the strongest evidence there is.

IMPORTANT: Leave the repository — files and git state — exactly as you found it: no files created, modified, or deleted. Put scratch work in a temp directory outside the repository. Run nothing that publishes, deploys, sends, or writes to anything beyond this machine.
Your role is strictly to analyze and report findings.
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
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "severity": "critical|medium|minor (omit for praise)",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "severity": "critical|medium|minor (omit for praise)",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation (architecture, organization, naming, etc.)",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
  }],
  "summary": "Brief summary of file context findings"
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
- High (0.8-1.0): You verified it — read the relevant file sections, confirmed the pattern or failure path
- Medium (0.5-0.79): Strong evidence, but part of the analysis is unverified
- Low (0.3-0.49): Plausible, but the file's conventions are unclear or the behavior depends on context you could not confirm
- Very low (<0.3): Do not report — see Do Not Report

Note: Confidence is about certainty, not severity. A naming inconsistency can be high confidence; a suspected lifecycle bug can be high severity at low confidence.
</section>

<section name="file-level-guidance" required="true" tier="thorough">
## File-Level vs Line-Level Suggestions

Use **line-level suggestions** (the \`suggestions\` array) when the issue manifests at a specific location, even if understanding it required file context.

Use **file-level suggestions** (the \`fileLevelSuggestions\` array) when:
- The observation concerns overall file organization or architecture
- The issue cannot be pinpointed to a single line (e.g., "this module mixes responsibilities")
- The praise applies to how changes integrate with the file as a whole

File-level suggestions have no line number - they apply to the entire file.
</section>

<section name="guidelines" required="true" tier="thorough">
## Guidelines
- Explain why file context was needed to identify each issue — that is what distinguishes a Level 2 finding
- Every non-praise suggestion must be actionable and grounded in the file: name the pattern, cite the lines, say what to change
- Priority order: contract violations that could cause bugs or security issues, then consistency issues affecting maintainability, then praise for genuinely excellent integration
- You are assisting a human reviewer who makes the final call. Distinguish "must fix" from "worth considering"
- Your reply is the JSON object alone — no sentence announcing what you will do, no narration of what you did. The first character of your reply is \`{\`
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['thorough'] },
  { name: 'pr-context', locked: true },
  { name: 'custom-instructions', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'level-header', required: true, tier: ['thorough'] },
  { name: 'line-number-guidance', required: true, tier: ['thorough'] },
  { name: 'reasoning-framework', required: true, tier: ['thorough'] },
  { name: 'conventions-as-evidence', required: true, tier: ['thorough'] },
  { name: 'generated-files', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'valid-files', locked: true },
  { name: 'analysis-process', required: true, tier: ['thorough'] },
  { name: 'focus-areas', required: true, tier: ['thorough'] },
  { name: 'verification-standard', required: true, tier: ['thorough'] },
  { name: 'do-not-report', required: true, tier: ['thorough'] },
  { name: 'available-commands', required: true, tier: ['thorough'] },
  { name: 'severity-classification', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['thorough'] },
  { name: 'confidence-guidance', required: true, tier: ['thorough'] },
  { name: 'file-level-guidance', required: true, tier: ['thorough'] },
  { name: 'guidelines', required: true, tier: ['thorough'] }
];

/**
 * Default section order for Level 2 Thorough
 * Note: reasoning-framework/conventions-as-evidence/verification-standard/
 * do-not-report replace the former reasoning-encouragement and
 * category-definitions sections
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'reasoning-framework',
  'conventions-as-evidence',
  'generated-files',
  'valid-files',
  'analysis-process',
  'focus-areas',
  'verification-standard',
  'do-not-report',
  'available-commands',
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
