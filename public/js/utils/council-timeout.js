// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared per-provider timeout logic for the council config tabs.
 *
 * AdvancedConfigTab and VoiceCentricConfigTab both show a timeout dropdown and a
 * clock icon per voice plus one for orchestration/consolidation. They kept
 * separate copies of the same timeout methods, and the copies drifted apart
 * (e.g. the _defaultConfig() provider-default gap). This mixin is the single
 * copy.
 *
 * The tabs differ only in DOM shape, so each tab describes its own with a
 * static TIMEOUT_DOM:
 *
 *   static TIMEOUT_DOM = {
 *     panelId: 'tab-panel-advanced',          // panel inside the modal
 *     voiceWrapperClass: 'participant-wrapper', // wraps one voice row
 *     voiceKeys: ['level', 'index'],          // data-* attrs that identify a voice
 *     timeoutClass: 'adv-timeout',            // per-voice timeout select
 *     orchestrationTimeoutId: 'adv-orchestration-timeout',
 *     orchestrationToggleId: 'adv-orchestration-timeout-toggle',
 *     orchestrationRowId: 'orchestration-voice',
 *   };
 *
 * A voice is addressed by a key object holding its voiceKeys, e.g.
 * { level: '1', index: '0' } (Advanced) or { index: '0' } (Voice-centric).
 *
 * The host class must also define static DEFAULT_TIMEOUT and instance
 * `providers` and `modal`.
 */
