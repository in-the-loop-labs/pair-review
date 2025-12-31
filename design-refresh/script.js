/**
 * Pair Review – Interactive Demo
 * Basic interactions for the design refresh prototype
 */

document.addEventListener('DOMContentLoaded', () => {
  // File tree navigation
  const fileItems = document.querySelectorAll('.file-item');
  fileItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      fileItems.forEach(f => f.classList.remove('active'));
      item.classList.add('active');

      // Scroll to file
      const targetId = item.getAttribute('href').slice(1);
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Finding items navigation
  const findingItems = document.querySelectorAll('.finding-item');
  findingItems.forEach(item => {
    item.addEventListener('click', () => {
      findingItems.forEach(f => f.classList.remove('active'));
      item.classList.add('active');
    });
  });

  // AI suggestion actions
  const adoptButtons = document.querySelectorAll('.ai-action-adopt');
  adoptButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const suggestion = btn.closest('.ai-suggestion');
      suggestion.style.transform = 'scale(0.98)';
      suggestion.style.opacity = '0.7';

      setTimeout(() => {
        suggestion.style.borderLeftColor = 'var(--color-success)';
        suggestion.style.transform = 'scale(1)';
        suggestion.style.opacity = '1';

        // Update progress
        updateProgress();
      }, 150);

      // Show adopted state
      btn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
        </svg>
        Adopted
      `;
      btn.disabled = true;
      btn.style.background = 'var(--bg-tertiary)';
      btn.style.color = 'var(--color-success)';
    });
  });

  // Dismiss buttons
  const dismissButtons = document.querySelectorAll('.ai-action-dismiss');
  dismissButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const suggestion = btn.closest('.ai-suggestion');
      suggestion.style.animation = 'none';
      suggestion.style.opacity = '0';
      suggestion.style.transform = 'translateX(-10px)';
      suggestion.style.transition = 'all 0.2s ease';

      setTimeout(() => {
        suggestion.style.height = suggestion.offsetHeight + 'px';
        suggestion.style.overflow = 'hidden';
        requestAnimationFrame(() => {
          suggestion.style.height = '0';
          suggestion.style.margin = '0';
          suggestion.style.padding = '0';
        });
      }, 200);

      setTimeout(() => {
        suggestion.remove();
      }, 400);
    });
  });

  // Progress tracking
  function updateProgress() {
    const progressFill = document.querySelector('.progress-fill');
    const progressCount = document.querySelector('.progress-count');

    const currentWidth = parseFloat(progressFill.style.width) || 50;
    const newWidth = Math.min(currentWidth + 25, 100);

    progressFill.style.width = newWidth + '%';

    const addressed = Math.round((newWidth / 100) * 4);
    progressCount.textContent = `${addressed} of 4 addressed`;
  }

  // Expand context buttons
  const expandButtons = document.querySelectorAll('.expand-context-btn');
  expandButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      btn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" class="spin">
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" opacity=".2"/>
          <path d="M8 1.5a6.5 6.5 0 00-6.5 6.5c0 .28.02.55.05.82l1.47-.18A5 5 0 018 3.5V1.5z"/>
        </svg>
        Loading...
      `;

      setTimeout(() => {
        btn.parentElement.innerHTML = `
          <span class="hunk-info" style="color: var(--text-tertiary); font-size: 0.75rem;">
            Context expanded (showing 23 more lines)
          </span>
        `;
      }, 600);
    });
  });

  // Submit review button
  const submitBtn = document.querySelector('.btn-primary');
  const reviewModal = document.querySelector('.review-modal');

  if (submitBtn && reviewModal) {
    submitBtn.addEventListener('click', () => {
      reviewModal.style.display = 'flex';
      reviewModal.style.animation = 'fadeIn 0.2s ease';

      // Animate modal content
      const modalContent = reviewModal.querySelector('.modal-content');
      modalContent.style.animation = 'slideUp 0.3s ease';
    });

    // Close modal
    const modalClose = reviewModal.querySelector('.modal-close');
    const modalBackdrop = reviewModal.querySelector('.modal-backdrop');
    const cancelBtn = reviewModal.querySelector('.btn-secondary');

    [modalClose, modalBackdrop, cancelBtn].forEach(el => {
      if (el) {
        el.addEventListener('click', () => {
          reviewModal.style.display = 'none';
        });
      }
    });
  }

  // Add comment button hover effect
  const diffLines = document.querySelectorAll('.diff-line.diff-addition');
  diffLines.forEach(line => {
    if (!line.querySelector('.add-comment-btn')) {
      const btn = document.createElement('button');
      btn.className = 'add-comment-btn';
      btn.title = 'Add comment';
      btn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
          <path d="M7.25 4.5a.75.75 0 011.5 0v2.75h2.75a.75.75 0 010 1.5H8.75v2.75a.75.75 0 01-1.5 0V8.75H4.5a.75.75 0 010-1.5h2.75V4.5z"/>
        </svg>
      `;
      line.appendChild(btn);
    }
  });

  // Re-analyze button
  const reanalyzeBtn = document.querySelector('.ai-quick-action');
  if (reanalyzeBtn) {
    reanalyzeBtn.addEventListener('click', () => {
      const originalText = reanalyzeBtn.innerHTML;
      reanalyzeBtn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" class="spin">
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" opacity=".2"/>
          <path d="M8 1.5a6.5 6.5 0 00-6.5 6.5c0 .28.02.55.05.82l1.47-.18A5 5 0 018 3.5V1.5z"/>
        </svg>
        Analyzing...
      `;
      reanalyzeBtn.disabled = true;

      setTimeout(() => {
        reanalyzeBtn.innerHTML = originalText;
        reanalyzeBtn.disabled = false;
      }, 2000);
    });
  }

  // Add spinning animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spin {
      animation: spin 0.8s linear infinite;
    }
  `;
  document.head.appendChild(style);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape to close modal
    if (e.key === 'Escape' && reviewModal?.style.display === 'flex') {
      reviewModal.style.display = 'none';
    }

    // Cmd/Ctrl + Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (reviewModal?.style.display === 'flex') {
        const submitBtn = reviewModal.querySelector('.modal-footer .btn-primary');
        if (submitBtn) {
          submitBtn.click();
        }
      }
    }
  });

  // Status selector
  const statusOptions = document.querySelectorAll('.status-option input');
  statusOptions.forEach(option => {
    option.addEventListener('change', () => {
      // Visual feedback
      const badge = option.nextElementSibling;
      badge.style.transform = 'scale(1.02)';
      setTimeout(() => {
        badge.style.transform = 'scale(1)';
      }, 150);
    });
  });

  console.log('Pair Review design prototype loaded');
});
