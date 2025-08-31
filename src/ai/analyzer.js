const ClaudeCLI = require('./claude-cli');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

class Analyzer {
  constructor(database) {
    this.claude = new ClaudeCLI();
    this.db = database;
  }

  /**
   * Perform Level 1 analysis on a PR
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel1(prId, worktreePath) {
    const runId = uuidv4();
    console.log(`[AI] Starting Level 1 analysis for PR #${prId} (run: ${runId})`);
    
    try {
      // Build the Level 1 prompt
      const prompt = this.buildLevel1Prompt(prId, worktreePath);
      
      // Execute Claude CLI in the worktree directory
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 120000 // 2 minutes for Level 1
      });

      // Parse and validate the response
      const suggestions = this.parseResponse(response, 1);
      
      // Store suggestions in database
      await this.storeSuggestions(prId, runId, suggestions, 1);
      
      console.log(`[AI] Level 1 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 1,
        suggestions,
        summary: response.summary || `Found ${suggestions.length} suggestions`
      };
    } catch (error) {
      console.error('[AI] Level 1 analysis failed:', error);
      throw error;
    }
  }

  /**
   * Build the Level 1 prompt
   */
  buildLevel1Prompt(prId, worktreePath) {
    return `You are reviewing pull request #${prId} in the worktree at ${worktreePath}.

Perform a Level 1 review focusing ONLY on the changes in the diff:
- Review the git diff to understand what changed
- Identify bugs or errors in the modified code
- Find logic issues in the changes
- Highlight security concerns
- Recognize good practices worth praising

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}

Focus only on the changed lines. Do not review unchanged code or missing tests (that's for Level 3).`;
  }

  /**
   * Parse Claude's response into structured suggestions
   */
  parseResponse(response, level) {
    // If response is already parsed JSON
    if (response.suggestions && Array.isArray(response.suggestions)) {
      return this.validateSuggestions(response.suggestions);
    }

    // If response is raw text, try to extract JSON
    if (response.raw) {
      try {
        const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.suggestions) {
            return this.validateSuggestions(parsed.suggestions);
          }
        }
      } catch (error) {
        console.warn('[AI] Failed to extract suggestions from raw response');
      }
    }

    // Fallback to empty array
    console.warn('[AI] No valid suggestions found in response');
    return [];
  }

  /**
   * Validate and filter suggestions
   */
  validateSuggestions(suggestions) {
    return suggestions
      .filter(s => {
        // Ensure required fields exist
        if (!s.file || !s.line || !s.type || !s.title) {
          console.warn('[AI] Skipping invalid suggestion:', s);
          return false;
        }
        
        // Filter out low confidence suggestions
        if (s.confidence && s.confidence < 0.3) {
          console.log(`[AI] Filtering low confidence suggestion: ${s.title} (${s.confidence})`);
          return false;
        }
        
        return true;
      })
      .map(s => ({
        file: s.file,
        line_start: s.line,
        line_end: s.lineEnd || s.line,
        type: s.type,
        title: s.title,
        description: s.description || '',
        suggestion: s.suggestion || '',
        confidence: s.confidence || 0.7
      }));
  }

  /**
   * Store suggestions in the database
   */
  async storeSuggestions(prId, runId, suggestions, level) {
    const stmt = this.db.prepare(`
      INSERT INTO comments (
        pr_id, source, author, ai_run_id, ai_level, ai_confidence,
        file, line_start, line_end, type, title, body, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const suggestion of suggestions) {
      const body = suggestion.description + 
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');
      
      stmt.run(
        prId,
        'ai',
        'AI Assistant',
        runId,
        level,
        suggestion.confidence,
        suggestion.file,
        suggestion.line_start,
        suggestion.line_end,
        suggestion.type,
        suggestion.title,
        body,
        'active'
      );
    }

    stmt.finalize();
    console.log(`[AI] Stored ${suggestions.length} suggestions in database`);
  }

  /**
   * Get AI suggestions for a PR
   */
  async getSuggestions(prId, runId = null) {
    let query = `
      SELECT * FROM comments 
      WHERE pr_id = ? AND source = 'ai'
    `;
    const params = [prId];

    if (runId) {
      query += ' AND ai_run_id = ?';
      params.push(runId);
    }

    query += ' ORDER BY file, line_start';

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Update suggestion status (adopt, dismiss, etc)
   */
  async updateSuggestionStatus(suggestionId, status, adoptedAsId = null) {
    return new Promise((resolve, reject) => {
      const query = adoptedAsId
        ? 'UPDATE comments SET status = ?, adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        : 'UPDATE comments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
      
      const params = adoptedAsId 
        ? [status, adoptedAsId, suggestionId]
        : [status, suggestionId];

      this.db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }
}

module.exports = Analyzer;