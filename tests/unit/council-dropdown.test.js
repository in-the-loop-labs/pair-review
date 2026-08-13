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
  });

  // REGRESSION (integration review, defect 4): a legacy row predating the
  // `type` column badged as "Standard" here while CouncilManager's list rows
  // (which normalize via `_effectiveType`) badged the SAME council "Advanced" —
  // both visible at once on /settings, ~30px apart. An untyped row holds a
  // level-keyed config, `AdvancedConfigTab.loadCouncils` claims it, and
  // POST /api/councils stores `type || 'advanced'`, so Advanced is the truth.
  it('treats a missing type as advanced (legacy, level-centric rows)', () => {
    for (const type of [undefined, null, '']) {
      expect(CouncilDropdown.typeBadge(type)).toEqual({ label: 'Advanced', cssClass: 'badge-advanced' });
    }
  });

  it('badges an untyped council as Advanced in both the option list and the trigger', () => {
    const legacy = [{ id: 'legacy', name: 'Old Council' }];
    const container = mount();
    new CouncilDropdown({ container, councils: legacy, selectedId: 'legacy' });

    const option = container.querySelector('.custom-dropdown-option .council-type-badge');
    expect(option.textContent).toBe('Advanced');
    expect(option.classList.contains('badge-advanced')).toBe(true);

    const trigger = container.querySelector('.custom-dropdown-trigger .council-type-badge');
    expect(trigger.textContent).toBe('Advanced');
    expect(container.querySelector('.badge-standard')).toBeNull();
  });
});

describe('CouncilDropdown.sourceBadge', () => {
  it('badges file-overlay councils and nothing else', () => {
    expect(CouncilDropdown.sourceBadge({ id: 'file:x', name: 'X', source: 'file' }))
      .toEqual({ label: 'File', cssClass: 'badge-file' });
    expect(CouncilDropdown.sourceBadge({ id: 'c1', name: 'X', source: 'db' })).toBeNull();
    expect(CouncilDropdown.sourceBadge({ id: 'c1', name: 'X' })).toBeNull();
    expect(CouncilDropdown.sourceBadge(null)).toBeNull();
    expect(CouncilDropdown.sourceBadge(undefined)).toBeNull();
  });
});

describe('CouncilDropdown file councils', () => {
  const MIXED = [
    { id: 'c1', name: 'Db Council', type: 'council', source: 'db' },
    { id: 'file:dream', name: 'File Council', type: 'advanced', source: 'file' }
  ];

  it('renders the File badge alongside the type badge for file councils only', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: MIXED });
    const options = container.querySelectorAll('.custom-dropdown-option');
    // Sorted alphabetically: "Db Council" before "File Council".
    const dbOption = options[0];
    const fileOption = options[1];

    expect(dbOption.textContent).toContain('Db Council');
    expect(dbOption.querySelector('.council-type-badge.badge-standard')).toBeTruthy();
    expect(dbOption.querySelector('.badge-file')).toBeNull();

    expect(fileOption.textContent).toContain('File Council');
    // Both badges: the type badge stays, the File badge is additive.
    expect(fileOption.querySelectorAll('.council-type-badge')).toHaveLength(2);
    expect(fileOption.querySelector('.council-type-badge.badge-advanced')).toBeTruthy();
    const fileBadge = fileOption.querySelector('.council-type-badge.badge-file');
    expect(fileBadge).toBeTruthy();
    expect(fileBadge.textContent).toBe('File');
  });

  it('shows the File badge in the trigger when a file council is selected', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: MIXED, selectedId: 'file:dream' });
    const trigger = container.querySelector('.custom-dropdown-trigger');
    expect(trigger.textContent).toContain('File Council');
    expect(trigger.querySelector('.council-type-badge.badge-file')).toBeTruthy();
  });

  it('shows no File badge in the trigger when a db council is selected', () => {
    const container = mount();
    new CouncilDropdown({ container, councils: MIXED, selectedId: 'c1' });
    const trigger = container.querySelector('.custom-dropdown-trigger');
    expect(trigger.textContent).toContain('Db Council');
    expect(trigger.querySelector('.badge-file')).toBeNull();
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
