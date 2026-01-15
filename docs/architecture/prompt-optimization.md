# Prompt Optimization Architecture

## 1. Overview

### The Problem

AI-powered code review requires carefully crafted prompts to elicit useful, structured feedback from language models. However, different models have different strengths, context windows, reasoning capabilities, and response patterns. A prompt optimized for Claude may perform suboptimally with Gemini or GPT-4, and vice versa.

Additionally, within a single provider, different model tiers (fast/balanced/thorough) have vastly different capabilities. A prompt designed for deep architectural reasoning with Opus would be wasteful and potentially confusing for Haiku.

### The Solution

We implement a **4 prompts × 3 tiers × N providers** matrix:

```
                    fast        balanced      thorough
                 ┌───────────┬─────────────┬────────────┐
Level 1          │           │             │            │
(isolation)      │  prompt   │   prompt    │   prompt   │
                 ├───────────┼─────────────┼────────────┤
Level 2          │           │             │            │
(file context)   │  prompt   │   prompt    │   prompt   │
                 ├───────────┼─────────────┼────────────┤
Level 3          │           │             │            │
(codebase)       │  prompt   │   prompt    │   prompt   │
                 ├───────────┼─────────────┼────────────┤
Orchestration    │           │             │            │
(coordination)   │  prompt   │   prompt    │   prompt   │
                 └───────────┴─────────────┴────────────┘
                        × N providers
```

### Baseline + Derivation Approach

Rather than maintaining N×4×3 = 12N independent prompts, we use a **baseline + derivation** approach:

1. **Claude prompts are canonical**: We maintain authoritative baseline prompts optimized for Claude models
2. **Other providers derive variants**: Each provider optimizes from the Claude baseline, storing only the differences
3. **Models optimize for themselves**: We let the target model (e.g., Gemini) optimize its own prompts, as it best understands its own capabilities and preferences

This approach ensures:
- Single source of truth for prompt logic
- Minimal maintenance burden
- Provider-specific optimizations without duplication
- Easy updates when baseline prompts evolve

---

## 2. Prompt Types (4)

### Level 1: Changes in Isolation

Analyzes the changed lines themselves, without broader context.

**Focus areas:**
- Syntax errors and typos
- Obvious bugs in the changed code
- Style violations
- Missing null checks
- Incomplete implementations

**Characteristics:**
- Smallest context window requirements
- Fastest execution
- Catches "obvious" issues
- No architectural awareness

### Level 2: File Context Analysis

Analyzes changes within the context of their containing file(s).

**Focus areas:**
- Consistency with existing patterns in the file
- Proper integration with surrounding code
- Function/method coherence
- Import/export correctness
- Naming consistency within file

**Characteristics:**
- Moderate context requirements
- Catches integration issues within files
- Aware of local patterns and conventions

### Level 3: Codebase/Architectural Context

Analyzes changes in the broader context of the codebase architecture.

**Focus areas:**
- Architectural consistency
- Cross-cutting concerns (logging, error handling, auth)
- Pattern adherence across codebase
- Dependency relationships
- Performance implications
- Security considerations

**Characteristics:**
- Largest context requirements
- Requires codebase knowledge injection
- Catches systemic issues
- Most expensive to run

### Orchestration: Coordinates Levels, Curates Results

The meta-prompt that coordinates the multi-level analysis.

**Responsibilities:**
- Determine which levels to run based on change scope
- Aggregate and deduplicate findings
- Prioritize and rank issues
- Generate the final structured output
- Resolve conflicting suggestions between levels

**Characteristics:**
- Runs after level prompts complete
- Has access to all level outputs
- Responsible for final quality control
- Manages the overall review narrative

---

## 3. Capability Tiers (3)

### Fast Tier

**Model examples:** Claude Haiku, Gemini Flash, GPT-4o-mini

**Characteristics:**
- Speed-optimized responses
- Constrained reasoning depth
- Smaller context windows
- Best for: Quick checks, obvious issues, high-volume reviews

