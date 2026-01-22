// SPDX-License-Identifier: GPL-3.0-or-later
const logger = require('./logger');

/**
 * Extract JSON from text responses using multiple strategies
 * This is a shared utility to ensure consistent JSON extraction across the application
 * @param {string} response - Raw response text
 * @param {string|number} level - Level identifier for logging (e.g., 1, 2, 3, 'orchestration', 'unknown')
 * @returns {Object} Extraction result with success flag and data/error
 */
function extractJSON(response, level = 'unknown') {
  const levelPrefix = `[Level ${level}]`;

  if (!response || !response.trim()) {
    return { success: false, error: 'Empty response' };
  }

  const strategies = [
    // Strategy 1: Look for markdown code blocks with 'json' label
    () => {
      // First, try to find ```json specifically (more precise)
      let codeBlockMatch = response.match(/```json\s*\n([\s\S]*?)\n```/);

      // If not found, try generic ``` blocks
      if (!codeBlockMatch) {
        codeBlockMatch = response.match(/```\s*\n([\s\S]*?)\n```/);
      }

      if (codeBlockMatch && codeBlockMatch[1]) {
        const content = codeBlockMatch[1].trim();
        // Verify it looks like JSON before parsing
        if (content.startsWith('{') && content.endsWith('}')) {
          return JSON.parse(content);
        }
      }
      throw new Error('No JSON code block found');
    },
    
    // Strategy 2: Look for JSON between first { and last }
    () => {
      const firstBrace = response.indexOf('{');
      const lastBrace = response.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        return JSON.parse(response.substring(firstBrace, lastBrace + 1));
      }
      throw new Error('No valid JSON braces found');
    },
    
    // Strategy 3: Try to find JSON-like structure with bracket matching
    () => {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Try to find the complete JSON by matching brackets
        const jsonStr = jsonMatch[0];
        let braceCount = 0;
        let endIndex = -1;
        const maxIterations = Math.min(jsonStr.length, 100000); // Prevent infinite loops
        
        for (let i = 0; i < maxIterations; i++) {
          if (jsonStr[i] === '{') braceCount++;
          else if (jsonStr[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIndex = i;
              break;
            }
          }
        }
        
        if (endIndex > -1) {
          return JSON.parse(jsonStr.substring(0, endIndex + 1));
        }
      }
      throw new Error('No balanced JSON structure found');
    },
    
    // Strategy 4: Try the entire response as JSON (for simple cases)
    () => {
      return JSON.parse(response.trim());
    }
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      const data = strategies[i]();
      if (data && typeof data === 'object') {
        logger.info(`${levelPrefix} JSON extraction successful using strategy ${i + 1}`);
        return { success: true, data };
      }
    } catch (error) {
      // Continue to next strategy
      if (i === strategies.length - 1) {
        // Last strategy failed, log the error
        logger.warn(`${levelPrefix} All JSON extraction strategies failed`);
        logger.warn(`${levelPrefix} Response preview: ${response.substring(0, 200)}...`);
      }
    }
  }

  return { 
    success: false, 
    error: 'Failed to extract JSON from response',
    response: response.substring(0, 500) // Include preview for debugging
  };
}

module.exports = { extractJSON };