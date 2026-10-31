// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Valid files section - shared across prompt types
 *
 * This section defines which files are eligible for review suggestions.
 * It is LOCKED and cannot be modified by variants.
 */

/**
 * Section definition for valid files
 */
const validFilesSection = {
  name: 'valid-files',
  locked: true,
  content: `## Valid Files for Suggestions
You should ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.`
};

/**
 * Changed files section for Level 3.
 *
 * Level 3 analyzes the changes in the context of the whole codebase, so,
 * unlike Level 1 and Level 2, it may place findings in files outside the
 * changed-file list. The Level 3 baseline templates embed this exact text
 * (tests keep them in sync); the legacy Level 3 prompt uses it directly.
 */
const level3ChangedFilesSection = {
  name: 'changed-files',
  locked: true,
  content: `## Changed Files
These files are changed in this review:
{{changedFiles}}

Start your analysis from these files. You may also create suggestions for files that are not in this list, when the codebase context shows a real issue in that file. For example: a caller in another file that still passes the old arguments to a function these changes modified.

A suggestion for a file that is not in this list must:
- Use the real path of a file that exists in the repository, relative to the repository root. Do not guess or invent a path.
- Use the line numbers of that file as it is now, with "old_or_new": "NEW".

Do not create suggestions for files that are not in this list about problems that have nothing to do with these changes.`
};

/**
 * Format the valid files list for insertion into prompt
 * @param {Array<string>} files - List of file paths
 * @returns {string} Formatted file list
 */
function formatValidFiles(files) {
  if (!files || files.length === 0) {
    return '(No files specified)';
  }
  return files.map(f => `- ${f}`).join('\n');
}

/**
 * Build the full Level 3 changed files section (heading, list and guidance)
 * @param {Array<string>} files - List of changed file paths
 * @returns {string} Formatted section
 */
function formatLevel3ChangedFilesSection(files) {
  return level3ChangedFilesSection.content.replace('{{changedFiles}}', () => formatValidFiles(files));
}

module.exports = {
  validFilesSection,
  level3ChangedFilesSection,
  formatValidFiles,
  formatLevel3ChangedFilesSection
};