**Prompt adaptations:**
- Shorter, more directive prompts
- Explicit reasoning steps (model needs more guidance)
- Simpler output schemas
- Fewer examples
- Remove architectural considerations

### Balanced Tier

**Model examples:** Claude Sonnet, Gemini Pro, GPT-4o

**Characteristics:**
- Balance of speed and analytical depth
- Moderate context windows
- Good general-purpose reasoning
- Best for: Standard code reviews, most PRs

**Prompt adaptations:**
- Full prompt structure
- Moderate example count
- Standard output schemas
- Include relevant optional sections

### Thorough Tier

**Model examples:** Claude Opus, Gemini Ultra, o1/o3

**Characteristics:**
- Deep reasoning capabilities
- Large context windows
- Extended thinking / chain-of-thought
- Best for: Complex PRs, architectural changes, security-critical code

**Prompt adaptations:**
- Encourage extended reasoning
- Include architectural considerations
- Request confidence calibration
- Enable multi-step analysis
- Full example sets

### User-Facing Aliases

To simplify the user experience, we map friendly names to capability tiers:

| User Selection | Internal Tier | Description |
|---------------|---------------|-------------|
| `free` | `fast` | Free-tier models, quick analysis |
| `standard` | `balanced` | Default experience, good quality |
| `premium` | `thorough` | Maximum depth, highest cost |

Configuration example:
```javascript
// User configures with friendly names
{ "reviewQuality": "standard" }

// Internally maps to
{ "tier": "balanced" }
```

---

## 4. Section Categories

Each section in a baseline prompt is categorized to control how variants can modify it.

### Locked Sections

**Cannot modify, included only for context.**

These sections contain information that must be identical across all providers to ensure consistent behavior.

| Section | Purpose |
|---------|---------|
| `valid-files` | List of files eligible for review |
| `output-schema` | JSON schema for structured output |
| `pr-context` | PR metadata (title, description, author) |
| `diff-content` | The actual diff being reviewed |

**Rationale:** Output parsing depends on consistent schemas. PR context must be accurate across providers.

### Required Sections

**Must be present, can modify content.**

These sections define core review behavior and must exist, but providers may rephrase for their model's preferences.

| Section | Purpose |
|---------|---------|
| `role` | System role definition |
| `constraints` | What to review/ignore |
| `diff-instructions` | How to interpret the diff format |
| `output-instructions` | How to format findings |

**Rationale:** Every provider needs these concepts, but models may respond better to different phrasings.

### Optional Sections

**Can remove entirely if unhelpful.**

These sections enhance output quality for some models but may be unnecessary or counterproductive for others.

| Section | Purpose | Typical Tier |
|---------|---------|--------------|
| `examples` | Few-shot examples | balanced, thorough |
| `confidence-guidance` | Calibration instructions | thorough |
| `architectural-considerations` | System-level thinking | thorough |
| `praise-guidance` | How to identify good code | all |
| `severity-calibration` | Issue severity guidelines | balanced, thorough |

**Rationale:** Fast models may get confused by too much guidance. Some models don't benefit from examples.

---

## 5. Tagged Format Specification

Baseline prompts use an XML-style tagged format that enables machine-readable optimization.

### Tag Syntax

```xml
<section name="role" required="true">
You are an expert code reviewer analyzing a GitHub pull request.
Your goal is to identify issues, suggest improvements, and highlight
good practices in the changed code.
</section>

<section name="output-schema" locked="true">
{{outputSchema}}
</section>

<section name="examples" optional="true" tier="balanced,thorough">
Here are examples of good review comments:
...
</section>
```

### Attributes

| Attribute | Values | Description |
|-----------|--------|-------------|
| `name` | string | Unique section identifier |
| `locked` | `"true"` | Cannot be modified by variants |
| `required` | `"true"` | Must be present, content can change |
| `optional` | `"true"` | Can be removed entirely |
| `tier` | comma-separated | Which tiers include this section |

### Placeholder Syntax

Dynamic content uses double-brace placeholders:

```
{{variableName}}
```