(function () {
  /**
   * Timeout to use after a voice's provider changes. A value still at the old
   * provider's default follows the new default; a customised value is kept
   * unless the new default is longer.
   * @param {number} currentValue - Current timeout in ms
   * @param {number|null} oldDefault - Previous provider's default, or null if unknown
   * @param {number} newDefault - New provider's default
   * @returns {number} Timeout in ms
   */
  function resolveProviderSwitchTimeout(currentValue, oldDefault, newDefault) {
    return (oldDefault !== null && currentValue !== oldDefault)
      ? Math.max(currentValue, newDefault)
      : newDefault;
  }

  /**
   * Attribute selector for a voice key, e.g. '[data-level="1"][data-index="0"]'.
   * @param {string[]} voiceKeys
   * @param {Object} key
   * @returns {string}
   */
  function voiceKeySelector(voiceKeys, key) {
    return voiceKeys.map(k => `[data-${k}="${key[k]}"]`).join('');
  }

  const methods = {
    /**
     * Get the default timeout for a provider, falling back to the static DEFAULT_TIMEOUT.
     * @param {string} providerId - Provider ID (e.g., 'pi', 'claude')
     * @returns {number} Default timeout in ms
     */
    _getProviderDefaultTimeout(providerId) {
      const provider = this.providers[providerId];
      return provider?.defaultTimeout ?? this.constructor.DEFAULT_TIMEOUT;
    },

    /**
     * Update the clock/timeout icon styling to indicate non-default timeout.
     * @param {Element} panel - The council panel element
     * @param {Object} key - Voice key, e.g. { level, index } or { index }
     * @param {string} value - Current timeout value (as string of ms)
     */
    _updateTimeoutIcon(panel, key, value) {
      const dom = this.constructor.TIMEOUT_DOM;
      const keySel = voiceKeySelector(dom.voiceKeys, key);
      const wrapper = panel.querySelector(`.${dom.voiceWrapperClass}${keySel}`);
      const iconBtn = wrapper?.querySelector(`.toggle-timeout-icon${keySel}`);
      if (!iconBtn) return;

      const providerId = wrapper?.querySelector('.voice-provider')?.value;
      const defaultTimeout = this._getProviderDefaultTimeout(providerId);
      const isNonDefault = parseInt(value, 10) !== defaultTimeout;
      iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
    },

    _updateOrchestrationTimeoutIcon(panel, value) {
      const dom = this.constructor.TIMEOUT_DOM;
      const iconBtn = panel.querySelector(`#${dom.orchestrationToggleId}`);
      if (!iconBtn) return;

      const orchRow = panel.querySelector(`#${dom.orchestrationRowId}`);
      const providerId = orchRow?.querySelector('.voice-provider')?.value;
      const defaultTimeout = this._getProviderDefaultTimeout(providerId);
      const isNonDefault = parseInt(value, 10) !== defaultTimeout;
      iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
    },

    /**
     * When a voice's provider changes, update its timeout to the new provider's default,
     * preserving explicit user overrides via Math.max when the user had customized the value.
     * @param {HTMLSelectElement} providerSelect - The provider dropdown that changed
     */
    _applyProviderDefaultTimeout(providerSelect) {
      const dom = this.constructor.TIMEOUT_DOM;
      const panel = this.modal.querySelector(`#${dom.panelId}`);
      if (!panel) return;

      const providerId = providerSelect.value;
      const newDefault = this._getProviderDefaultTimeout(providerId);
      const oldProviderId = providerSelect.dataset.previousProvider;
      const oldDefault = oldProviderId ? this._getProviderDefaultTimeout(oldProviderId) : null;

      const isOrchestration = providerSelect.dataset.target === 'orchestration';
      if (isOrchestration) {
        const timeoutEl = panel.querySelector(`#${dom.orchestrationTimeoutId}`);
        if (timeoutEl) {
          const resolvedTimeout = resolveProviderSwitchTimeout(parseInt(timeoutEl.value, 10), oldDefault, newDefault);
          timeoutEl.value = String(resolvedTimeout);
          this._updateOrchestrationTimeoutIcon(panel, String(resolvedTimeout));
        }
      } else {
        const key = {};
        dom.voiceKeys.forEach(k => { key[k] = providerSelect.dataset[k]; });
        const wrapper = providerSelect.closest(`.${dom.voiceWrapperClass}`);
        const timeoutEl = wrapper?.querySelector(`.${dom.timeoutClass}`);
        if (timeoutEl) {
          const resolvedTimeout = resolveProviderSwitchTimeout(parseInt(timeoutEl.value, 10), oldDefault, newDefault);
          timeoutEl.value = String(resolvedTimeout);
          this._updateTimeoutIcon(panel, key, String(resolvedTimeout));
        }
      }

      providerSelect.dataset.previousProvider = providerId;
    },

    /**
     * Restore a voice's saved timeout into its (already mounted) timeout select.
     * Shows the select when the saved value differs from the provider's default;
     * with no saved value, applies the provider's default.
     * @param {Element} panel - The council panel element
     * @param {Object} key - Voice key, e.g. { level, index } or { index }
     * @param {HTMLSelectElement|null} timeoutEl - The voice's timeout select
     * @param {{provider: string, timeout?: number}} voice - Saved voice config
     */
    _restoreVoiceTimeout(panel, key, timeoutEl, voice) {
      const providerDefaultTimeout = this._getProviderDefaultTimeout(voice.provider);
      if (timeoutEl && voice.timeout) {
        timeoutEl.value = String(voice.timeout);
        // Show the dropdown if non-default for this provider
        if (voice.timeout !== providerDefaultTimeout) {
          timeoutEl.style.display = '';
        }
        this._updateTimeoutIcon(panel, key, String(voice.timeout));
      } else if (timeoutEl) {
        // No saved timeout — apply the provider's default
        timeoutEl.value = String(providerDefaultTimeout);
      }
    },

    /**
     * Restore the orchestration/consolidation timeout select and its icon.
     * @param {Element} panel - The council panel element
     * @param {{provider: string, timeout?: number}} orchestration - Saved orchestration config
     */
    _restoreOrchestrationTimeout(panel, orchestration) {
      const dom = this.constructor.TIMEOUT_DOM;
      const orchTimeoutSelect = panel.querySelector(`#${dom.orchestrationTimeoutId}`);
      const orchProviderDefaultTimeout = this._getProviderDefaultTimeout(orchestration.provider);
      if (orchTimeoutSelect && orchestration.timeout) {
        orchTimeoutSelect.value = String(orchestration.timeout);
        // Show the dropdown if non-default for this provider
        if (orchestration.timeout !== orchProviderDefaultTimeout) {
          orchTimeoutSelect.style.display = '';
        }
        this._updateOrchestrationTimeoutIcon(panel, String(orchestration.timeout));
      } else if (orchTimeoutSelect) {
        // No saved timeout — apply the provider's default
        orchTimeoutSelect.value = String(orchProviderDefaultTimeout);
        this._updateOrchestrationTimeoutIcon(panel, String(orchProviderDefaultTimeout));
      }
    },
  };

  /**
   * Copy the shared timeout methods onto a tab class's prototype.
   * @param {Function} TabClass - Class with static TIMEOUT_DOM and DEFAULT_TIMEOUT
   */
  function mixInto(TabClass) {
    Object.assign(TabClass.prototype, methods);
  }

  const CouncilTimeout = { resolveProviderSwitchTimeout, methods, mixInto };

  if (typeof window !== 'undefined') {
    window.CouncilTimeout = CouncilTimeout;
  }

  // Support CommonJS require() in unit tests while keeping the browser IIFE
  // behavior of assigning to window.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CouncilTimeout;
  }
})();
