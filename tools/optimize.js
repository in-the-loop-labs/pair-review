#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prompt Optimization Tool
 *
 * Optimizes baseline prompts for specific target providers using an optimizer model.
 * Uses the tagged section format to preserve locked sections while allowing
 * modifications to required/optional sections.
 *
 * Usage:
 *   node tools/optimize.js --provider gemini --tier fast --prompt level1
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { parseSections, computeDelta } = require('../src/ai/prompts/section-parser');
const { extractJSON } = require('../src/utils/json-extractor');

// Import providers to get model definitions (default exports)
const GeminiProvider = require('../src/ai/gemini-provider');
const ClaudeProvider = require('../src/ai/claude-provider');
const CodexProvider = require('../src/ai/codex-provider');
const CopilotProvider = require('../src/ai/copilot-provider');

/**
 * Provider class mapping
 * Note: 'openai' is kept as an alias for backwards compatibility with existing scripts
 */
const PROVIDER_CLASSES = {
  gemini: GeminiProvider,
  claude: ClaudeProvider,
  codex: CodexProvider,
  copilot: CopilotProvider,
  openai: CopilotProvider  // Backwards-compatible alias for 'copilot'
};

/**
 * Get the model ID for a given provider and tier
 * @param {string} provider - Provider name
 * @param {string} tier - Tier name (fast, balanced, thorough)
 * @returns {string} Model ID
 */
function getModelForTier(provider, tier) {
  const ProviderClass = PROVIDER_CLASSES[provider];
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const models = ProviderClass.getModels();
  const model = models.find(m => m.tier === tier);
  if (!model) {
    throw new Error(`No ${tier} tier model found for provider: ${provider}`);
  }
  return model.id;
}

/**
 * Get the default optimizer model for a provider (thorough tier)
 * @param {string} provider - Provider name
 * @returns {string} Model ID
 */
function getDefaultOptimizerModel(provider) {
  return getModelForTier(provider, 'thorough');
}

/**
 * Valid providers, tiers, and prompt types
 * Note: Both 'copilot' and 'openai' map to CopilotProvider for backwards compatibility
 */
const VALID_PROVIDERS = ['gemini', 'copilot', 'openai', 'claude', 'codex'];
const VALID_TIERS = ['fast', 'balanced', 'thorough'];
const VALID_PROMPTS = ['level1', 'level2', 'level3', 'orchestration'];

/**
 * Compute a short hash of the baseline prompt for staleness detection
 * @param {string} content - The tagged prompt content
 * @returns {string} First 8 characters of SHA-256 hash
 */
function computeBaselineHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    provider: null,
    tier: null,
    prompt: null,
    optimizerModel: null,
    output: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider':
        parsed.provider = args[++i];
        break;
      case '--tier':
        parsed.tier = args[++i];
        break;
      case '--prompt':
        parsed.prompt = args[++i];
        break;
      case '--optimizer-model':
        parsed.optimizerModel = args[++i];
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  return parsed;
}

/**
 * Print usage information
 */
function printUsage() {
  console.log(`
Prompt Optimization Tool

Optimizes baseline prompts for specific target providers.

Usage:
  node tools/optimize.js --provider gemini --tier fast --prompt level1

Options:
  --provider <name>       Provider to optimize for (gemini, copilot, openai, codex, claude)
  --tier <tier>           Tier to optimize (fast, balanced, thorough)
  --prompt <type>         Prompt type (level1, level2, level3, orchestration)
  --optimizer-model <m>   Override optimizer model (default: thorough model for provider)
  --output <path>         Override output path (default: auto-derived)
  --help, -h              Show this help message

Examples:
  node tools/optimize.js --provider gemini --tier fast --prompt level1
  node tools/optimize.js --provider copilot --tier balanced --prompt level2
  node tools/optimize.js --provider codex --tier thorough --prompt level3
  node tools/optimize.js --provider claude --tier fast --prompt orchestration
`);
}

/**
 * Validate required arguments
 * @param {Object} args - Parsed arguments
 */
function validateArgs(args) {
  const errors = [];

  if (!args.provider) {
    errors.push('--provider is required');
  } else if (!VALID_PROVIDERS.includes(args.provider)) {
    errors.push(`Invalid provider: ${args.provider}. Valid: ${VALID_PROVIDERS.join(', ')}`);
  }

  if (!args.tier) {
    errors.push('--tier is required');
  } else if (!VALID_TIERS.includes(args.tier)) {
    errors.push(`Invalid tier: ${args.tier}. Valid: ${VALID_TIERS.join(', ')}`);
  }

  if (!args.prompt) {
    errors.push('--prompt is required');
  } else if (!VALID_PROMPTS.includes(args.prompt)) {
    errors.push(`Invalid prompt: ${args.prompt}. Valid: ${VALID_PROMPTS.join(', ')}`);
  }

  if (errors.length > 0) {
    console.error(`Error: ${errors.join('; ')}`);
    printUsage();
    process.exit(1);
  }
}

