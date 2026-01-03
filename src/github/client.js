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
        node_id: data.node_id,  // GraphQL node ID for PR (e.g., "PR_kwDOM...")
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
   * @param {string} event - Review event (APPROVE, REQUEST_CHANGES, COMMENT, or DRAFT)
   * @param {string} body - Overall review body/summary
   * @param {Array} comments - Array of inline comments with path, line, body
   * @param {string} diffContent - The PR diff for position calculation
   * @returns {Promise<Object>} Review submission result with GitHub URL
   */
  async createReview(owner, repo, pullNumber, event, body, comments = [], diffContent = '') {
    try {
      const reviewType = event === 'DRAFT' ? 'draft review' : 'review';
      console.log(`Creating ${reviewType} for PR #${pullNumber} in ${owner}/${repo}`);
      
      // Validate GitHub token before attempting submission
      const isValidToken = await this.validateToken();
      if (!isValidToken) {
        throw new Error('Invalid or expired GitHub token. Please check your token in ~/.pair-review/config.json');
      }

      // Validate event type
      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT'];
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

        // Use the new line/side/commit_id approach for ALL comments
        // This is more stable than position-based comments and works for lines
        // outside the diff context (e.g., expanded context lines)
        const side = comment.side || 'RIGHT';  // LEFT for deleted lines, RIGHT for added/context
        const commitId = comment.commit_id;

        if (!commitId) {
          console.error(`Missing commit_id for comment on ${comment.path}:${comment.line} - comment will likely fail`);
        }

        // Always use line/side approach (GitHub's modern API)
        // Note: commit_id is set at the review level, not per-comment
        const isRange = comment.start_line && comment.start_line !== comment.line;
        if (isRange) {
          console.log(`Formatting range comment for ${comment.path}:${comment.start_line}-${comment.line} (side: ${side})`);
        } else {
          console.log(`Formatting comment for ${comment.path}:${comment.line} (side: ${side})`);
        }

        const formatted = {
          path: comment.path,
          line: comment.line,
          side: side,
          body: comment.body
        };

        // For multi-line comments, add start_line and start_side
        if (isRange) {
          formatted.start_line = comment.start_line;
          formatted.start_side = comment.start_side || side;
        }

        formattedComments.push(formatted);
      }

      console.log(`Formatted ${formattedComments.length} comments for ${reviewType}`);
      
      // Check if we have any comments after filtering
      if (comments.length > 0 && formattedComments.length === 0) {
        console.warn('All comments were on binary files and were skipped');
        // Allow review to proceed without inline comments if there's a review body
        if (!body || body.trim() === '') {
          const errorMessage = event === 'DRAFT' ? 
            'Cannot create draft review: all comments are on binary files (GitHub does not support comments on binary files) and no review summary was provided' :
            'Cannot submit review: all comments are on binary files (GitHub does not support comments on binary files) and no review summary was provided';
          throw new Error(errorMessage);
        }
      }

      // Extract commit_id from first comment (all comments should have the same one)
      const commitId = comments.length > 0 ? comments[0].commit_id : null;
      if (commitId) {
        console.log(`Using commit_id for review: ${commitId.substring(0, 7)}`);
      } else {
        console.warn('No commit_id available - review may fail for lines outside diff');
      }

      // Build GitHub API payload
      const payload = {
        owner,
        repo,
        pull_number: pullNumber,
        body: body || '',
        comments: formattedComments
      };

      // Add commit_id at review level (required for line/side comments)
      if (commitId) {
        payload.commit_id = commitId;
      }

      // Only include event field for non-DRAFT reviews
      if (event !== 'DRAFT') {
        payload.event = event;
      }

      console.log(`Submitting review to GitHub with payload:`, JSON.stringify({
        ...payload,
        comments: payload.comments.length + ' comments'
      }, null, 2));

      // Submit review to GitHub
      const { data } = await this.octokit.rest.pulls.createReview(payload);

      const successMessage = event === 'DRAFT' ? 
        `Draft review created successfully: ${data.html_url} (Review ID: ${data.id})` :
        `Review submitted successfully: ${data.html_url}`;
      console.log(successMessage);

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
   * Submit a review using GraphQL API
   * This supports both line-level comments (within diff hunks) and file-level comments
   * (for expanded context lines outside diff hunks).
   *
   * @param {string} prNodeId - GraphQL node ID for the PR (e.g., "PR_kwDOM...")
   * @param {string} event - Review event (APPROVE, REQUEST_CHANGES, COMMENT)
   * @param {string} body - Overall review body/summary
   * @param {Array} comments - Array of comments with path, line (optional), side, body, isFileLevel
   * @returns {Promise<Object>} Review submission result
   */
  async createReviewGraphQL(prNodeId, event, body, comments = []) {
    try {
      console.log(`Creating GraphQL review for PR ${prNodeId} with ${comments.length} comments`);

      // Validate event type
      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
      if (!validEvents.includes(event)) {
        throw new Error(`Invalid review event: ${event}. Must be one of: ${validEvents.join(', ')}`);
      }

      // Step 1: Create a pending review
      console.log('Step 1: Creating pending review...');
      const createReviewResult = await this.octokit.graphql(`
        mutation AddPendingReview($prId: ID!) {
          addPullRequestReview(input: {
            pullRequestId: $prId
          }) {
            pullRequestReview {
              id
            }
          }
        }
      `, {
        prId: prNodeId
      });

      const reviewId = createReviewResult.addPullRequestReview.pullRequestReview.id;
      console.log(`Created pending review: ${reviewId}`);

      // Step 2: Add all comments
      // Build a batched mutation for all comments
      let successfulComments = 0;
      if (comments.length > 0) {
        console.log(`Step 2: Adding ${comments.length} comments...`);

        // Build mutation with all comments
        const commentMutations = comments.map((comment, index) => {
          const isFileLevel = comment.isFileLevel || !comment.line;

          if (isFileLevel) {
            // File-level comment (for expanded context lines)
            return `
              comment${index}: addPullRequestReviewThread(input: {
                pullRequestId: $prId
                pullRequestReviewId: $reviewId
                path: "${comment.path}"
                subjectType: FILE
                body: ${JSON.stringify(comment.body)}
              }) {
                thread { id }
              }
            `;
          } else {
            // Line-level comment
            const side = comment.side || 'RIGHT';
            return `
              comment${index}: addPullRequestReviewThread(input: {
                pullRequestId: $prId
                pullRequestReviewId: $reviewId
                path: "${comment.path}"
                line: ${comment.line}
                side: ${side}
                body: ${JSON.stringify(comment.body)}
              }) {
                thread { id }
              }
            `;
          }
        }).join('\n');

        const addCommentsMutation = `
          mutation AddReviewComments($prId: ID!, $reviewId: ID!) {
            ${commentMutations}
          }
        `;

        try {
          const result = await this.octokit.graphql(addCommentsMutation, {
            prId: prNodeId,
            reviewId: reviewId
          });

          // Verify each comment was successfully added by checking for thread.id
          for (let i = 0; i < comments.length; i++) {
            const commentResult = result[`comment${i}`];
            if (commentResult && commentResult.thread && commentResult.thread.id) {
              successfulComments++;
            } else {
              console.warn(`Comment ${i} failed to add: ${comments[i].path}:${comments[i].line || 'file-level'}`);
            }
          }

          if (successfulComments < comments.length) {
            const failedCount = comments.length - successfulComments;
            console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to GitHub`);
            throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to GitHub. Check server logs for details.`);
          } else {
            console.log(`Added ${successfulComments} comments to review`);
          }
        } catch (commentError) {
          // Check if this is a partial success (error.data contains partial results)
          // GraphQL may return partial data alongside errors
          if (commentError.data) {
            console.warn('GraphQL returned partial results with errors:', commentError.errors || commentError.message);
            // Count successful comments from partial data
            for (let i = 0; i < comments.length; i++) {
              const commentResult = commentError.data[`comment${i}`];
              if (commentResult && commentResult.thread && commentResult.thread.id) {
                successfulComments++;
              } else {
                console.warn(`Comment ${i} failed to add: ${comments[i].path}:${comments[i].line || 'file-level'}`);
              }
            }

            if (successfulComments < comments.length) {
              const failedCount = comments.length - successfulComments;
              console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to GitHub (partial success)`);
              // Clean up the pending review since it has incomplete comments
              try {
                await this.octokit.graphql(`
                  mutation DeleteReview($reviewId: ID!) {
                    deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
                      pullRequestReview { id }
                    }
                  }
                `, { reviewId });
                console.log('Cleaned up pending review after partial comment failure');
              } catch (cleanupError) {
                console.warn('Failed to clean up pending review:', cleanupError.message);
              }
              throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to GitHub. Check server logs for details.`);
            } else {
              // All comments succeeded despite the error - continue
              console.log(`Added ${successfulComments} comments to review (recovered from partial error)`);
            }
          } else {
            // Total failure - no partial data
            console.error('Error adding comments:', commentError.message);
            // Try to delete the pending review to clean up
            try {
              await this.octokit.graphql(`
                mutation DeleteReview($reviewId: ID!) {
                  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
                    pullRequestReview { id }
                  }
                }
              `, { reviewId });
              console.log('Cleaned up pending review after comment failure');
            } catch (cleanupError) {
              console.warn('Failed to clean up pending review:', cleanupError.message);
            }
            throw commentError;
          }
        }
      }

      // Step 3: Submit the review
      console.log(`Step 3: Submitting review with event ${event}...`);
      const submitResult = await this.octokit.graphql(`
        mutation SubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
          submitPullRequestReview(input: {
            pullRequestReviewId: $reviewId
            event: $event
            body: $body
          }) {
            pullRequestReview {
              id
              url
              state
            }
          }
        }
      `, {
        reviewId: reviewId,
        event: event,
        body: body || null
      });

      const result = submitResult.submitPullRequestReview.pullRequestReview;
      console.log(`Review submitted successfully: ${result.url}`);

      return {
        id: result.id,
        html_url: result.url,
        state: result.state,
        comments_count: successfulComments
      };

    } catch (error) {
      console.error('GraphQL review error:', error);

      // Parse GraphQL errors
      if (error.errors) {
        const messages = error.errors.map(e => e.message).join(', ');
        throw new Error(`GitHub GraphQL error: ${messages}`);
      }

      throw new Error(`Failed to submit review via GraphQL: ${error.message}`);
    }
  }

  /**
   * Create a draft (pending) review using GraphQL API
   * This creates a review and adds comments but does NOT submit it.
   * The review remains as PENDING on GitHub for later submission.
   *
   * @param {string} prNodeId - GraphQL node ID for the PR (e.g., "PR_kwDOM...")
   * @param {string} body - Overall review body/summary
   * @param {Array} comments - Array of comments with path, line (optional), side, body, isFileLevel
   * @returns {Promise<Object>} Draft review result
   */
  async createDraftReviewGraphQL(prNodeId, body, comments = []) {
    try {
      console.log(`Creating GraphQL draft review for PR ${prNodeId} with ${comments.length} comments`);

      // Step 1: Create a pending review
      console.log('Step 1: Creating pending review...');
      const createReviewResult = await this.octokit.graphql(`
        mutation AddPendingReview($prId: ID!, $body: String) {
          addPullRequestReview(input: {
            pullRequestId: $prId
            body: $body
          }) {
            pullRequestReview {
              id
              url
            }
          }
        }
      `, {
        prId: prNodeId,
        body: body || null
      });

      const review = createReviewResult.addPullRequestReview.pullRequestReview;
      const reviewId = review.id;
      console.log(`Created pending review: ${reviewId}`);

      // Step 2: Add all comments (same as createReviewGraphQL)
      let successfulComments = 0;
      if (comments.length > 0) {
        console.log(`Step 2: Adding ${comments.length} comments...`);

        const commentMutations = comments.map((comment, index) => {
          const isFileLevel = comment.isFileLevel || !comment.line;

          if (isFileLevel) {
            return `
              comment${index}: addPullRequestReviewThread(input: {
                pullRequestId: $prId
                pullRequestReviewId: $reviewId
                path: "${comment.path}"
                subjectType: FILE
                body: ${JSON.stringify(comment.body)}
              }) {
                thread { id }
              }
            `;
          } else {
            const side = comment.side || 'RIGHT';
            return `
              comment${index}: addPullRequestReviewThread(input: {
                pullRequestId: $prId
                pullRequestReviewId: $reviewId
                path: "${comment.path}"
                line: ${comment.line}
                side: ${side}
                body: ${JSON.stringify(comment.body)}
              }) {
                thread { id }
              }
            `;
          }
        }).join('\n');

        const addCommentsMutation = `
          mutation AddReviewComments($prId: ID!, $reviewId: ID!) {
            ${commentMutations}
          }
        `;

        try {
          const result = await this.octokit.graphql(addCommentsMutation, {
            prId: prNodeId,
            reviewId: reviewId
          });

          // Verify each comment was successfully added by checking for thread.id
          for (let i = 0; i < comments.length; i++) {
            const commentResult = result[`comment${i}`];
            if (commentResult && commentResult.thread && commentResult.thread.id) {
              successfulComments++;
            } else {
              console.warn(`Comment ${i} failed to add: ${comments[i].path}:${comments[i].line || 'file-level'}`);
            }
          }

          if (successfulComments < comments.length) {
            const failedCount = comments.length - successfulComments;
            console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to draft review`);
            throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to draft review. Check server logs for details.`);
          } else {
            console.log(`Added ${successfulComments} comments to draft review`);
          }
        } catch (commentError) {
          // Check if this is a partial success (error.data contains partial results)
          // GraphQL may return partial data alongside errors
          if (commentError.data) {
            console.warn('GraphQL returned partial results with errors:', commentError.errors || commentError.message);
            // Count successful comments from partial data
            for (let i = 0; i < comments.length; i++) {
              const commentResult = commentError.data[`comment${i}`];
              if (commentResult && commentResult.thread && commentResult.thread.id) {
                successfulComments++;
              } else {
                console.warn(`Comment ${i} failed to add: ${comments[i].path}:${comments[i].line || 'file-level'}`);
              }
            }

            if (successfulComments < comments.length) {
              const failedCount = comments.length - successfulComments;
              console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to draft review (partial success)`);
              // Clean up the pending review since it has incomplete comments
              try {
                await this.octokit.graphql(`
                  mutation DeleteReview($reviewId: ID!) {
                    deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
                      pullRequestReview { id }
                    }
                  }
                `, { reviewId });
                console.log('Cleaned up pending review after partial comment failure');
              } catch (cleanupError) {
                console.warn('Failed to clean up pending review:', cleanupError.message);
              }
              throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to draft review. Check server logs for details.`);
            } else {
              // All comments succeeded despite the error - continue
              console.log(`Added ${successfulComments} comments to draft review (recovered from partial error)`);
            }
          } else {
            // Total failure - no partial data
            console.error('Error adding comments to draft:', commentError.message);
            // Try to delete the pending review to clean up
            try {
              await this.octokit.graphql(`
                mutation DeleteReview($reviewId: ID!) {
                  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
                    pullRequestReview { id }
                  }
                }
              `, { reviewId });
              console.log('Cleaned up pending review after comment failure');
            } catch (cleanupError) {
              console.warn('Failed to clean up pending review:', cleanupError.message);
            }
            throw commentError;
          }
        }
      }

      // Note: We do NOT submit the review - it stays as PENDING (draft)
      console.log(`Draft review created successfully (pending): ${review.url || reviewId}`);

      return {
        id: reviewId,
        html_url: review.url,
        state: 'PENDING',
        comments_count: successfulComments
      };

    } catch (error) {
      console.error('GraphQL draft review error:', error);

      if (error.errors) {
        const messages = error.errors.map(e => e.message).join(', ');
        throw new Error(`GitHub GraphQL error: ${messages}`);
      }

      throw new Error(`Failed to create draft review via GraphQL: ${error.message}`);
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
      console.warn('calculateDiffPosition: Missing required parameters', { 
        filePath, 
        lineNumber, 
        hasDiffContent: !!diffContent 
      });
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
          
          if (!foundHunk) {
            // First hunk header - NOT counted as a position (per GitHub spec)
            position = 0;
            foundHunk = true;
          } else {
            // Subsequent hunk headers ARE counted as positions (per GitHub spec)
            position++;
          }
        }
        continue;
      }

      // Only process lines after we've found a hunk in our target file
      if (!foundHunk) continue;

      // Check if this is a diff content line (addition, deletion, context, or empty context)
      const isDiffContentLine = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && foundHunk);
      
      if (!isDiffContentLine) continue;
      
      // Count position for all diff lines (context, additions, deletions, empty context)
      position++;

      // Track line numbers for additions, context lines, and empty context lines  
      if (line.startsWith('+')) {
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      } else if (line.startsWith(' ') || (line === '' && foundHunk)) { // Context line (including empty context)
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      }
      // Deletion lines don't increment newLineNumber but do increment position
    }

    console.warn('calculateDiffPosition: Position not found', { 
      filePath, 
      lineNumber, 
      inFile, 
      foundHunk, 
      finalNewLineNumber: newLineNumber 
    });
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
      console.error('GitHub 422 validation error response:', JSON.stringify(error.response?.data, null, 2));
      const message = error.response?.data?.message || 'Validation error';
      const errors = error.response?.data?.errors;
      
      // Check for pending review error specifically
      if (errors && Array.isArray(errors)) {
        const errorMessages = errors.map(e => e.message || e.code || e);
        const errorDetails = errorMessages.join(', ');
        
        // Special handling for pending review error
        if (errorMessages.some(msg => msg.includes('pending review'))) {
          throw new Error(`You already have a pending (draft) review on this PR. Please submit or dismiss it on GitHub before creating a new draft review.`);
        }
        
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