const { loadConfig } = require('./config');
const { initializeDatabase, run, queryOne } = require('./database');
const { PRArgumentParser } = require('./github/parser');
const { GitHubClient } = require('./github/client');
const { GitWorktreeManager } = require('./git/worktree');
const { startServer } = require('./server');
const open = (...args) => import('open').then(({default: open}) => open(...args));

let db = null;

/**
 * Parse command line arguments to separate PR arguments from flags
 * @param {Array<string>} args - Raw command line arguments
 * @returns {Object} { prArgs: Array<string>, flags: Object }
 */
function parseArgs(args) {
  const prArgs = [];
  const flags = {};
  
  for (const arg of args) {
    if (arg === '--ai') {
      flags.ai = true;
    } else if (arg === '--configure') {
      // Skip --configure as it's handled earlier
      continue;
    } else if (!arg.startsWith('--')) {
      // This is a PR argument (number or URL)
      prArgs.push(arg);
    }
    // Ignore other unknown flags
  }
  
  return { prArgs, flags };
}

/**
 * Main application entry point
 */
async function main() {
  try {
    const args = process.argv.slice(2);
    
    // Handle configuration command
    if (args.includes('--configure')) {
      console.log('Configuration is handled automatically.');
      console.log('Edit ~/.pair-review/config.json to set your GitHub token.');
      process.exit(0);
    }

    // Load configuration
    const config = await loadConfig();
    
    // Initialize database
    console.log('Initializing database...');
    db = await initializeDatabase();

    // Parse command line arguments including flags
    const { prArgs, flags } = parseArgs(args);

    // Check if PR arguments were provided
    if (prArgs.length > 0) {
      await handlePullRequest(prArgs, config, db, flags);
    } else {
      // Check if --ai flag was used without PR identifier
      if (flags.ai) {
        throw new Error('--ai flag requires a pull request number or URL to be specified');
      }
      
      // No PR arguments - just start the server
      console.log('No pull request specified. Starting server...');
      await startServerOnly(config);
    }
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Handle pull request processing
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 */
async function handlePullRequest(args, config, db, flags = {}) {
  let prInfo = null; // Declare prInfo outside try block for error handling
  
  try {
    // Validate GitHub token
    if (!config.github_token) {
      throw new Error('GitHub token not found. Run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    prInfo = await parser.parsePRArguments(args);
    
    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo}`);

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(config.github_token);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      throw new Error('GitHub authentication failed. Check your token in ~/.pair-review/config.json');
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(prInfo.owner, prInfo.repo);
    if (!repoExists) {
      throw new Error(`Repository ${prInfo.owner}/${prInfo.repo} not found or not accessible`);
    }

    // Fetch PR data from GitHub
    console.log('Fetching pull request data from GitHub...');
    const prData = await githubClient.fetchPullRequest(prInfo.owner, prInfo.repo, prInfo.number);

    // Get current repository path
    const currentDir = parser.getCurrentDirectory();
    
    // Setup git worktree
    console.log('Setting up git worktree...');
    const worktreeManager = new GitWorktreeManager();
    const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, currentDir);

    // Generate unified diff
    console.log('Generating unified diff...');
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

    // Store PR data in database
    console.log('Storing pull request data...');
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

    // Start server with PR context
    console.log('Starting server...');
    const port = await startServerWithPRContext(config, prInfo, flags);

    // Open browser to PR view
    let url = `http://localhost:${port}/?pr=${prInfo.owner}/${prInfo.repo}/${prInfo.number}`;
    
    // Add auto-ai parameter if --ai flag is present
    if (flags.ai) {
      url += '&auto-ai=true';
      console.log('Auto-triggering AI analysis...');
    }
    
    console.log(`Opening browser to: ${url}`);
    await open(url);

  } catch (error) {
    // Provide cleaner error messages for common issues
    if (error.message && error.message.includes('not found in repository')) {
      if (prInfo) {
        console.error(`\n❌ Pull request #${prInfo.number} does not exist in ${prInfo.owner}/${prInfo.repo}`);
      } else {
        console.error(`\n❌ ${error.message}`);
      }
      console.error('Please check the PR number and try again.\n');
    } else if (error.message && error.message.includes('authentication failed')) {
      console.error('\n❌ GitHub authentication failed');
      console.error('Please check your token in ~/.pair-review/config.json\n');
    } else if (error.message && error.message.includes('Repository') && error.message.includes('not found')) {
      console.error(`\n❌ ${error.message}`);
      console.error('Please check the repository name and your access permissions.\n');
    } else if (error.message && error.message.includes('Network error')) {
      console.error('\n❌ Network connection error');
      console.error('Please check your internet connection and try again.\n');
    } else {
      // For other errors, show a clean message without stack trace
      console.error(`\n❌ Error: ${error.message}\n`);
    }
    process.exit(1);
  }
}

/**
 * Start server without PR context
 * @param {Object} config - Application configuration
 */
async function startServerOnly(config) {
  await startServer(db);
}

/**
 * Start server with PR context
 * @param {Object} config - Application configuration
 * @param {Object} prInfo - PR information
 * @param {Object} flags - Command line flags
 * @returns {Promise<number>} Server port
 */
async function startServerWithPRContext(config, prInfo, flags = {}) {
  // Set environment variable for PR context
  process.env.PAIR_REVIEW_PR = JSON.stringify(prInfo);
  
  // Set environment variable for auto-AI flag
  if (flags.ai) {
    process.env.PAIR_REVIEW_AUTO_AI = 'true';
  }
  
  const { startServer } = require('./server');
  await startServer(db);
  
  // Return port from config (server will find available port)
  return config.port;
}

/**
 * Store PR data in database
 * @param {Object} db - Database instance
 * @param {Object} prInfo - PR information
 * @param {Object} prData - PR data from GitHub
 * @param {string} diff - Unified diff content
 * @param {Array} changedFiles - Changed files information
 * @param {string} worktreePath - Worktree path
 */
async function storePRData(db, prInfo, prData, diff, changedFiles, worktreePath) {
  try {
    const repository = `${prInfo.owner}/${prInfo.repo}`;
    
    // Prepare extended PR data
    const extendedPRData = {
      ...prData,
      diff: diff,
      changed_files: changedFiles,
      worktree_path: worktreePath,
      fetched_at: new Date().toISOString()
    };

    // First check if PR metadata exists
    const existingPR = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ?
    `, [prInfo.number, repository]);
    
    if (existingPR) {
      // Update existing PR metadata (preserves ID)
      await run(db, `
        UPDATE pr_metadata 
        SET title = ?, description = ?, author = ?, 
            base_branch = ?, head_branch = ?, pr_data = ?, 
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData),
        existingPR.id
      ]);
      console.log(`Updated existing PR metadata (ID: ${existingPR.id})`);
    } else {
      // Insert new PR metadata
      const result = await run(db, `
        INSERT INTO pr_metadata 
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        prInfo.number,
        repository,
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData)
      ]);
      console.log(`Created new PR metadata (ID: ${result.lastID})`);
    }

    // Create or update review record
    const existingReview = await queryOne(db, `
      SELECT id FROM reviews WHERE pr_number = ? AND repository = ?
    `, [prInfo.number, repository]);
    
    if (existingReview) {
      // Update existing review (preserves ID)
      await run(db, `
        UPDATE reviews 
        SET review_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        }),
        existingReview.id
      ]);
      console.log(`Updated existing review (ID: ${existingReview.id})`);
    } else {
      // Insert new review
      const result = await run(db, `
        INSERT INTO reviews
        (pr_number, repository, status, review_data)
        VALUES (?, ?, 'draft', ?)
      `, [
        prInfo.number,
        repository,
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        })
      ]);
      console.log(`Created new review (ID: ${result.lastID})`);
    }

    console.log(`Stored PR data for ${repository} #${prInfo.number}`);
    
  } catch (error) {
    console.error('Error storing PR data:', error);
    throw new Error(`Failed to store PR data: ${error.message}`);
  }
}

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  
  if (db) {
    db.close((error) => {
      if (error) {
        console.error('Error closing database:', error.message);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application if this file is run directly
if (require.main === module) {
  main();
}

module.exports = { main, parseArgs };