/**
 * AI Analysis Progress Modal Component
 * Displays three-level progress structure and handles background execution
 */
class ProgressModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.currentAnalysisId = null;
    this.eventSource = null;
    this.statusCheckInterval = null;
    
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('progress-modal');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'progress-modal';
    modalContainer.className = 'modal-overlay';
    modalContainer.style.display = 'none';
    
    modalContainer.innerHTML = `
      <div class="modal-backdrop" onclick="progressModal.hide()"></div>
      <div class="modal-container">
        <div class="modal-header">
          <h3>AI Review Analysis</h3>
          <button class="modal-close-btn" onclick="progressModal.hide()" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body">
          <div class="progress-levels">
            <div class="progress-level" id="level-1">
              <div class="level-icon">
                <span class="icon pending">⏸</span>
              </div>
              <div class="level-content">
                <div class="level-title">Level 1: Analyzing diff</div>
                <div class="level-status">Preparing to start...</div>
                <div class="progress-bar-container" style="display: none;">
                  <div class="barbershop-progress-bar">
                    <div class="barbershop-stripes"></div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="progress-level" id="level-2">
              <div class="level-icon">
                <span class="icon pending">⏸</span>
              </div>
              <div class="level-content">
                <div class="level-title">Level 2: File context</div>
                <div class="level-status">Pending</div>
                <div class="progress-bar-container" style="display: none;">
                  <div class="barbershop-progress-bar">
                    <div class="barbershop-stripes"></div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="progress-level" id="level-3">
              <div class="level-icon">
                <span class="icon pending">⏸</span>
              </div>
              <div class="level-content">
                <div class="level-title">Level 3: Codebase context</div>
                <div class="level-status">Pending</div>
                <div class="progress-bar-container" style="display: none;">
                  <div class="barbershop-progress-bar">
                    <div class="barbershop-stripes"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" id="run-background-btn" onclick="progressModal.runInBackground()">
            Run in Background
          </button>
          <button class="btn btn-danger" id="cancel-btn" onclick="progressModal.cancel()">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Show the modal
   * @param {string} analysisId - Analysis ID to track
   */
  show(analysisId) {
    this.currentAnalysisId = analysisId;
    this.isVisible = true;
    this.modal.style.display = 'flex';
    
    // Reset progress state
    this.resetProgress();
    
    // Start monitoring progress
    this.startProgressMonitoring();
  }

  /**
   * Hide the modal
   */
  hide() {
    this.isVisible = false;
    this.modal.style.display = 'none';
    
    // Don't stop monitoring if running in background
    if (!this.isRunningInBackground) {
      this.stopProgressMonitoring();
    }
  }

  /**
   * Run analysis in background
   */
  runInBackground() {
    this.isRunningInBackground = true;
    this.hide();
    
    // Show status indicator in toolbar
    if (window.statusIndicator) {
      window.statusIndicator.show(this.currentAnalysisId, 'AI analyzing...');
    }
  }

  /**
   * Cancel the analysis
   */
  async cancel() {
    if (!this.currentAnalysisId) {
      this.hide();
      return;
    }

    try {
      // Make cancel request (not implemented in backend yet, but structure ready)
      const response = await fetch(`/api/analyze/cancel/${this.currentAnalysisId}`, {
        method: 'POST'
      });

      if (response.ok) {
        this.updateStatus('Analysis cancelled');
      }
    } catch (error) {
      console.warn('Cancel not available on server:', error.message);
    }

    this.stopProgressMonitoring();
    this.hide();
    
    // Hide status indicator
    if (window.statusIndicator) {
      window.statusIndicator.hide();
    }
  }

  /**
   * Reset progress to initial state
   */
  resetProgress() {
    // Reset all levels to pending
    for (let i = 1; i <= 3; i++) {
      const level = document.getElementById(`level-${i}`);
      if (level) {
        const icon = level.querySelector('.icon');
        const status = level.querySelector('.level-status');
        
        icon.className = 'icon pending';
        icon.textContent = '⏸';
        status.textContent = 'Pending';
      }
    }
    
    // Set Level 1 as preparing
    const level1 = document.getElementById('level-1');
    if (level1) {
      const status = level1.querySelector('.level-status');
      status.textContent = 'Preparing to start...';
    }
  }

  /**
   * Start monitoring progress via Server-Sent Events (SSE)
   */
  startProgressMonitoring() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    if (!this.currentAnalysisId) return;

    // Connect to SSE endpoint
    this.eventSource = new EventSource(`/api/pr/${this.currentAnalysisId}/ai-suggestions/status`);
    
    this.eventSource.onopen = () => {
      console.log('Connected to progress stream');
    };

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          console.log('SSE connection established');
          return;
        }
        
        if (data.type === 'progress') {
          this.updateProgress(data);
          
          // Stop monitoring if analysis is complete or failed
          if (data.status === 'completed' || data.status === 'failed') {
            this.stopProgressMonitoring();
          }
        }
      } catch (error) {
        console.error('Error parsing SSE data:', error);
      }
    };

    this.eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      // Fallback to polling if SSE fails
      this.fallbackToPolling();
    };
  }

  /**
   * Fallback to polling if SSE fails
   */
  fallbackToPolling() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    this.statusCheckInterval = setInterval(async () => {
      if (!this.currentAnalysisId) return;
      
      try {
        const response = await fetch(`/api/analyze/status/${this.currentAnalysisId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        
        const status = await response.json();
        this.updateProgress(status);
        
        // Stop monitoring if analysis is complete or failed
        if (status.status === 'completed' || status.status === 'failed') {
          this.stopProgressMonitoring();
        }
      } catch (error) {
        console.error('Error checking analysis status:', error);
      }
    }, 1000); // Check every second
  }

  /**
   * Stop progress monitoring
   */
  stopProgressMonitoring() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Update progress based on status
   * @param {Object} status - Status object from server
   */
  updateProgress(status) {
    const currentLevel = status.level || 1;
    
    // Mark previous levels as completed when we move to a new level
    for (let i = 1; i < currentLevel; i++) {
      this.markLevelAsCompleted(i);
    }
    
    // Update current level status
    this.updateLevelProgress(currentLevel, status);
    
    // Update overall progress message
    this.updateStatus(status.progress || 'Running...');
    
    // Handle completion
    if (status.status === 'completed') {
      this.handleCompletion(status);
    } else if (status.status === 'failed') {
      this.handleFailure(status);
    }
  }

  /**
   * Mark a level as completed
   * @param {number} level - Level number to mark as completed
   */
  markLevelAsCompleted(level) {
    const levelElement = document.getElementById(`level-${level}`);
    if (!levelElement) return;
    
    const icon = levelElement.querySelector('.icon');
    const statusText = levelElement.querySelector('.level-status');
    const progressContainer = levelElement.querySelector('.progress-bar-container');
    
    icon.className = 'icon completed';
    icon.textContent = '✓';
    statusText.textContent = 'Completed';
    statusText.style.display = 'block';
    
    // Hide progress bar for completed levels
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
  }

  /**
   * Update a specific level's progress
   * @param {number} level - Level number (1, 2, or 3)
   * @param {Object} status - Status object
   */
  updateLevelProgress(level, status) {
    const levelElement = document.getElementById(`level-${level}`);
    if (!levelElement) return;
    
    const icon = levelElement.querySelector('.icon');
    const statusText = levelElement.querySelector('.level-status');
    const progressContainer = levelElement.querySelector('.progress-bar-container');
    
    // Update icon and status based on current state
    if (status.status === 'running' || status.status === 'started') {
      icon.className = 'icon active';
      icon.textContent = '▶';
      
      // Show progress bar for the current level and update status
      if (progressContainer && status.level === level) {
        statusText.style.display = 'none';
        progressContainer.style.display = 'block';
      } else {
        statusText.textContent = status.progress || 'In progress...';
        statusText.style.display = 'block';
        if (progressContainer) {
          progressContainer.style.display = 'none';
        }
      }
      
    } else if (status.status === 'completed' && status.completedLevel >= level) {
      this.markLevelAsCompleted(level);
    } else {
      // For pending or other states, hide progress bar
      if (progressContainer) {
        progressContainer.style.display = 'none';
      }
      statusText.style.display = 'block';
      
      if (status.status === 'pending') {
        statusText.textContent = 'Pending';
      }
    }
  }

  /**
   * Update general status message
   * @param {string} message - Status message
   */
  updateStatus(message) {
    // Could add a general status area if needed
    console.log('Progress:', message);
  }

  /**
   * Handle analysis completion
   * @param {Object} status - Final status object
   */
  handleCompletion(status) {
    // Mark levels as complete based on which level completed
    const completedLevel = status.completedLevel || status.level || 1;
    
    for (let i = 1; i <= completedLevel; i++) {
      this.updateLevelProgress(i, { 
        status: 'completed', 
        completedLevel: i,
        filesAnalyzed: status.result?.suggestions?.length || 0
      });
    }
    
    // Update button to show completion
    const runBackgroundBtn = document.getElementById('run-background-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    
    if (runBackgroundBtn) {
      runBackgroundBtn.textContent = `Level ${completedLevel} Analysis Complete`;
      runBackgroundBtn.disabled = true;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
    }
    
    // Update status indicator if in background
    if (this.isRunningInBackground && window.statusIndicator) {
      window.statusIndicator.showComplete(`Level ${completedLevel} analysis complete`);
    }
    
    // CRITICAL FIX: Automatically reload AI suggestions when analysis completes
    console.log('Analysis completed, reloading AI suggestions...');
    if (window.prManager && typeof window.prManager.loadAISuggestions === 'function') {
      window.prManager.loadAISuggestions()
        .then(() => {
          console.log('AI suggestions reloaded successfully');
          // Only auto-close after suggestions have loaded successfully
          if (this.isVisible) {
            setTimeout(() => {
              this.hide();
            }, 2000); // Reduced to 2 seconds since loading is complete
          }
        })
        .catch(error => {
          console.error('Error reloading AI suggestions:', error);
          // Still auto-close even if loading failed, but give more time for user to see error
          if (this.isVisible) {
            setTimeout(() => {
              this.hide();
            }, 5000);
          }
        });
    } else {
      console.warn('PRManager not available for automatic suggestion reload');
      // Auto-close after 3 seconds if no PR manager available
      if (this.isVisible) {
        setTimeout(() => {
          this.hide();
        }, 3000);
      }
    }
  }

  /**
   * Handle analysis failure
   * @param {Object} status - Error status object
   */
  handleFailure(status) {
    const currentLevel = status.level || 1;
    const levelElement = document.getElementById(`level-${currentLevel}`);
    
    if (levelElement) {
      const icon = levelElement.querySelector('.icon');
      const statusText = levelElement.querySelector('.level-status');
      
      icon.className = 'icon error';
      icon.textContent = '❌';
      statusText.textContent = 'Failed: ' + (status.error || 'Unknown error');
    }
    
    // Update buttons
    const runBackgroundBtn = document.getElementById('run-background-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    
    if (runBackgroundBtn) {
      runBackgroundBtn.textContent = 'Analysis Failed';
      runBackgroundBtn.disabled = true;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
    }
    
    // Update status indicator if in background
    if (this.isRunningInBackground && window.statusIndicator) {
      window.statusIndicator.showError('Analysis failed');
    }
  }

  /**
   * Reopen modal from background
   */
  reopenFromBackground() {
    this.isRunningInBackground = false;
    this.show(this.currentAnalysisId);
    
    // Hide status indicator
    if (window.statusIndicator) {
      window.statusIndicator.hide();
    }
  }
}

// Initialize global instance
window.progressModal = new ProgressModal();