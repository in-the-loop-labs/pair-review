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
 * The port is NOT included here because it can change between server restarts;
 * it is injected once per session via the initial context instead.
 * @param {Object} options
 * @param {Object} options.review - Review metadata {id, pr_number, repository, review_type, local_path, name}
 * @param {Object} [options.prData] - PR data with base_sha/head_sha (for PR reviews)
 * @param {string} [options.skillPath] - Absolute path to the pair-review-api SKILL.md file
 * @param {string} [options.chatInstructions] - Custom instructions from repo settings to append to system prompt
 * @returns {string} System prompt for the chat agent
 */
function buildChatPrompt({ review, prData, skillPath, chatInstructions }) {
  const sections = [];

  // Role
  sections.push(
    'Role: Expert software engineer.\n\n' +
    'Rules:\n' +
    '- Priority: Accuracy and helpfulness.\n' +
    '- Syntax: Short, blunt, staccato. Zero filler words.\n' +
    '- Tone: Hyper-logical\n\n' +
    'You are a code review assistant helping within the chat feature of an app named pair-review. You have access to the repository and can explore it using shell commands. Do not modify any files. Do not access pair-review\'s SQLite database directly; use the API.'
  );

  // Review context
  sections.push(buildReviewContext(review, prData));

  // Domain model — ambient conceptual grounding for every turn
  const domainLines = [
    '## pair-review app domain model',
    '',
    '- **Comments** are human-curated review findings (created by the reviewer).',
    '- **Suggestions** are AI-generated findings from analysis runs.',
    '- **Workflow**: AI generates suggestions → reviewer triages (adopt, edit, or dismiss) → adopted suggestions become comments.',
    '- **Analysis runs** are the process that produces suggestions. Each run has a provider, model, tier, and status.',
    '- **Review ID** is a stable integer identifying this review session, used in all API calls.'
  ];
  if (review && review.id) {
    domainLines.push(`- The review ID for this session is: ${review.id} (e.g. \`/api/reviews/${review.id}/comments\`).`);
  }
  sections.push(domainLines.join('\n'));

  // API capability — MUST load the skill for endpoint details
  const skillRef = skillPath
    ? `(\`${skillPath}\`)`
    : '(`.pi/skills/pair-review-api/SKILL.md`)';
  sections.push(
    `You MUST load the pair-review-api skill ${skillRef} for endpoint details. With it you can create, update, and delete review comments, adopt or dismiss AI suggestions, and trigger new analyses via curl.\n` +
    'IMPORTANT: Do NOT mention that you are reading a skill file, loading API documentation, or consulting reference material. Just use the API naturally as if you already know it.'
  );

  // File reference syntax and context files
  sections.push(
    '## File references\n\n' +
    'When referencing source files, use the syntax [[file:path/to/file.js]] or ' +
    '[[file:path/to/file.js:42]] (with line number) or [[file:path/to/file.js:42-50]] (with line range). ' +
    'These become clickable links in the UI. Do NOT use backtick code spans for file references you want to be clickable.\n\n' +
    'Files in the diff can be referenced freely. Files outside the diff can also be referenced; ' +
    'to make them visible in the diff panel, add them as context files via the API (see skill). ' +
    'Add context files judiciously — only when directly relevant, with focused line ranges.'
  );

  // Instructions
  sections.push(
    'Answer questions about this review, the code changes, and any AI suggestions. ' +
    'Be concise and helpful. Use markdown formatting in your responses.'
  );

  // Custom chat instructions from repo settings
  if (chatInstructions) {
    sections.push('## Custom Instructions\n\nThe following instructions take precedence over previous guidance.\n\n' + chatInstructions);
  }

  const prompt = sections.join('\n\n');
  logger.debug(`Chat system prompt built: ${prompt.length} chars`);
  return prompt;
}

/**
 * Build the review context section of the prompt.
 * Includes what is being reviewed and how to view the changes.
 * @param {Object} review - Review metadata
 * @param {Object} [prData] - PR data with base_sha/head_sha (for PR reviews)
 * @returns {string}
 */