/**
 * Derive paths and models from arguments
 * @param {Object} args - Parsed arguments
 * @returns {Object} Derived configuration
 */
function deriveConfig(args) {
  // Baseline path: src/ai/prompts/baseline/{prompt}/{tier}.js
  const baselinePath = path.join(
    __dirname,
    '../src/ai/prompts/baseline',
    args.prompt,
    `${args.tier}.js`
  );

  // Verify baseline file exists
  if (!fs.existsSync(baselinePath)) {
    console.error(`Error: Baseline file not found: ${baselinePath}`);
    process.exit(1);
  }

  // Output path: src/ai/prompts/variants/{provider}/{prompt}/{tier}.json
  const outputPath = args.output || path.join(
    __dirname,
    '../src/ai/prompts/variants',
    args.provider,
    args.prompt,
    `${args.tier}.json`
  );

  // Optimizer model (default: thorough tier model for provider)
  const optimizerModel = args.optimizerModel || getDefaultOptimizerModel(args.provider);

  // Target model for optimization (the model this variant is optimized FOR)
  const targetModel = getModelForTier(args.provider, args.tier);

  return {
    baselinePath,
    outputPath,
    optimizerModel,
    targetModel,
    baselineId: `${args.prompt}/${args.tier}`
  };
}

/**
 * Load and extract taggedPrompt from baseline file
 * @param {string} baselinePath - Path to baseline prompt file
 * @returns {Object} Baseline module with taggedPrompt
 */
