// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render prompts for use in the agent-analyze skill.
 *
 * Provides skill-appropriate defaults for every placeholder so the
 * resulting text can be used directly as Task-agent instructions,
 * without the runtime context (PR metadata, file lists, etc.) that
 * the pair-review server normally injects.
 */

const { getPromptBuilder } = require('./index');
const {
  buildAnalysisLineNumberGuidance,
  buildOrchestrationLineNumberGuidance,
} = require('./line-number-guidance');

/**
 * Skill-appropriate default values for prompt placeholders.
 *
 * "Data marker" defaults use bracketed descriptions so the orchestrating
 * agent knows it must supply the real value at invocation time.
 * "Instructional defaults" provide generic but sensible guidance.
 */

const SKILL_DEFAULTS = {
  // Instructional defaults
  reviewIntro:
    'You are an expert code reviewer performing a thorough code review.',
  lineNumberGuidance: buildAnalysisLineNumberGuidance(),
  testingGuidance:
    'Consider whether tests are missing or need updating for the changes',

  // Data markers — the orchestrating agent fills these in
  prContext:
    '[The orchestrating agent will provide PR/change context: title, description, author, changed files]',
  validFiles:
    '[Changed files list provided by the orchestrating agent]',
  changedFiles:
    '[Changed files list provided by the orchestrating agent]',

  // Orchestration data markers
  level1Count: '[N]',
  level2Count: '[N]',
  level3Count: '[N]',
  level1Suggestions: '[Level 1 suggestions JSON array]',
  level2Suggestions: '[Level 2 suggestions JSON array]',
  level3Suggestions: '[Level 3 suggestions JSON array]',

  // Collapse when empty
  generatedFiles: '',
  customInstructions: '',
};

/**
 * Render a prompt for skill consumption.
 *
 * @param {string} promptType - One of: level1, level2, level3, orchestration
 * @param {string} tier       - One of: fast, balanced, thorough
 * @param {Object} [options]
 * @param {string} [options.customInstructions] - Repo/user-specific review instructions
 * @returns {string} Rendered plain-text prompt (no XML section tags)
 * @throws {Error} If promptType or tier is invalid
 */
function renderPromptForSkill(promptType, tier, options = {}) {
  const builder = getPromptBuilder(promptType, tier);

  if (!builder) {
    throw new Error(
      `No prompt available for type="${promptType}", tier="${tier}"`
    );
  }

  const context = {
    ...SKILL_DEFAULTS,
  };

  // Orchestration gets lighter-weight line number guidance — it curates
  // pre-computed suggestions rather than re-analyzing diffs.
  if (promptType === 'orchestration') {
    context.lineNumberGuidance = buildOrchestrationLineNumberGuidance();
  }

  // Overlay custom instructions when provided
  if (options.customInstructions) {
    context.customInstructions = `## Custom Review Instructions\n${options.customInstructions}`;
  }

  return builder.build(context);
}

module.exports = { renderPromptForSkill };