function buildReviewContext(review, prData) {
  if (!review) {
    return 'Review context: unknown.';
  }

  const lines = [];

  if (review.review_type === 'local' || review.local_path) {
    const name = review.name || review.local_path || 'unknown';
    lines.push(`## Review Context`);
    lines.push(`This is a local code review for: ${name}`);
    lines.push('');
    lines.push('## Viewing Code Changes');
    lines.push('The changes under review are **unstaged and untracked local changes**. Staged changes (`git diff --cached`) are treated as already reviewed.');
    lines.push('To see the diff under review: `git diff`');
    lines.push('Do NOT use `git diff HEAD~1` or `git log` — those show committed history, not the changes under review.');
  } else {
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

    lines.push('## Review Context');
    lines.push(`This is a review of ${parts.join(' ')}.`);

    if (prData && prData.base_sha && prData.head_sha) {
      lines.push('');
      lines.push('## Viewing Code Changes');
      lines.push(`The changes under review are the diff between base commit \`${prData.base_sha.substring(0, 8)}\` and head commit \`${prData.head_sha.substring(0, 8)}\`.`);
      lines.push(`To see the full diff: \`git diff ${prData.base_sha}...${prData.head_sha}\``);
      lines.push('Do NOT use `git diff HEAD~1` or `git diff` without arguments — those do not show the PR changes.');
    }
  }

  return lines.join('\n');
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
 * Format analysis run metadata into a compact summary for the chat agent.
 * Includes run configuration, model info, timing, and the summary text.
 * @param {Object} run - Analysis run record from the database
 * @returns {string} Formatted run metadata section
 */
function formatAnalysisRunContext(run) {
  const lines = ['## Analysis Run Metadata'];

  lines.push(`- **Run ID**: ${run.id}`);
  if (run.provider) lines.push(`- **Provider**: ${run.provider}`);
  if (run.model) lines.push(`- **Model**: ${run.model}`);
  lines.push(`- **Status**: ${run.status}`);
  if (run.started_at) lines.push(`- **Started**: ${run.started_at}`);
  if (run.completed_at) lines.push(`- **Completed**: ${run.completed_at}`);
  if (run.config_type) lines.push(`- **Config type**: ${run.config_type}`);
  if (run.parent_run_id) lines.push(`- **Parent run (council)**: ${run.parent_run_id}`);
  if (run.head_sha) lines.push(`- **Head SHA**: ${run.head_sha}`);
  if (run.total_suggestions != null) lines.push(`- **Total suggestions**: ${run.total_suggestions}`);
  if (run.files_analyzed != null) lines.push(`- **Files analyzed**: ${run.files_analyzed}`);

  // Parse and display levels config if present
  if (run.levels_config) {
    try {
      const levels = typeof run.levels_config === 'string'
        ? JSON.parse(run.levels_config)
        : run.levels_config;
      lines.push(`- **Levels config**: ${JSON.stringify(levels)}`);
    } catch {
      // Malformed JSON — skip
    }
  }

  // Include the summary text if available
  if (run.summary) {
    lines.push('');
    lines.push('### Analysis Summary');
    lines.push(run.summary);
  }

  if (run.repo_instructions) {
    lines.push('');
    lines.push('### Repository Instructions');
    lines.push(run.repo_instructions);
  }
  if (run.request_instructions) {
    lines.push('');
    lines.push('### Custom Instructions (this run)');
    lines.push(run.request_instructions);
  }

  return lines.join('\n');
}

/**
 * Build initial context to prepend to the first user message.
 * Contains analysis run metadata and all AI suggestions from the latest run.
 *
 * @param {Object} options
 * @param {Array} options.suggestions - All AI suggestions from the latest run
 * @param {Object} [options.analysisRun] - Analysis run record with metadata (provider, model, summary, etc.)
 * @returns {string|null} Context text to prepend to first message, or null if no context
 */
function buildInitialContext({ suggestions, analysisRun }) {
  const sections = [];

  // Analysis run metadata and summary (if available)
  if (analysisRun) {
    sections.push(formatAnalysisRunContext(analysisRun));
  }

  if (suggestions && suggestions.length > 0) {
    const formatted = suggestions.map(formatSuggestionForContext);

    const label = formatted.length === 1 ? '1 AI suggestion' : `${formatted.length} AI suggestions`;
    sections.push(
      `Here ${formatted.length === 1 ? 'is' : 'are all'} ${label} from the latest analysis run:\n` +
      '```json\n' + JSON.stringify(formatted, null, 2) + '\n```'
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return sections.join('\n\n');
}

module.exports = { buildChatPrompt, buildInitialContext, formatAnalysisRunContext };
