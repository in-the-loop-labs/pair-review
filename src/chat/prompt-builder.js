// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Prompt Builder
 *
 * Builds system prompts and initial context for chat sessions.
 * The system prompt is lean (role + review context + instructions).
 * Suggestion context is delivered via the first user message, not the system prompt.
 */

const logger = require('../utils/logger');

/**
 * Build a lean system prompt for chat sessions.
 * Contains only role, review context, and behavioral instructions.
 * @param {Object} options
 * @param {Object} options.review - Review metadata {pr_number, repository, review_type, local_path, name}
 * @returns {string} System prompt for the chat agent
 */
function buildChatPrompt({ review }) {
  const sections = [];

  // Role
  sections.push('You are a code review assistant helping with a code review. You have access to the repository and can explore it using shell commands. Do not modify any files.');

  // Review context
  sections.push(buildReviewContext(review));

  // Instructions
  sections.push(
    'Answer questions about this review, the code changes, and any AI suggestions. ' +
    'Be concise and helpful. Use markdown formatting in your responses.'
  );

  const prompt = sections.join('\n\n');
  logger.debug(`Chat system prompt built: ${prompt.length} chars`);
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
 * Safely parse a reasoning field from the database.
 * Handles null, pre-parsed objects/arrays, valid JSON strings, and malformed JSON.
 * @param {*} reasoning - Raw reasoning value from DB
 * @returns {*} Parsed reasoning or null on failure
 */
function parseReasoning(reasoning) {
  if (!reasoning) return null;
  if (typeof reasoning !== 'string') return reasoning;
  try { return JSON.parse(reasoning); } catch { return null; }
}

/**
 * Format a suggestion DB row into a lean context object for the chat agent.
 * @param {Object} s - Suggestion row from the database
 * @returns {Object} Formatted suggestion
 */
function formatSuggestionForContext(s) {
  return {
    id: s.id,
    file: s.file,
    line_start: s.line_start,
    line_end: s.line_end,
    type: s.type,
    title: s.title,
    body: s.body,
    reasoning: parseReasoning(s.reasoning),
    status: s.status,
    ai_confidence: s.ai_confidence,
    is_file_level: s.is_file_level
  };
}

/**
 * Build initial context to prepend to the first user message.
 * Contains all AI suggestions from the latest analysis run, and optionally
 * highlights a specific suggestion that triggered the chat.
 *
 * @param {Object} options
 * @param {Array} options.suggestions - All AI suggestions from the latest run
 * @param {Object} [options.focusedSuggestion] - The specific suggestion that triggered chat (full DB row)
 * @param {number} [options.port] - The port the pair-review web server is running on
 * @returns {string|null} Context text to prepend to first message, or null if no context
 */
function buildInitialContext({ suggestions, focusedSuggestion, port }) {
  const sections = [];

  if (port) {
    sections.push(`The pair-review web server is running at http://localhost:${port}`);
  }

  if (suggestions && suggestions.length > 0) {
    const formatted = suggestions.map(formatSuggestionForContext);

    const label = formatted.length === 1 ? '1 AI suggestion' : `${formatted.length} AI suggestions`;
    sections.push(
      `Here ${formatted.length === 1 ? 'is' : 'are all'} ${label} from the latest analysis run:\n` +
      '```json\n' + JSON.stringify(formatted, null, 2) + '\n```'
    );
  }

  if (focusedSuggestion) {
    const focused = formatSuggestionForContext(focusedSuggestion);

    sections.push(
      'The user is asking about this specific suggestion:\n' +
      '```json\n' + JSON.stringify(focused, null, 2) + '\n```'
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return sections.join('\n\n');
}

module.exports = { buildChatPrompt, buildInitialContext };
