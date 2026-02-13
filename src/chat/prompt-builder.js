// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Prompt Builder
 *
 * Builds system prompts for chat sessions with contextual review information.
 * The prompt gives the chat agent enough context about the review, any focused
 * suggestion, and the relevant diff to answer questions helpfully.
 */

const logger = require('../utils/logger');

const MAX_DIFF_LENGTH = 10000;

/**
 * Build a system prompt for chat sessions with contextual review information.
 * @param {Object} options
 * @param {Object} options.review - Review metadata {pr_number, repository, review_type, local_path, name}
 * @param {Object} [options.suggestion] - Optional suggestion context {title, body, reasoning, type, file, line_start, line_end}
 * @param {string} [options.diff] - Relevant diff context for the file(s)
 * @param {Object} [options.analysisRun] - Optional analysis run summary {provider, model, summary, total_suggestions}
 * @returns {string} System prompt for the chat agent
 */
function buildChatPrompt({ review, suggestion, diff, analysisRun }) {
  const sections = [];

  // Role
  sections.push('You are a code review assistant helping with a code review.');

  // Review context
  sections.push(buildReviewContext(review));

  // Analysis run summary
  if (analysisRun) {
    sections.push(buildAnalysisContext(analysisRun));
  }

  // Suggestion context
  if (suggestion) {
    sections.push(buildSuggestionContext(suggestion));
  }

  // Diff context
  if (diff) {
    sections.push(buildDiffContext(diff));
  }

  // Instructions
  sections.push(
    'Answer questions about this review, the code changes, and any suggestions. ' +
    'You have read-only access to the repository. Be concise and helpful.'
  );

  // Formatting
  sections.push('Use markdown formatting in your responses.');

  const prompt = sections.join('\n\n');
  logger.debug(`Chat prompt built: ${prompt.length} chars`);
  return prompt;
}

/**
 * Build the review context section of the prompt.
 * @param {Object} review - Review metadata
 * @returns {string}
 */
function buildReviewContext(review) {
  if (!review) {
    return 'Review context: unknown.';
  }

  if (review.review_type === 'local' || review.local_path) {
    const name = review.name || review.local_path || 'unknown';
    return `This is a local code review for: ${name}`;
  }

  const parts = [];
  if (review.repository) {
    parts.push(review.repository);
  }
  if (review.pr_number) {
    parts.push(`PR #${review.pr_number}`);
  }
  if (parts.length === 0) {
    return 'Review context: unknown.';
  }
  return `This is a review of ${parts.join(' ')}.`;
}

/**
 * Build the analysis run summary section.
 * @param {Object} analysisRun - Analysis run metadata
 * @returns {string}
 */
function buildAnalysisContext(analysisRun) {
  const parts = ['An AI analysis has been run on this review.'];
  if (analysisRun.provider || analysisRun.model) {
    const model = [analysisRun.provider, analysisRun.model].filter(Boolean).join('/');
    parts.push(`Model: ${model}.`);
  }
  if (analysisRun.total_suggestions != null) {
    parts.push(`Total suggestions: ${analysisRun.total_suggestions}.`);
  }
  if (analysisRun.summary) {
    parts.push(`Summary: ${analysisRun.summary}`);
  }
  return parts.join(' ');
}

/**
 * Build the suggestion context section.
 * @param {Object} suggestion - Suggestion details
 * @returns {string}
 */
function buildSuggestionContext(suggestion) {
  const lines = ['The user is asking about this specific suggestion:'];

  if (suggestion.title) {
    lines.push(`Title: ${suggestion.title}`);
  }
  if (suggestion.type) {
    lines.push(`Type: ${suggestion.type}`);
  }
  if (suggestion.file) {
    let location = `File: ${suggestion.file}`;
    if (suggestion.line_start != null) {
      location += suggestion.line_end != null && suggestion.line_end !== suggestion.line_start
        ? ` (lines ${suggestion.line_start}-${suggestion.line_end})`
        : ` (line ${suggestion.line_start})`;
    }
    lines.push(location);
  }
  if (suggestion.body) {
    lines.push(`\nDescription:\n${suggestion.body}`);
  }
  if (Array.isArray(suggestion.reasoning) && suggestion.reasoning.length > 0) {
    lines.push(`\nReasoning:\n${suggestion.reasoning.map((step, i) => `${i + 1}. ${step}`).join('\n')}`);
  }

  return lines.join('\n');
}

/**
 * Build the diff context section, truncating if necessary.
 * @param {string} diff - Raw diff text
 * @returns {string}
 */
function buildDiffContext(diff) {
  if (!diff || diff.length === 0) {
    return '';
  }

  let diffContent = diff;
  if (diff.length > MAX_DIFF_LENGTH) {
    const half = Math.floor(MAX_DIFF_LENGTH / 2);
    const head = diff.substring(0, half);
    const tail = diff.substring(diff.length - half);
    const omitted = diff.length - MAX_DIFF_LENGTH;
    diffContent = `${head}\n\n... (${omitted} characters omitted) ...\n\n${tail}`;
    logger.debug(`Chat diff truncated from ${diff.length} to ~${MAX_DIFF_LENGTH} chars`);
  }

  return `Relevant diff:\n\`\`\`diff\n${diffContent}\n\`\`\``;
}

module.exports = { buildChatPrompt };