function loadBaseline(baselinePath) {
  try {
    const baseline = require(baselinePath);

    if (!baseline.taggedPrompt) {
      console.error('Error: Baseline file does not export taggedPrompt');
      process.exit(1);
    }

    return baseline;
  } catch (error) {
    console.error(`Error loading baseline file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Build the optimization prompt for the optimizer model
 * @param {string} taggedPrompt - The baseline tagged prompt
 * @param {string} targetModel - Model to optimize for
 * @returns {string} Optimization prompt
 */
function buildOptimizationPrompt(taggedPrompt, targetModel) {
  return `You are a prompt optimization expert. Your task is to optimize the following tagged prompt template for the "${targetModel}" model.

## Tagged Section Format

The prompt uses XML-like section tags with metadata attributes:

- \`<section name="..." locked="true">\`: LOCKED sections contain data placeholders or critical schema definitions. You MUST preserve these EXACTLY as-is, including all whitespace and formatting. Do not modify locked sections in any way.

- \`<section name="..." required="true">\`: REQUIRED sections must be present in the output. You may rephrase, restructure, or improve the content while preserving the core meaning and functionality.

- \`<section name="..." optional="true">\`: OPTIONAL sections can be removed entirely if they add overhead without providing value for the target model.

## Target Model: ${targetModel}

Consider the following model-specific optimization strategies:

### If targeting a "fast" or "flash" model (e.g., gemini-3-flash-preview, gpt-4o-mini):
- Use direct, imperative language
- Minimize verbose explanations
- Front-load critical instructions
- Remove redundant guidance
- Keep examples minimal but clear
- Prefer lists over prose

### If targeting a "pro" or larger model (e.g., gemini-3-pro-preview, gpt-4o, claude-sonnet):
- Can handle more nuanced instructions
- Benefits from context and rationale
- Can process longer prompts efficiently
- May benefit from explicit confidence calibration

### General optimization principles:
- Place the most critical constraints early (output format, locked requirements)
- Group related instructions together
- Eliminate redundancy between sections
- Use emphasis markers (**CRITICAL**, **IMPORTANT**) sparingly but effectively
- Ensure instructions are unambiguous

## Your Task

1. Analyze the baseline prompt below
2. Identify optimization opportunities for ${targetModel}
3. Preserve ALL locked sections exactly
4. Modify required sections to be clearer/more effective for this model
5. Decide whether to keep or remove optional sections
6. Consider reordering sections for better processing

## Output Format

Return a JSON object with this exact structure:

{
  "optimizedPrompt": "The full optimized prompt with all section tags preserved",
  "changes": [
    {
      "section": "section-name",
      "type": "modified|reordered|removed|unchanged",
      "rationale": "Brief explanation of why this change helps for ${targetModel}"
    }
  ]
}

**CRITICAL OUTPUT REQUIREMENTS:**
- Output ONLY the raw JSON object. Start your response with { and end with }
- Do NOT wrap the JSON in markdown code blocks (no \`\`\`json or \`\`\`)
- Do NOT include any explanatory text before or after the JSON
- The optimizedPrompt must include all section tags (locked, required, kept optional)
- Include a change entry for EVERY section, even if unchanged
- Locked sections should always have type: "unchanged"

## Baseline Prompt to Optimize

${taggedPrompt}`;
}

/**
 * Execute the Gemini CLI and return the result
 *
 * Note: This tool intentionally does NOT use GeminiProvider because:
 * 1. optimize.js is a development tool, not production code
 * 2. It doesn't need tool restrictions (--allowed-tools) since we want
 *    the model to focus on prompt optimization, not code exploration
 * 3. It doesn't need cancellation support or complex timeout handling
 * 4. The simpler interface is easier to debug during development
 *
 * It DOES use the shared extractJSON utility for robust JSON parsing.
 *
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object>} Parsed JSON response
 */
function executeGeminiCli(model, prompt) {
  return new Promise((resolve, reject) => {
    const gemini = spawn('gemini', ['-m', model, '-o', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gemini.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gemini.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gemini.on('error', (error) => {
      reject(new Error(`Failed to spawn gemini CLI: ${error.message}`));
    });

    gemini.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Gemini CLI with -o json returns wrapper: { session_id, response, stats }
        // The actual AI response is in the 'response' field
        const wrapper = JSON.parse(stdout);

        let responseText;
        if (wrapper.response) {
          responseText = wrapper.response;
        } else {
          // Fallback if not wrapped
          responseText = stdout;
        }

        // Use shared extractJSON utility for robust parsing
        const extracted = extractJSON(responseText, 'optimize');
        if (extracted.success) {
          resolve(extracted.data);
        } else {
          reject(new Error(`Failed to extract JSON from response: ${extracted.error}\nRaw output: ${responseText.substring(0, 1000)}`));
        }
      } catch (parseError) {
        // If parsing fails, include raw output in error
        reject(new Error(`Failed to parse Gemini response as JSON: ${parseError.message}\nRaw output: ${stdout.substring(0, 1000)}`));
      }
    });

    // Send prompt to stdin
    gemini.stdin.write(prompt);
    gemini.stdin.end();
  });
}

/**
 * Execute the Codex CLI and return the result
 *
 * Uses `codex exec` command with JSONL output format.
 * Parses the JSONL response to extract the agent_message content.
 *
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object>} Parsed JSON response
 */
function executeCodexCli(model, prompt) {
  return new Promise((resolve, reject) => {
    const codex = spawn('codex', ['exec', '-m', model, '--json', '--sandbox', 'workspace-write', '--full-auto', '-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    codex.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    codex.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    codex.on('error', (error) => {
      reject(new Error(`Failed to spawn codex CLI: ${error.message}`));
    });

    codex.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Codex outputs JSONL - parse lines to find agent_message
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        let agentMessage = null;

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            // Look for agent_message items which contain the actual response
            if (event.type === 'item.completed' &&
                event.item?.type === 'agent_message' &&
                event.item?.text) {
              agentMessage = event.item.text;
            }
          } catch (lineError) {
            // Skip malformed lines
          }
        }

        if (agentMessage) {
          // Use shared extractJSON utility for robust parsing
          const extracted = extractJSON(agentMessage, 'optimize');
          if (extracted.success) {
            resolve(extracted.data);
          } else {
            reject(new Error(`Failed to extract JSON from Codex response: ${extracted.error}\nRaw output: ${agentMessage.substring(0, 1000)}`));
          }
        } else {
          // No agent message found, try extracting JSON directly from stdout
          const extracted = extractJSON(stdout, 'optimize');
          if (extracted.success) {
            resolve(extracted.data);
          } else {
            reject(new Error(`Failed to extract JSON from Codex response: ${extracted.error}\nRaw output: ${stdout.substring(0, 1000)}`));
          }
        }
      } catch (parseError) {
        reject(new Error(`Failed to parse Codex response: ${parseError.message}\nRaw output: ${stdout.substring(0, 1000)}`));
      }
    });

    // Send prompt to stdin
    codex.stdin.write(prompt);
    codex.stdin.end();
  });
}

/**
 * Execute the Copilot CLI and return the result
 *
 * Uses `copilot --model MODEL -s -p PROMPT` format.
 * The -s flag enables silent mode (only agent response, no stats).
 *
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object>} Parsed JSON response
 */
