// SPDX-License-Identifier: GPL-3.0-or-later
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

module.exports = {
  validFilesSection,
  formatValidFiles
};
