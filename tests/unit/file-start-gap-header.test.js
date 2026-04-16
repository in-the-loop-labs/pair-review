// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function createTestPRManager(lines) {
  const prManager = Object.create(PRManager.prototype);

  prManager.fetchFileContent = vi.fn().mockResolvedValue({ lines });
  prManager.renderDiffLine = vi.fn((container, lineData) => {
    const row = document.createElement('tr');
    row.className = 'd2h-cntx';
    row.dataset.lineNumber = String(lineData.oldNumber);

    const contentCell = document.createElement('td');
    contentCell.className = 'd2h-code-line-ctn';
    contentCell.textContent = lineData.content;
    row.appendChild(contentCell);

    container.appendChild(row);
    return row;
  });

  return prManager;
}

function createGapRowElement(fileName, startLine, endLine, position, startLineNew) {
  const row = document.createElement('tr');
  row.className = 'context-expand-row';

  const controls = {
    dataset: {
      fileName,
      startLine: String(startLine),
      endLine: String(endLine),
      position,
    }
  };

  if (startLineNew !== undefined && startLineNew !== null) {
    controls.dataset.startLineNew = String(startLineNew);
  }

  row.expandControls = controls;
  return row;
}

function createStartOfFileGapDOM({ gapStart, gapEnd, gapStartNew = 1, gapEndNew = gapEnd }) {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  document.body.appendChild(table);

  const gapRow = createGapRowElement('client.rb', gapStart, gapEnd, 'above', gapStartNew);
  gapRow.expandControls.dataset.endLineNew = String(gapEndNew);

  const boundaryHeader = document.createElement('tr');
  boundaryHeader.className = 'd2h-info';
  boundaryHeader.dataset.functionContext = 'module Clients';

  const firstHunkRow = document.createElement('tr');
  firstHunkRow.className = 'd2h-cntx';
  firstHunkRow.dataset.lineNumber = '1507';

  tbody.appendChild(gapRow);
  tbody.appendChild(boundaryHeader);
  tbody.appendChild(firstHunkRow);

  return { tbody, gapRow, boundaryHeader, firstHunkRow, controls: gapRow.expandControls };
}

function createMockGapFactory() {
  return vi.fn((fileName, startLine, endLine, _gapSize, position, _callback, startLineNew) =>
    createGapRowElement(fileName, startLine, endLine, position, startLineNew)
  );
}