Common placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{outputSchema}}` | JSON schema for structured output |
| `{{prTitle}}` | Pull request title |
| `{{prDescription}}` | Pull request description |
| `{{diffContent}}` | The unified diff |
| `{{validFiles}}` | List of files to review |
| `{{fileContext}}` | Additional file content (Level 2+) |
| `{{codebaseContext}}` | Architectural context (Level 3) |

### Section Inventory by Tier

| Section | fast | balanced | thorough |
|---------|------|----------|----------|
| role | ✓ | ✓ | ✓ |
| constraints | ✓ | ✓ | ✓ |
| diff-instructions | ✓ | ✓ | ✓ |
| output-instructions | ✓ | ✓ | ✓ |
| output-schema | ✓ | ✓ | ✓ |
| pr-context | ✓ | ✓ | ✓ |
| valid-files | ✓ | ✓ | ✓ |
| diff-content | ✓ | ✓ | ✓ |
| examples | | ✓ | ✓ |
| praise-guidance | ✓ | ✓ | ✓ |
| severity-calibration | | ✓ | ✓ |
| confidence-guidance | | | ✓ |
| architectural-considerations | | | ✓ |

---

## 6. Optimization Workflow

### Step 1: Provide Tagged Baseline to Target Model

The optimization system presents the full tagged baseline prompt to the target model (e.g., Gemini Pro) with instructions to optimize it.

```javascript
const optimizationRequest = {
  systemPrompt: OPTIMIZATION_META_PROMPT,
  userPrompt: taggedBaselinePrompt,
  context: {
    targetModel: "gemini-pro",
    tier: "balanced",
    promptType: "level1"
  }
};
```

The meta-prompt instructs the model to:
- Understand its own strengths and limitations
- Identify sections that could be rephrased for better comprehension
- Remove optional sections that don't help its performance
- Reorder sections for optimal processing
- Preserve all locked sections exactly

### Step 2: Target Model Optimizes Holistically

The target model returns an optimized version of the full prompt, with:
- Reordered sections (if beneficial)
- Modified content in required sections
- Removed optional sections (with rationale)
- Preserved locked sections (unchanged)

Example output structure:
```xml
<optimized-prompt>
  <section name="role" required="true">
  [Model's optimized version of the role section]
  </section>

  <section name="constraints" required="true">
  [Model's optimized version]
  </section>

  <removed-section name="examples" reason="Few-shot examples reduce my accuracy on this task; I perform better with explicit instructions only." />

  <!-- Locked sections preserved exactly -->
  <section name="output-schema" locked="true">
  {{outputSchema}}
  </section>
</optimized-prompt>

<optimization-notes>
- Moved constraints before role for better instruction following
- Simplified language in diff-instructions for clarity
- Removed examples section as it was counterproductive
</optimization-notes>
```

### Step 3: Claude Agent Extracts Overrides

A Claude agent (in SDK mode) processes the optimized output and extracts a structured variant definition.

```javascript
const extractionResult = await claudeAgent.extract({
  originalBaseline: taggedBaselinePrompt,
  optimizedOutput: targetModelOutput,
  extractionSchema: VARIANT_SCHEMA
});
```

### Step 4: Store as Variant File

The extracted overrides are stored as a variant file with metadata.

```javascript
// variants/google/gemini-pro/level1-balanced.json
{
  "meta": {
    "baselineVersion": "1.2.0",
    "optimizedAt": "2024-01-15T10:30:00Z",
    "optimizedBy": "gemini-pro",
    "validatedAt": "2024-01-15T10:35:00Z"
  },
  "sectionOrder": ["constraints", "role", "diff-instructions", ...],
  "overrides": {
    "role": "You are a code review assistant...",
    "constraints": "Focus your analysis on..."
  },
  "removedSections": {
    "examples": "Few-shot examples reduce accuracy for this model"
  }
}
```

---

## 7. Extraction Output Format

The extraction phase produces a structured variant definition.

### Schema

```javascript
{
  // Ordered list of section names (determines prompt assembly order)
  "sectionOrder": ["string"],

  // Modified content for non-locked sections
  "overrides": {
    "sectionName": "modified content string"
  },

  // Sections removed with explanations
  "removedSections": {
    "sectionName": "reason for removal"
  },

  // Metadata about the optimization
  "meta": {
    "baselineVersion": "semver string",
    "baselineHash": "sha256 of baseline content",
    "optimizedAt": "ISO timestamp",
    "optimizedBy": "model identifier",
    "optimizationNotes": "free-form notes from model"
  }
}
```

### Validation Checks

The extraction process validates:

1. **Locked section preservation**: All locked sections must be present and unmodified
2. **Required section presence**: All required sections must exist (possibly modified)
3. **Section name validity**: All referenced sections must exist in baseline
4. **Override content validity**: Modified content must be non-empty strings
5. **Removal rationale**: Removed sections must include a reason

```javascript
function validateVariant(variant, baseline) {
  const errors = [];

  // Check locked sections are preserved
  for (const section of baseline.lockedSections) {
    if (variant.overrides[section.name]) {
      errors.push(`Cannot override locked section: ${section.name}`);
    }
    if (variant.removedSections[section.name]) {
      errors.push(`Cannot remove locked section: ${section.name}`);
    }
  }

  // Check required sections are present
  for (const section of baseline.requiredSections) {
    if (variant.removedSections[section.name]) {
      errors.push(`Cannot remove required section: ${section.name}`);
    }
  }

  // Validate section order contains only valid names
  const validNames = new Set(baseline.sections.map(s => s.name));
  for (const name of variant.sectionOrder) {
    if (!validNames.has(name)) {
      errors.push(`Unknown section in order: ${name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 8. Storage Format

### Variant File Structure

Each variant is stored as a JSON file with the following structure:

```javascript
// variants/google/gemini-pro/level1-balanced.json
{
  "meta": {
    // Version of the baseline this was derived from
    "baselineVersion": "1.2.0",

    // Hash of baseline content for staleness detection
    "baselineHash": "a1b2c3d4e5f6...",

    // When this variant was created/updated
    "optimizedAt": "2024-01-15T10:30:00Z",

    // Model that performed the optimization
    "optimizedBy": "gemini-1.5-pro",

    // When validation tests last passed
    "validatedAt": "2024-01-15T10:35:00Z",

    // Any notes from the optimization process
    "notes": "Simplified instructions for better compliance"
  },

  // Order in which sections should appear in assembled prompt
  "sectionOrder": [
    "constraints",
    "role",
    "diff-instructions",
    "output-instructions",
    "output-schema",
    "pr-context",
    "valid-files",
    "diff-content",
    "severity-calibration",
    "praise-guidance"
  ],

  // Modified content for non-locked sections
  "overrides": {
    "role": "You are a code review assistant. Analyze the provided pull request diff and identify issues, improvements, and positive patterns.",
    "constraints": "Focus your review on:\n- Bug detection\n- Code quality\n- Best practices\n\nDo not comment on:\n- Formatting handled by automated tools\n- Files not in the valid-files list"
  },

  // Sections removed (with reasons)
  "removedSections": {
    "examples": "This model performs better with explicit instructions than few-shot examples",
    "confidence-guidance": "Not applicable for balanced tier"
  }
}
```

### Version Tracking

A metadata file tracks baseline versions:

```javascript
// baseline/_meta.json
{
  "version": "1.2.0",
  "updatedAt": "2024-01-10T08:00:00Z",
  "changelog": [
    {
      "version": "1.2.0",
      "date": "2024-01-10",
      "changes": [
        "Added severity-calibration section",
        "Refined output schema for suggestions"
      ]
    },
    {
      "version": "1.1.0",
      "date": "2024-01-05",
      "changes": [
        "Improved diff-instructions clarity",
        "Added praise-guidance section"
      ]
    }
  ]
}
```

---

## 9. Runtime Assembly

At runtime, prompts are assembled by combining baseline sections with variant overrides.

### Assembly Process

```javascript
async function assemblePrompt(promptType, tier, provider, context) {
  // 1. Load baseline for this prompt type and tier
  const baseline = await loadBaseline(promptType, tier);

  // 2. Load variant if it exists
  const variant = await loadVariant(provider, promptType, tier);

  // 3. Determine section order
  const sectionOrder = variant?.sectionOrder ?? baseline.defaultOrder;

  // 4. Assemble sections
  const sections = [];
  for (const sectionName of sectionOrder) {
    // Skip removed sections
    if (variant?.removedSections?.[sectionName]) {
      continue;
    }

    const baselineSection = baseline.sections.find(s => s.name === sectionName);

    // Get content (override if available, otherwise baseline)
    let content;
    if (baselineSection.locked) {
      content = baselineSection.content;
    } else if (variant?.overrides?.[sectionName]) {
      content = variant.overrides[sectionName];
    } else {
      content = baselineSection.content;
    }

    sections.push({ name: sectionName, content });
  }

  // 5. Interpolate placeholders
  const assembledPrompt = sections
    .map(s => interpolate(s.content, context))
    .join('\n\n');

  return assembledPrompt;
}
```

### Placeholder Interpolation

```javascript
function interpolate(template, context) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (context.hasOwnProperty(key)) {
      return context[key];
    }
    throw new Error(`Missing context value for placeholder: ${key}`);
  });
}
```

### Shared Section Handling

Some sections are shared across prompt types (e.g., output schema structure). These live in the `shared/` directory and are imported by reference.

```javascript
// baseline/level1/balanced.js
import { outputSchemaSection } from '../shared/output-schema.js';
import { diffInstructionsSection } from '../shared/diff-instructions.js';

export const sections = [
  roleSection,          // Specific to level1
  constraintsSection,   // Specific to level1
  diffInstructionsSection,  // Shared
  outputSchemaSection,      // Shared
  // ...
];
```

---

## 10. Directory Structure

```
src/ai/prompts/
├── index.js                    # Main entry point, exports assemblePrompt()
├── config.js                   # Tier mappings, provider configs
├── schemas.js                  # JSON schemas for outputs
│
├── baseline/                   # Canonical Claude-optimized prompts
│   ├── _meta.json             # Version tracking
│   ├── level1/
│   │   ├── fast.js            # Level 1 prompt for fast tier
│   │   ├── balanced.js        # Level 1 prompt for balanced tier
│   │   └── thorough.js        # Level 1 prompt for thorough tier
│   ├── level2/
│   │   ├── fast.js
│   │   ├── balanced.js
│   │   └── thorough.js
│   ├── level3/
│   │   ├── fast.js
│   │   ├── balanced.js
│   │   └── thorough.js
│   └── orchestration/
│       ├── fast.js
│       ├── balanced.js
│       └── thorough.js
│
├── variants/                   # Provider-specific overrides
│   ├── google/
│   │   ├── gemini-flash/
│   │   │   ├── level1-fast.json
│   │   │   ├── level2-fast.json
│   │   │   └── ...
│   │   ├── gemini-pro/
│   │   │   ├── level1-balanced.json
│   │   │   └── ...
│   │   └── gemini-ultra/
│   │       └── ...
│   ├── openai/
│   │   ├── gpt-4o-mini/
│   │   ├── gpt-4o/
│   │   └── o1/
│   └── mistral/
│       ├── mistral-small/
│       ├── mistral-medium/
│       └── mistral-large/
│
├── shared/                     # Reusable sections across prompt types
│   ├── output-schema.js       # Standard output schema section
│   ├── diff-instructions.js   # How to read unified diffs
│   ├── severity-levels.js     # Issue severity definitions
│   └── praise-patterns.js     # Good code patterns to recognize
│
└── tools/                      # CLI tools for prompt management
    ├── optimize.js            # Run optimization for a provider/tier
    ├── extract.js             # Extract variant from optimized output
    ├── validate.js            # Validate variant files
    ├── assemble.js            # Preview assembled prompt
    └── stale-check.js         # Detect outdated variants
```

---

## 11. Maintenance

### Staleness Detection

When the baseline changes, variants may become stale. The staleness checker compares baseline hashes.

```javascript
// tools/stale-check.js

async function checkStaleness() {
  const baseline = await loadBaselineMeta();
  const staleVariants = [];

  for await (const variant of iterateVariants()) {
    if (variant.meta.baselineHash !== baseline.hash) {
      staleVariants.push({
        path: variant.path,
        currentBaselineVersion: baseline.version,
        variantBaselineVersion: variant.meta.baselineVersion,
        age: Date.now() - new Date(variant.meta.optimizedAt).getTime()
      });
    }
  }

  return staleVariants;
}
```

### Regeneration Workflow

When variants are stale, regenerate them:

```bash
# Check for stale variants
npx pair-review prompts:check-stale

# Regenerate specific variant
npx pair-review prompts:optimize --provider google --model gemini-pro --tier balanced --type level1

# Regenerate all stale variants for a provider
npx pair-review prompts:optimize --provider google --all-stale

# Validate after regeneration
npx pair-review prompts:validate
```

### CI Integration Suggestions

```yaml
# .github/workflows/prompt-maintenance.yml
name: Prompt Maintenance

on:
  push:
    paths:
      - 'src/ai/prompts/baseline/**'
  schedule:
    - cron: '0 0 * * 0'  # Weekly check

jobs:
  check-staleness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check for stale variants
        run: npx pair-review prompts:check-stale --ci

      - name: Create issue if stale
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: 'Stale prompt variants detected',
              body: 'Baseline prompts have changed. Run regeneration workflow.',
              labels: ['maintenance', 'prompts']
            })

  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate all variants
        run: npx pair-review prompts:validate
```

---

## 12. Adding New Providers

Step-by-step guide for adding a new AI provider.

### Step 1: Define Provider Configuration

```javascript
// src/ai/prompts/config.js

export const providers = {
  // ... existing providers

  'mistral': {
    name: 'Mistral AI',
    models: {
      'mistral-small': { tier: 'fast', contextWindow: 32000 },
      'mistral-medium': { tier: 'balanced', contextWindow: 32000 },
      'mistral-large': { tier: 'thorough', contextWindow: 128000 }
    },
    optimizationModel: 'mistral-large',  // Which model optimizes variants
    apiKeyEnvVar: 'MISTRAL_API_KEY'
  }
};
```

### Step 2: Create Variant Directory

```bash
mkdir -p src/ai/prompts/variants/mistral/{mistral-small,mistral-medium,mistral-large}
```

### Step 3: Generate Initial Variants

Run the optimization workflow for each prompt type and tier combination:

```bash
# Generate all variants for Mistral
for tier in fast balanced thorough; do
  for type in level1 level2 level3 orchestration; do
    npx pair-review prompts:optimize \
      --provider mistral \
      --tier $tier \
      --type $type
  done
done
```

### Step 4: Validate Variants

```bash
npx pair-review prompts:validate --provider mistral
```

### Step 5: Test with Real Reviews

Run integration tests using the new provider:

```bash
npm run test:integration -- --provider mistral
```

### Step 6: Document Provider-Specific Notes

Add any provider-specific considerations to the variant files' meta notes.

---

## 13. Design Principles

### Shared Nothing First

Start with no shared code between providers. Extract common patterns only when clear duplication emerges across multiple providers.

**Rationale:** Premature abstraction leads to rigid architectures. Let patterns emerge naturally before codifying them.

### Output Schemas Are Sacred

The JSON schema for AI outputs is locked across all providers and cannot be modified.

**Rationale:** The frontend and processing pipeline parse AI responses based on this schema. Any inconsistency breaks the entire system.

```javascript
// This schema is LOCKED across all providers
const suggestionSchema = {
  type: 'object',
  required: ['file', 'line', 'type', 'severity', 'message'],
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    side: { enum: ['OLD', 'NEW'] },
    type: { enum: ['issue', 'suggestion', 'praise', 'question'] },
    severity: { enum: ['critical', 'major', 'minor', 'info'] },
    message: { type: 'string' },
    suggestedCode: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
};
```

### AI Generates Text, Not Code

The optimization process produces natural language prompts, not executable code.

**Rationale:**
- Text generation is more reliable than code generation
- Prompts are declarative descriptions of desired behavior
- Reduces risk of injection attacks through prompt content
- Easier to review and validate

### Holistic Optimization

Models optimize the full prompt context, not individual sections.

**Rationale:**
- Section interactions matter (order, flow, emphasis)
- Models understand their own processing patterns
- Global optimization > local optimizations
- Avoids suboptimal section boundaries

### Explicit Over Implicit

Every optimization decision is recorded with rationale.

**Rationale:**
- Enables debugging when variants underperform
- Facilitates learning across providers
- Supports rollback decisions
- Documents institutional knowledge

```javascript
// Good: Explicit removal with reason
"removedSections": {
  "examples": "Few-shot examples cause this model to over-fit to example patterns rather than generalizing"
}

// Bad: Silent removal (would fail validation)
"removedSections": {
  "examples": null
}
```

---

## Appendix: Example Baseline Prompt (Level 1, Balanced)

```xml
<section name="role" required="true">
You are an expert code reviewer analyzing a GitHub pull request.
Your goal is to identify issues, suggest improvements, and highlight
good practices in the changed code.

Focus on being helpful and constructive. Prioritize actionable feedback
over stylistic preferences.
</section>

<section name="constraints" required="true">
Review ONLY the lines that have changed (marked with + or -).
Do not comment on unchanged code unless a change directly impacts it.

Valid files for review:
{{validFiles}}

Ignore:
- Auto-generated files
- Lock files (package-lock.json, yarn.lock, etc.)
- Files not in the valid files list
</section>

<section name="diff-instructions" required="true">
The diff uses unified format:
- Lines starting with `-` are removed (OLD)
- Lines starting with `+` are added (NEW)
- Lines starting with ` ` (space) are context (unchanged)
- `@@` markers indicate line numbers

When reporting issues, specify:
- The file path
- The line number in the NEW version (for additions) or OLD version (for deletions)
- Which side: "OLD" for removed lines, "NEW" for added lines
</section>

<section name="severity-calibration" optional="true" tier="balanced,thorough">
Use these severity levels:
- critical: Will cause runtime errors, security vulnerabilities, or data loss
- major: Significant bugs, performance issues, or maintainability problems
- minor: Code quality issues, missing best practices
- info: Suggestions, observations, or minor improvements
</section>

<section name="praise-guidance" optional="true">
Also identify praiseworthy patterns:
- Clean, readable code
- Good error handling
- Thoughtful edge case coverage
- Performance optimizations
- Excellent documentation

Mark these as type "praise" with severity "info".
</section>

<section name="output-instructions" required="true">
Respond with a JSON object matching the schema below.
Include ONLY valid JSON - no markdown, no explanations, no preamble.
</section>

<section name="output-schema" locked="true">
{{outputSchema}}
</section>

<section name="pr-context" locked="true">
## Pull Request Information
Title: {{prTitle}}
Description: {{prDescription}}
Author: {{prAuthor}}
</section>

<section name="diff-content" locked="true">
## Diff to Review

{{diffContent}}
</section>
```

---

## Appendix: Optimization Meta-Prompt

The prompt used to instruct target models to optimize their variants:

```markdown
You are about to optimize a code review prompt for your own capabilities.
The prompt below is structured with XML-like tags that categorize each section.

## Section Categories

- `locked="true"`: Do NOT modify these sections. Copy them exactly.
- `required="true"`: These must be present but you may rephrase the content.
- `optional="true"`: You may remove these entirely if they don't help your performance.

## Your Task

1. Read the full prompt carefully
2. Consider your own strengths and processing patterns
3. Output an optimized version that:
   - Preserves all locked sections exactly
   - Rephrases required sections if it helps your comprehension
   - Removes optional sections that might confuse you or reduce quality
   - Reorders sections if a different order helps you process better

4. After the optimized prompt, explain your changes in an <optimization-notes> block

## The Prompt to Optimize

[BASELINE PROMPT INSERTED HERE]

---

Output your optimized version maintaining the XML section structure.
```
