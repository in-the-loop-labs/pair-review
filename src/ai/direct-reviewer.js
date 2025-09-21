const Analyzer = require('./analyzer');
const { query, queryOne, run } = require('../database');
const { GitHubClient } = require('../github/client');

/**
 * DirectReviewer class handles the --direct mode workflow:
 * 1. Run all 3 levels of AI analysis sequentially
 * 2. Automatically adopt ALL AI suggestions as user comments
 * 3. Submit review to GitHub as DRAFT
 * 4. Exit process after submission
 */
class DirectReviewer {
  constructor(database, config) {
    this.db = database;
    this.config = config;
    this.analyzer = new Analyzer(database);
  }

  /**
   * Perform complete direct review workflow
   * @param {Object} prInfo - PR information (owner, repo, number)
   * @param {Object} prData - PR data from GitHub
   * @param {string} worktreePath - Path to git worktree
   */
  async performDirectReview(prInfo, prData, worktreePath) {
    try {
      console.log(`\n🤖 Starting direct review for PR #${prInfo.number} from ${prInfo.owner}/${prInfo.repo}`);

      // Get PR metadata from database
      const repository = `${prInfo.owner}/${prInfo.repo}`;
      const prMetadata = await queryOne(this.db, `
        SELECT id, base_branch FROM pr_metadata
        WHERE pr_number = ? AND repository = ?
      `, [prInfo.number, repository]);

      if (!prMetadata) {
        throw new Error(`Pull request #${prInfo.number} not found in database`);
      }

      // Step 1: Run complete AI analysis (all 3 levels)
      console.log('⚡ Running comprehensive AI analysis (Levels 1-3)...');
      const analysisResult = await this.runCompleteAnalysis(prMetadata.id, worktreePath, prMetadata);

      // Step 2: Adopt all AI suggestions as user comments
      console.log('📝 Adopting all AI suggestions as user comments...');
      const adoptionResult = await this.adoptAllSuggestions(prMetadata.id);

      // Step 3: Submit review to GitHub as DRAFT
      console.log('🚀 Submitting review to GitHub as DRAFT...');
      const githubResult = await this.submitDraftReview(prInfo, adoptionResult.userComments);

      // Step 4: Display results and exit
      this.displayCompletionSummary(analysisResult, adoptionResult, githubResult);

    } catch (error) {
      console.error(`\n❌ Direct review failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run complete AI analysis using the existing analyzer
   * @param {number} prId - PR database ID
   * @param {string} worktreePath - Path to git worktree
   * @param {Object} prMetadata - PR metadata
   * @returns {Object} Analysis results
   */
  async runCompleteAnalysis(prId, worktreePath, prMetadata) {
    const progressCallback = (progress) => {
      // Display simple progress messages
      if (progress.progress) {
        console.log(`   ${progress.progress}`);
      }
    };

    try {
      // The analyzer.analyzeLevel1 method already runs all 3 levels automatically
      // and stores orchestrated suggestions in the database
      const result = await this.analyzer.analyzeLevel1(prId, worktreePath, prMetadata, progressCallback);

      // Count suggestions from orchestrated results if available, otherwise count individual levels
      let totalSuggestions = 0;
      if (result.level2Result?.orchestratedSuggestions?.length > 0) {
        totalSuggestions = result.level2Result.orchestratedSuggestions.length;
        console.log(`✅ Analysis complete: ${totalSuggestions} orchestrated suggestions found`);
      } else {
        const level1Count = result.suggestions.length;
        const level2Count = result.level2Result?.suggestions?.length || 0;
        const level3Count = result.level2Result?.level3Result?.suggestions?.length || 0;
        totalSuggestions = level1Count + level2Count + level3Count;
        console.log(`✅ Analysis complete: ${totalSuggestions} suggestions found (Level 1: ${level1Count}, Level 2: ${level2Count}, Level 3: ${level3Count})`);
      }

      return {
        totalSuggestions,
        result
      };
    } catch (error) {
      console.error(`   ❌ AI analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Adopt all AI suggestions by creating user comments with parent_id references
   * @param {number} prId - PR database ID
   * @returns {Object} Adoption results
   */
  async adoptAllSuggestions(prId) {
    try {
      // Get all active AI suggestions for this PR
      const aiSuggestions = await query(this.db, `
        SELECT
          id, file, line_start, line_end, type, title, body,
          ai_confidence, ai_level
        FROM comments
        WHERE pr_id = ? AND source = 'ai' AND status = 'active'
        ORDER BY file, line_start
      `, [prId]);

      if (aiSuggestions.length === 0) {
        console.log('   ⚠️  No AI suggestions found to adopt');
        return { userComments: [], adoptedCount: 0 };
      }

      console.log(`   📋 Found ${aiSuggestions.length} AI suggestions to adopt`);

      const userComments = [];
      let adoptedCount = 0;

      // Begin transaction for atomic adoption
      await run(this.db, 'BEGIN TRANSACTION');

      try {
        for (const suggestion of aiSuggestions) {
          // Create user comment with parent_id pointing to AI suggestion
          const result = await run(this.db, `
            INSERT INTO comments (
              pr_id, source, author, file, line_start, line_end,
              type, title, body, status, parent_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            prId,
            'user',
            'Direct Review', // Author for direct mode comments
            suggestion.file,
            suggestion.line_start,
            suggestion.line_end,
            suggestion.type,
            suggestion.title,
            suggestion.body,
            'active',
            suggestion.id // parent_id links to AI suggestion
          ]);

          const userCommentId = result.lastID;

          // Update AI suggestion status to adopted
          await run(this.db, `
            UPDATE comments
            SET status = 'adopted', adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [userCommentId, suggestion.id]);

          userComments.push({
            id: userCommentId,
            file: suggestion.file,
            line_start: suggestion.line_start,
            line_end: suggestion.line_end,
            body: suggestion.body,
            type: suggestion.type,
            title: suggestion.title,
            parent_ai_id: suggestion.id
          });

          adoptedCount++;
        }

        // Commit transaction
        await run(this.db, 'COMMIT');

        console.log(`   ✅ Successfully adopted ${adoptedCount} suggestions as user comments`);

        return { userComments, adoptedCount };

      } catch (error) {
        // Rollback transaction on error
        await run(this.db, 'ROLLBACK');
        throw error;
      }

    } catch (error) {
      console.error(`   ❌ Failed to adopt suggestions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Submit review to GitHub as DRAFT using the existing submission endpoint
   * @param {Object} prInfo - PR information
   * @param {Array} userComments - User comments to include
   * @returns {Object} GitHub submission result
   */
  async submitDraftReview(prInfo, userComments) {
    try {
      if (userComments.length === 0) {
        console.log('   ⚠️  No comments to submit - skipping GitHub submission');
        return { skipped: true, reason: 'No comments' };
      }

      console.log(`   📤 Submitting ${userComments.length} comments to GitHub as DRAFT review...`);

      // Format comments for GitHub API (same format as the existing endpoint)
      const githubComments = userComments.map(comment => ({
        path: comment.file,
        line: comment.line_start,
        body: comment.body
      }));

      // Create GitHub client
      if (!this.config.github_token) {
        throw new Error('GitHub token not configured. Please check ~/.pair-review/config.json');
      }

      const githubClient = new GitHubClient(this.config.github_token);

      // Submit review as DRAFT (using the same method as the web UI)
      const githubReview = await githubClient.createReview(
        prInfo.owner,
        prInfo.repo,
        prInfo.number,
        'DRAFT', // Always submit as DRAFT in direct mode
        'Automated review generated by pair-review in direct mode',
        githubComments,
        '' // No diff content needed for position calculation in direct mode
      );

      console.log(`   ✅ DRAFT review created successfully`);

      return {
        github_review_id: githubReview.id,
        github_url: githubReview.html_url,
        comments_count: githubReview.comments_count,
        status: githubReview.state
      };

    } catch (error) {
      console.error(`   ❌ Failed to submit review to GitHub: ${error.message}`);
      throw error;
    }
  }

  /**
   * Display completion summary and final results
   * @param {Object} analysisResult - Analysis results
   * @param {Object} adoptionResult - Adoption results
   * @param {Object} githubResult - GitHub submission results
   */
  displayCompletionSummary(analysisResult, adoptionResult, githubResult) {
    console.log('\n🎉 Direct review completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`   • AI suggestions found: ${analysisResult.totalSuggestions}`);
    console.log(`   • Suggestions adopted: ${adoptionResult.adoptedCount}`);

    if (githubResult.skipped) {
      console.log(`   • GitHub submission: Skipped (${githubResult.reason})`);
    } else {
      console.log(`   • Comments submitted: ${githubResult.comments_count}`);
      console.log(`   • Review status: ${githubResult.status}`);
      console.log(`   • GitHub URL: ${githubResult.github_url}`);
    }

    console.log('\n✨ Review ready for human inspection on GitHub!');
  }
}

module.exports = { DirectReviewer };