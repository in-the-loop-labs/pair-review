const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const { initializeDatabase } = require('./database');

let db = null;
let server = null;

/**
 * Request logging middleware
 * Enhanced with performance metrics tracking
 */
function requestLogger(req, res, next) {
  const timestamp = new Date().toISOString();
  
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} - ${res.statusCode} - [${timestamp}]`);
  });
  
  next();
}

/**
 * Find an available port starting from the configured port
 * @param {express.Application} app - Express app instance
 * @param {number} startPort - Starting port number
 * @param {number} maxAttempts - Maximum number of ports to try
 * @returns {Promise<number>} - Available port number
 */
function findAvailablePort(app, startPort, maxAttempts = 5) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let currentPort = startPort;
    
    function tryPort() {
      const testServer = app.listen(currentPort, (error) => {
        if (error) {
          testServer.close();
          console.log(`Port ${currentPort} is already in use`);
          attempts++;
          
          if (attempts >= maxAttempts) {
            reject(new Error(`Could not find available port after ${maxAttempts} attempts starting from ${startPort}`));
            return;
          }
          
          currentPort++;
          tryPort();
        } else {
          testServer.close(() => {
            resolve(currentPort);
          });
        }
      });
      
      testServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          testServer.close();
          console.log(`Port ${currentPort} is already in use`);
          attempts++;
          
          if (attempts >= maxAttempts) {
            reject(new Error(`Could not find available port after ${maxAttempts} attempts starting from ${startPort}`));
            return;
          }
          
          currentPort++;
          tryPort();
        } else {
          reject(error);
        }
      });
    }
    
    tryPort();
  });
}

/**
 * Start the Express server
 */
async function startServer() {
  try {
    // Load configuration
    const config = await loadConfig();
    
    // Warn if no GitHub token is configured
    if (!config.github_token) {
      console.warn('Warning: No GitHub token configured. GitHub API functionality will be limited.');
    }
    
    // Initialize database
    console.log('Initializing database...');
    db = await initializeDatabase();
    
    // Check if public directory exists
    const publicDir = path.join(__dirname, '..', 'public');
    try {
      await require('fs').promises.access(publicDir);
    } catch (error) {
      console.error('Public directory not found');
      process.exit(1);
    }
    
    // Create Express app
    const app = express();
    
    // Middleware
    app.use(requestLogger);
    app.use(express.json());
    
    // Static files with cache control headers
    app.use(express.static(path.join(__dirname, '..', 'public'), {
      setHeaders: (res, path) => {
        // Set cache control headers for static files
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      }
    }));
    
    // Routes
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
    
    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
    // Store database instance for routes
    app.set('db', db);
    
    // PR API routes
    const prRoutes = require('./routes/pr');
    app.use('/', prRoutes);
    
    // Error handling middleware
    app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
    
    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
    
    // Find available port and start server
    const port = await findAvailablePort(app, config.port);
    
    server = app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
    
    server.on('error', (error) => {
      console.error('Server error:', error);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error.message);
    
    // Check for specific error conditions
    if (error.message.includes('public') || error.code === 'ENOENT') {
      console.error('Public directory not found');
      process.exit(1);
    }
    
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log('\nServer shutting down...');
  
  if (server) {
    server.close(() => {
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
    });
    
    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 5000);
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

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { startServer };