function executeCopilotCli(model, prompt) {
  return new Promise((resolve, reject) => {
    // Build args: --model X -s -p <prompt>
    const copilot = spawn('copilot', ['--model', model, '-s', '-p', prompt], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    copilot.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    copilot.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    copilot.on('error', (error) => {
      reject(new Error(`Failed to spawn copilot CLI: ${error.message}`));
    });

    copilot.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Copilot CLI exited with code ${code}: ${stderr}`));
        return;
      }

      // Copilot with -s outputs direct text response
      // Use shared extractJSON utility for robust parsing
      const extracted = extractJSON(stdout, 'optimize');
      if (extracted.success) {
        resolve(extracted.data);
      } else {
        reject(new Error(`Failed to extract JSON from Copilot response: ${extracted.error}\nRaw output: ${stdout.substring(0, 1000)}`));
      }
    });

    // Copilot uses -p flag for prompt, not stdin
    // stdin is not used, but we should close it
    copilot.stdin.end();
  });
}

/**
 * Execute the Claude CLI and return the result
 *
 * Uses `claude -p -m MODEL --output-format json` format.
 * The -p flag enables print mode (non-interactive).
 *
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object>} Parsed JSON response
 */
function executeClaudeCli(model, prompt) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', '-m', model, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('error', (error) => {
      reject(new Error(`Failed to spawn claude CLI: ${error.message}`));
    });

    claude.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Claude with --output-format json returns structured response
        // The response format is { result: "...", ... }
        const wrapper = JSON.parse(stdout);

        let responseText;
        if (wrapper.result) {
          responseText = wrapper.result;
        } else {
          // Fallback if not wrapped
          responseText = stdout;
        }

        // Use shared extractJSON utility for robust parsing
        const extracted = extractJSON(responseText, 'optimize');
        if (extracted.success) {
          resolve(extracted.data);
        } else {
          reject(new Error(`Failed to extract JSON from Claude response: ${extracted.error}\nRaw output: ${responseText.substring(0, 1000)}`));
        }
      } catch (parseError) {
        // If parsing fails, try extracting JSON directly
        const extracted = extractJSON(stdout, 'optimize');
        if (extracted.success) {
          resolve(extracted.data);
        } else {
          reject(new Error(`Failed to parse Claude response as JSON: ${parseError.message}\nRaw output: ${stdout.substring(0, 1000)}`));
        }
      }
    });

    // Send prompt to stdin
    claude.stdin.write(prompt);
    claude.stdin.end();
  });
}

/**
 * Dispatch to the appropriate provider CLI executor
 *
 * @param {string} provider - Provider name (gemini, codex, copilot, openai, claude)
 * @param {string} model - Model to use
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object>} Parsed JSON response
 */
async function executeProviderCli(provider, model, prompt) {
  switch (provider) {
    case 'gemini':
      return executeGeminiCli(model, prompt);
    case 'codex':
      return executeCodexCli(model, prompt);
    case 'copilot':
    case 'openai':
      return executeCopilotCli(model, prompt);
    case 'claude':
      return executeClaudeCli(model, prompt);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Ensure output directory exists
 * @param {string} outputPath - Output file path
 */
function ensureOutputDir(outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs();
  validateArgs(args);

  const config = deriveConfig(args);

  console.error(`Loading baseline prompt from: ${config.baselinePath}`);
  const baseline = loadBaseline(config.baselinePath);

  console.error(`Building optimization prompt for target model: ${config.targetModel}`);
  const optimizationPrompt = buildOptimizationPrompt(baseline.taggedPrompt, config.targetModel);

  console.error(`Calling optimizer model: ${config.optimizerModel}`);
  console.error('This may take a moment...');

  let optimizerResult;
  try {
    optimizerResult = await executeProviderCli(args.provider, config.optimizerModel, optimizationPrompt);
  } catch (error) {
    console.error(`Error calling optimizer model: ${error.message}`);
    process.exit(1);
  }

  // Compute delta between baseline and optimized prompts
  const baselineHash = computeBaselineHash(baseline.taggedPrompt);
  let delta;
  try {
    delta = computeDelta(baseline.taggedPrompt, optimizerResult.optimizedPrompt);
  } catch (error) {
    console.error(`Error computing delta: ${error.message}`);
    process.exit(1);
  }

  // Build the final output structure with delta format
  const output = {
    meta: {
      baseline: config.baselineId,
      baselineHash: baselineHash,
      targetModel: config.targetModel,
      optimizerModel: config.optimizerModel,
      timestamp: new Date().toISOString()
    },
    delta: {
      sectionOrder: delta.sectionOrder,
      overrides: delta.overrides,
      removedSections: delta.removedSections,
      addedSections: delta.addedSections
    },
    changes: optimizerResult.changes || []
  };

  // Format as pretty JSON
  const outputJson = JSON.stringify(output, null, 2);

  // Ensure output directory exists and write file
  ensureOutputDir(config.outputPath);
  fs.writeFileSync(config.outputPath, outputJson, 'utf-8');
  console.error(`Optimized prompt written to: ${config.outputPath}`);

  console.error('Optimization complete.');
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
