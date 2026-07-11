// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared CouncilDropdown component
 * (public/js/components/CouncilDropdown.js), used by both the repo settings page
 * and the global settings page.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const { CouncilDropdown } = require('../../public/js/components/CouncilDropdown.js');

const COUNCILS = [
  { id: 'c1', name: 'Security', type: 'advanced' },
  { id: 'c2', name: 'Perf', type: 'council' }
];

function mount() {
  document.body.innerHTML = '<div id="dd" class="custom-dropdown"></div>';
  return document.getElementById('dd');
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CouncilDropdown.typeBadge', () => {
  it('maps advanced and standard types', () => {
    expect(CouncilDropdown.typeBadge('advanced')).toEqual({ label: 'Advanced', cssClass: 'badge-advanced' });
    expect(CouncilDropdown.typeBadge('council')).toEqual({ label: 'Standard', cssClass: 'badge-standard' });
    expect(CouncilDropdown.typeBadge(undefined)).toEqual({ label: 'Standard', cssClass: 'badge-standard' });
  });
});

describe('CouncilDropdown rendering', () => {
  it('renders each council as an option with its type badge', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: COUNCILS });
    const options = container.querySelectorAll('.custom-dropdown-option');
    expect(options).toHaveLength(2); // no none option by default
    // Sorted alphabetically: Perf before Security.
    expect(options[0].textContent).toContain('Perf');
    expect(options[0].querySelector('.council-type-badge.badge-standard')).toBeTruthy();
    expect(options[1].textContent).toContain('Security');
    expect(options[1].querySelector('.council-type-badge.badge-advanced')).toBeTruthy();
  });

  it('shows a placeholder when nothing is selected and there is no none option', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: COUNCILS, placeholder: 'Select a council...' });
    expect(container.querySelector('.trigger-text.placeholder').textContent).toBe('Select a council...');
  });

  it('shows the emptyText when there are no councils and no none option', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: [], emptyText: 'No councils yet' });
    expect(container.querySelector('.trigger-text.placeholder').textContent).toBe('No councils yet');
  });

  it('reflects the selected council (name + badge) in the trigger', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: COUNCILS, selectedId: 'c1' });
    const trigger = container.querySelector('.custom-dropdown-trigger');
    expect(trigger.textContent).toContain('Security');
    expect(trigger.querySelector('.council-type-badge.badge-advanced')).toBeTruthy();
  });

  it('includeNone prepends a base option and shows its label when nothing is chosen', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: COUNCILS, includeNone: true, noneLabel: 'Default Provider / Model' });
    const options = container.querySelectorAll('.custom-dropdown-option');
    expect(options).toHaveLength(3);
    expect(options[0].dataset.value).toBe('');
    expect(options[0].textContent).toContain('Default Provider / Model');
    expect(options[0].classList.contains('selected')).toBe(true);
    // Trigger shows the none label (no placeholder styling).
    expect(container.querySelector('.custom-dropdown-trigger').textContent).toContain('Default Provider / Model');
  });

  it('escapes council names to prevent HTML injection', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: [{ id: 'x', name: '<img src=x>', type: 'council' }] });
    expect(container.innerHTML).not.toContain('<img src=x>');
    expect(container.innerHTML).toContain('&lt;img');
  });
});

describe('CouncilDropdown interaction', () => {
  it('opens on trigger click and calls onSelect + closes on option click', () => {
    const container = mount();
    const onSelect = vi.fn();
    new CouncilDropdown({ container, councils: COUNCILS, onSelect });

    container.querySelector('.custom-dropdown-trigger').click();
    expect(container.classList.contains('open')).toBe(true);

    // Click the "Security" option (c1).
    const secOption = [...container.querySelectorAll('.custom-dropdown-option')]
      .find(o => o.dataset.value === 'c1');
    secOption.click();

    expect(onSelect).toHaveBeenCalledWith('c1');
    expect(container.classList.contains('open')).toBe(false);
  });

  it('reports the base option as an empty-string selection', () => {
    const container = mount();
    const onSelect = vi.fn();
    new CouncilDropdown({ container, councils: COUNCILS, includeNone: true, noneLabel: 'Default Provider / Model', onSelect });
    const noneOption = container.querySelector('.custom-dropdown-option[data-value=""]');
    noneOption.click();
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('setSelected and setCouncils re-render', () => {
    const container = mount();
    const dd = new CouncilDropdown({ container, councils: COUNCILS });
    dd.setSelected('c2');
    expect(container.querySelector('.custom-dropdown-trigger').textContent).toContain('Perf');
    dd.setCouncils([{ id: 'c3', name: 'New One', type: 'advanced' }]);
    expect(container.textContent).toContain('New One');
    expect(container.textContent).not.toContain('Security');
  });

  it('disabled: renders a disabled trigger and wires no interaction', () => {
    const container = mount();
    const onSelect = vi.fn();
    new CouncilDropdown({ container, councils: COUNCILS, disabled: true, onSelect });
    const trigger = container.querySelector('.custom-dropdown-trigger');
    expect(trigger.disabled).toBe(true);
    trigger.click();
    expect(container.classList.contains('open')).toBe(false); // no listener attached
  });

  it('destroy removes the document outside-click listener', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const container = mount();
    const dd = new CouncilDropdown({ container, councils: COUNCILS });
    dd.destroy();
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('a fresh render de-duplicates the document outside-click listener', () => {
    const container = mount();
    const dd = new CouncilDropdown({ container, councils: COUNCILS });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    dd.render();
    // The prior handler is removed before the new one is added.
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function));
  });
});