describe('PRManager file-start gap header positioning', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    global.fetch = vi.fn();

    window.GapCoordinates = {
      getGapCoordinates: vi.fn()
    };

    window.HunkParser = {
      EOF_SENTINEL: -1,
      createGapRowElement: createMockGapFactory()
    };

    window.DiffRenderer = {
      removeStrandedHunkHeaders: vi.fn(),
      updateFunctionContextVisibility: vi.fn()
    };

    vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
      callback();
      return 0;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('removes the first hunk header after expanding all from a file-start gap', async () => {
    const prManager = createTestPRManager(['line 1', 'line 2', 'line 3']);
    const { tbody, boundaryHeader, firstHunkRow, controls } = createStartOfFileGapDOM({
      gapStart: 1,
      gapEnd: 3
    });

    window.GapCoordinates.getGapCoordinates.mockReturnValue({
      gapStart: 1,
      gapEnd: 3,
      gapStartNew: 1,
      gapEndNew: 3,
      offset: 0
    });

    window.DiffRenderer.removeStrandedHunkHeaders.mockImplementation(() => {
      boundaryHeader.remove();
    });

    await prManager.expandGapContext(controls, 'all', 3);

    expect(window.DiffRenderer.removeStrandedHunkHeaders).toHaveBeenCalledWith(tbody);
    expect(tbody.contains(boundaryHeader)).toBe(false);
    expect(firstHunkRow.previousElementSibling).not.toBe(boundaryHeader);
    expect([...tbody.querySelectorAll('tr[data-line-number]')].map((row) => row.dataset.lineNumber)).toEqual([
      '1',
      '2',
      '3',
      '1507'
    ]);
  });

  it('repositions the first hunk header to the new boundary after partial file-start expansion', async () => {
    const prManager = createTestPRManager(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    const { tbody, boundaryHeader, firstHunkRow, controls } = createStartOfFileGapDOM({
      gapStart: 1,
      gapEnd: 5
    });

    window.GapCoordinates.getGapCoordinates.mockReturnValue({
      gapStart: 1,
      gapEnd: 5,
      gapStartNew: 1,
      gapEndNew: 5,
      offset: 0
    });

    window.DiffRenderer.removeStrandedHunkHeaders.mockImplementation(() => {
      const gapRow = tbody.querySelector('tr.context-expand-row');
      if (gapRow) {
        gapRow.insertAdjacentElement('afterend', boundaryHeader);
      }
    });

    await prManager.expandGapContext(controls, 'up', 2);

    const gapRows = [...tbody.querySelectorAll('tr.context-expand-row')];

    expect(window.DiffRenderer.removeStrandedHunkHeaders).toHaveBeenCalledWith(tbody);
    expect(tbody.contains(boundaryHeader)).toBe(true);
    expect(gapRows).toHaveLength(1);
    expect(gapRows[0].expandControls.dataset.position).toBe('above');
    expect(gapRows[0].nextElementSibling).toBe(boundaryHeader);
    expect(boundaryHeader.nextElementSibling?.dataset.lineNumber).toBe('4');
    expect([...tbody.querySelectorAll('tr[data-line-number]')].map((row) => row.dataset.lineNumber)).toEqual([
      '4',
      '5',
      '1507'
    ]);
  });

  it('repositions the first hunk header after expanding a range within a file-start gap', async () => {
    const prManager = createTestPRManager(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    const { tbody, gapRow, boundaryHeader, firstHunkRow, controls } = createStartOfFileGapDOM({
      gapStart: 1,
      gapEnd: 5
    });

    window.GapCoordinates.getGapCoordinates.mockReturnValue({
      gapStart: 1,
      gapEnd: 5,
      gapStartNew: 1,
      gapEndNew: 5,
      offset: 0
    });

    window.DiffRenderer.removeStrandedHunkHeaders.mockImplementation(() => {
      const gapRowAfterSplit = tbody.querySelector('tr.context-expand-row');
      if (gapRowAfterSplit) {
        gapRowAfterSplit.insertAdjacentElement('afterend', boundaryHeader);
      }
    });

    await prManager.expandGapRange(gapRow, controls, 2, 3);

    const gapRows = [...tbody.querySelectorAll('tr.context-expand-row')];

    expect(window.DiffRenderer.removeStrandedHunkHeaders).toHaveBeenCalledWith(tbody);
    expect(tbody.contains(boundaryHeader)).toBe(true);
    expect(gapRows).toHaveLength(2);
    expect(gapRows[0].expandControls.dataset.position).toBe('above');
    expect(gapRows[1].expandControls.dataset.position).toBe('between');
    expect(gapRows[0].nextElementSibling).toBe(boundaryHeader);
    expect(firstHunkRow.previousElementSibling).not.toBe(boundaryHeader);
    expect([...tbody.querySelectorAll('tr[data-line-number]')].map((row) => row.dataset.lineNumber)).toEqual([
      '2',
      '3',
      '1507'
    ]);
  });

  it('passes expanded context lines to the renderer with a synthetic context prefix', async () => {
    const prManager = createTestPRManager(['  indented line', '    deeper indent', 'plain']);
    const { controls } = createStartOfFileGapDOM({
      gapStart: 1,
      gapEnd: 3
    });

    window.GapCoordinates.getGapCoordinates.mockReturnValue({
      gapStart: 1,
      gapEnd: 3,
      gapStartNew: 1,
      gapEndNew: 3,
      offset: 0
    });

    await prManager.expandGapContext(controls, 'all', 3);

    const renderedContents = prManager.renderDiffLine.mock.calls.map(([, lineData]) => lineData.content);
    expect(renderedContents).toEqual([
      '   indented line',
      '     deeper indent',
      ' plain'
    ]);
  });

  it('passes range-expanded context lines to the renderer with a synthetic context prefix', async () => {
    const prManager = createTestPRManager(['zero', '  indented two', '    indented four', 'tail']);
    const { gapRow, controls } = createStartOfFileGapDOM({
      gapStart: 1,
      gapEnd: 4
    });

    window.GapCoordinates.getGapCoordinates.mockReturnValue({
      gapStart: 1,
      gapEnd: 4,
      gapStartNew: 1,
      gapEndNew: 4,
      offset: 0
    });

    await prManager.expandGapRange(gapRow, controls, 2, 3);

    const renderedContents = prManager.renderDiffLine.mock.calls.map(([, lineData]) => lineData.content);
    expect(renderedContents).toEqual([
      '   indented two',
      '     indented four'
    ]);
  });
});
