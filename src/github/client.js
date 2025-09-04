const { Octokit } = require('@octokit/rest');

/**
 * GitHub API client wrapper with error handling and rate limiting
 */
class GitHubClient {
  constructor(token) {
    if (!token) {
      throw new Error('GitHub token is required');
    }
    
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'pair-review v1.0.0'
    });
  }

  /**
   * Fetch pull request data from GitHub API
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name  
   * @param {number} pullNumber - Pull request number
   * @returns {Promise<Object>} Pull request data
   */
  async fetchPullRequest(owner, repo, pullNumber) {
    try {
      console.log(`Fetching pull request #${pullNumber} from ${owner}/${repo}`);
      
      const { data } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        author: data.user.login,
        state: data.state,
        base_branch: data.base.ref,
        head_branch: data.head.ref,
        base_sha: data.base.sha,
        head_sha: data.head.sha,
        created_at: data.created_at,
        updated_at: data.updated_at,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        mergeable: data.mergeable,
        mergeable_state: data.mergeable_state,
        html_url: data.html_url,
        repository: {
          full_name: data.base.repo.full_name,
          clone_url: data.base.repo.clone_url,
          ssh_url: data.base.repo.ssh_url,
          default_branch: data.base.repo.default_branch
        }
      };
    } catch (error) {
      await this.handleApiError(error, owner, repo, pullNumber);
    }
  }

  /**
   * Validate GitHub token by making a test API call
   * @returns {Promise<boolean>} Whether the token is valid
   */
  async validateToken() {
    try {
      await this.octokit.rest.users.getAuthenticated();
      return true;
    } catch (error) {
      if (error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Check if a repository exists and is accessible
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<boolean>} Whether the repository exists and is accessible
   */
  async repositoryExists(owner, repo) {
    try {
      await this.octokit.rest.repos.get({ owner, repo });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Handle GitHub API errors with appropriate error messages and rate limiting
   * @param {Error} error - The API error
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @throws {Error} Reformatted error with user-friendly message
   */
  async handleApiError(error, owner, repo, pullNumber) {
    // Only log detailed errors for debugging if verbose mode is enabled
    if (process.env.VERBOSE || process.env.DEBUG) {
      console.error('GitHub API error:', error);
    }

    // Handle rate limiting with exponential backoff
    if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
      const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
      const waitTime = Math.max(resetTime - Date.now(), 1000);
      
      console.log(`Rate limit exceeded. Retrying in ${Math.ceil(waitTime / 1000)} seconds...`);
      
      throw new Error(`GitHub API rate limit exceeded. Retrying in ${Math.ceil(waitTime / 1000)} seconds...`);
    }

    // Handle authentication errors
    if (error.status === 401) {
      throw new Error('GitHub authentication failed. Check your token in ~/.pair-review/config.json');
    }

    // Handle not found errors
    if (error.status === 404) {
      throw new Error(`Pull request #${pullNumber} not found in repository ${owner}/${repo}`);
    }

    // Handle network errors
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error(`Network error: ${error.message}. Please check your internet connection.`);
    }

    // Generic error
    throw new Error(`GitHub API error: ${error.message}`);
  }

  /**
   * Submit a review to GitHub with inline comments
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {string} event - Review event (APPROVE, REQUEST_CHANGES, or COMMENT)
   * @param {string} body - Overall review body/summary
   * @param {Array} comments - Array of inline comments with path, line, body
   * @param {string} diffContent - The PR diff for position calculation
   * @returns {Promise<Object>} Review submission result with GitHub URL
   */
  async createReview(owner, repo, pullNumber, event, body, comments = [], diffContent = '') {
    try {
      console.log(`Submitting review for PR #${pullNumber} in ${owner}/${repo}`);
      
      // Validate GitHub token before attempting submission
      const isValidToken = await this.validateToken();
      if (!isValidToken) {
        throw new Error('Invalid or expired GitHub token. Please check your token in ~/.pair-review/config.json');
      }

      // Validate event type
      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
      if (!validEvents.includes(event)) {
        throw new Error(`Invalid review event: ${event}. Must be one of: ${validEvents.join(', ')}`);
      }

      // Convert comments to GitHub API format with position calculation
      const formattedComments = [];
      
      // Binary file extensions that GitHub doesn't allow comments on
      const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', 
                               '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', 
                               '.dylib', '.bin', '.dat', '.db', '.sqlite'];
      
      for (const comment of comments) {
        if (!comment.path || !comment.body) {
          throw new Error('Each comment must have a path and body');
        }
        
        // Skip binary files - GitHub doesn't allow comments on them
        const isBinary = binaryExtensions.some(ext => comment.path.toLowerCase().endsWith(ext));
        if (isBinary) {
          console.warn(`Skipping comment on binary file: ${comment.path} (GitHub doesn't support comments on binary files)`);
          continue;
        }

        // Use stored diff position if available, otherwise calculate it
        let position = comment.diff_position;
        if (!position || position === null) {
          position = this.calculateDiffPosition(diffContent, comment.path, comment.line);
        }
        
        if (position === -1 || position === null) {
          // If we can't calculate position and don't have a stored one, try using line-based comment
          // This requires the PR to be based on a commit that's in the base branch
          console.warn(`Could not calculate diff position for ${comment.path}:${comment.line}, using line-based comment`);
          formattedComments.push({
            path: comment.path,
            line: comment.line,
            side: 'RIGHT',
            body: comment.body
          });
        } else {
          // Use position-based comment (preferred for PR reviews)
          console.log(`Using ${comment.diff_position ? 'stored' : 'calculated'} diff position ${position} for ${comment.path}:${comment.line}`);
          formattedComments.push({
            path: comment.path,
            position: position,
            body: comment.body
          });
        }
      }

      console.log(`Formatted ${formattedComments.length} comments for submission`);
      
      // Check if we have any comments after filtering
      if (comments.length > 0 && formattedComments.length === 0) {
        console.warn('All comments were on binary files and were skipped');
        // Allow review to proceed without inline comments if there's a review body
        if (!body || body.trim() === '') {
          throw new Error('Cannot submit review: all comments are on binary files (GitHub does not support comments on binary files) and no review summary was provided');
        }
      }

      // Submit review to GitHub
      const { data } = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event,
        body: body || '',
        comments: formattedComments
      });

      console.log(`Review submitted successfully: ${data.html_url}`);

      return {
        id: data.id,
        html_url: data.html_url,
        state: data.state,
        submitted_at: data.submitted_at,
        comments_count: formattedComments.length
      };

    } catch (error) {
      await this.handleReviewError(error, owner, repo, pullNumber);
    }
  }

  /**
   * Calculate diff position for a given file path and line number
   * Position is counted from the first @@ hunk header, where position 1 = first line after @@
   * @param {string} diffContent - The unified diff content
   * @param {string} filePath - File path to find in diff
   * @param {number} lineNumber - Line number in the new file
   * @returns {number} Diff position or -1 if not found
   */
  calculateDiffPosition(diffContent, filePath, lineNumber) {
    if (!diffContent || !filePath || lineNumber === undefined) {
      return -1;
    }

    const lines = diffContent.split('\n');
    let inFile = false;
    let currentFile = '';
    let position = 0;
    let newLineNumber = 0;
    let foundHunk = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for file header (diff --git a/path b/path)
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[2]; // Use the "b/" path (new file)
          inFile = currentFile === filePath;
          position = 0;
          newLineNumber = 0;
          foundHunk = false;
        }
        continue;
      }

      // Skip if not in the target file
      if (!inFile) continue;

      // Check for hunk header (@@ -oldstart,oldcount +newstart,newcount @@)
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
        if (match) {
          newLineNumber = parseInt(match[1]) - 1; // Start counting from the line before
          position = 0; // Reset position counter for this hunk
          foundHunk = true;
        }
        continue;
      }

      // Only process lines after we've found a hunk in our target file
      if (!foundHunk) continue;

      // Count position for all diff lines (context, additions, deletions)
      position++;

      // Track line numbers for additions and context lines
      if (line.startsWith('+')) {
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      } else if (line.startsWith(' ')) { // Context line
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      }
      // Deletion lines don't increment newLineNumber but do increment position
    }

    return -1; // Position not found
  }

  /**
   * Handle errors specific to review submission
   * @param {Error} error - The API error
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @throws {Error} Reformatted error with user-friendly message
   */
  async handleReviewError(error, owner, repo, pullNumber) {
    console.error('GitHub review submission error:', error);

    // Handle authentication errors
    if (error.status === 401) {
      throw new Error('GitHub authentication failed. Your token may be invalid or expired. Check ~/.pair-review/config.json');
    }

    // Handle forbidden errors (insufficient permissions)
    if (error.status === 403) {
      throw new Error(`Insufficient permissions to review PR #${pullNumber} in ${owner}/${repo}. Your GitHub token may need additional scopes.`);
    }

    // Handle not found errors
    if (error.status === 404) {
      throw new Error(`Pull request #${pullNumber} not found in repository ${owner}/${repo}`);
    }

    // Handle validation errors
    if (error.status === 422) {
      const message = error.response?.data?.message || 'Validation error';
      const errors = error.response?.data?.errors;
      if (errors && Array.isArray(errors)) {
        const errorDetails = errors.map(e => e.message || e.code).join(', ');
        throw new Error(`GitHub API validation error: ${message}. Details: ${errorDetails}`);
      }
      throw new Error(`GitHub API validation error: ${message}`);
    }

    // Handle network errors
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error(`Network error during review submission: ${error.message}. Please check your internet connection.`);
    }

    // Handle rate limiting
    if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
      const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
      const waitTime = Math.max(resetTime - Date.now(), 1000);
      throw new Error(`GitHub API rate limit exceeded. Review submission failed. Please wait ${Math.ceil(waitTime / 1000)} seconds and try again.`);
    }

    // Generic error
    throw new Error(`Failed to submit review: ${error.message}`);
  }

  /**
   * Retry API calls with exponential backoff
   * @param {Function} apiCall - The API call function
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} baseDelay - Base delay in milliseconds
   * @returns {Promise<any>} API call result
   */
  async retryWithBackoff(apiCall, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        lastError = error;
        
        // Don't retry on authentication or not found errors
        if (error.status === 401 || error.status === 404) {
          throw error;
        }
        
        // Only retry on rate limiting or network errors
        if (error.status === 403 || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        throw error;
      }
    }
    
    throw lastError;
  }
}

module.exports = { GitHubClient };