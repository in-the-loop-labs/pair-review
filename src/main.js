const { loadConfig } = require('./config');
const { initializeDatabase, run } = require('./database');
const { PRArgumentParser } = require('./github/parser');
const { GitHubClient } = require('./github/client');
const { GitWorktreeManager } = require('./git/worktree');
const { startServer } = require('./server');
const open = (...args) => import('open').then(({default: open}) => open(...args));

let db = null;

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

    // Check if PR arguments were provided
    if (args.length > 0) {
      await handlePullRequest(args, config, db);
    } else {
      // No PR arguments - just start the server
      console.log('No pull request specified. Starting server...');
      await startServerOnly(config);
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

/**
 * Handle pull request processing
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 */
async function handlePullRequest(args, config, db) {
  try {
    // Validate GitHub token
    if (!config.github_token) {
      throw new Error('GitHub token not found. Run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    const prInfo = await parser.parsePRArguments(args);
    
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
    const port = await startServerWithPRContext(config, prInfo);

    // Open browser to PR view
    const url = `http://localhost:${port}/?pr=${prInfo.owner}/${prInfo.repo}/${prInfo.number}`;
    console.log(`Opening browser to: ${url}`);
    await open(url);

  } catch (error) {
    console.error('Error processing pull request:', error.message);
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
 * @returns {Promise<number>} Server port
 */
async function startServerWithPRContext(config, prInfo) {
  // Set environment variable for PR context
  process.env.PAIR_REVIEW_PR = JSON.stringify(prInfo);
  
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

    // Insert or update PR metadata
    await run(db, `
      INSERT OR REPLACE INTO pr_metadata 
      (pr_number, repository, title, description, author, base_branch, head_branch, pr_data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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

    // Create or update review record
    await run(db, `
      INSERT OR REPLACE INTO reviews
      (pr_number, repository, status, review_data, updated_at)
      VALUES (?, ?, 'draft', ?, CURRENT_TIMESTAMP)
    `, [
      prInfo.number,
      repository,
      JSON.stringify({
        worktree_path: worktreePath,
        created_at: new Date().toISOString()
      })
    ]);

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

module.exports = { main };