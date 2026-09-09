// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the real ConfirmDialog component.
 *
 * Focus: the opt-in `checkboxLabel` option added for the chat model-switch
 * explainer. ConfirmDialog is a shared singleton with nine callers, so the
 * important guarantees are that (a) callers who pass no `checkboxLabel` see
 * exactly what they saw before, and (b) a previous caller's checked state can
 * never leak into the next dialog.
 *
 * jsdom notes:
 * - Requiring the module runs its `window.confirmDialog` bootstrap. Each test
 *   builds its own instance; `createModal()` removes the previous
 *   `#confirm-dialog` node, so the singleton never interferes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ConfirmDialog } = require('../../public/js/components/ConfirmDialog.js');

/** @type {ConfirmDialog} */
let dialog;

/** Click the dialog's confirm button (goes through the real delegated handler). */
function clickConfirm() {
  dialog.modal.querySelector('#confirm-dialog-btn').click();
}

/** Click the dialog's cancel button. */
function clickCancel() {
  dialog.modal.querySelector('.modal-footer [data-action="cancel"]').click();
}

/** Click the dialog's secondary button. */
function clickSecondary() {
  dialog.modal.querySelector('#confirm-dialog-secondary-btn').click();
}

/** The rendered checkbox row, or null when the dialog has none. */
function checkboxRow() {
  return dialog.modal.querySelector('.confirm-dialog__checkbox');
}

beforeEach(() => {
  document.body.innerHTML = '';
  dialog = new ConfirmDialog();
});

describe('ConfirmDialog', () => {
  describe('checkbox opt-in', () => {
    it('renders no checkbox when checkboxLabel is omitted', async () => {
      const promise = dialog.show({ title: 'T', message: 'M' });

      expect(checkboxRow()).toBeNull();
      expect(dialog.checkboxEl).toBeNull();

      clickCancel();
      await promise;
    });

    it('renders a checkbox row between the message and the buttons when checkboxLabel is set', async () => {
      const promise = dialog.show({ message: 'M', checkboxLabel: "Don't ask again" });

      const row = checkboxRow();
      expect(row).not.toBeNull();
      expect(row.tagName).toBe('LABEL');
      // Lives inside the body (after the message), not in the footer.
      expect(row.parentElement.classList.contains('modal-body')).toBe(true);
      const message = dialog.modal.querySelector('#confirm-dialog-message');
      expect(message.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();

      const input = row.querySelector('input[type="checkbox"]');
      expect(input).not.toBeNull();
      expect(input.checked).toBe(false);
      expect(row.textContent).toContain("Don't ask again");

      clickCancel();
      await promise;
    });

    it('passes checkboxChecked: true to onConfirm when the box is ticked', async () => {
      const onConfirm = vi.fn();
      const promise = dialog.show({ message: 'M', checkboxLabel: 'Ack', onConfirm });

      dialog.modal.querySelector('.confirm-dialog__checkbox input').checked = true;
      clickConfirm();
      await promise;

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith({ checkboxChecked: true });
    });

    it('passes checkboxChecked: false to onConfirm when the box is left alone', async () => {
      const onConfirm = vi.fn();
      const promise = dialog.show({ message: 'M', checkboxLabel: 'Ack', onConfirm });

      clickConfirm();
      await promise;

      expect(onConfirm).toHaveBeenCalledWith({ checkboxChecked: false });
    });

    it('passes checkboxChecked: false to onConfirm when no checkbox was requested', async () => {
      const onConfirm = vi.fn();
      const promise = dialog.show({ message: 'M', onConfirm });

      clickConfirm();
      await promise;

      expect(onConfirm).toHaveBeenCalledWith({ checkboxChecked: false });
    });
  });

  describe('state reset between shows', () => {
    it('does not leak a ticked checkbox into the next dialog with a checkbox', async () => {
      const first = dialog.show({ message: 'first', checkboxLabel: 'Ack' });
      dialog.modal.querySelector('.confirm-dialog__checkbox input').checked = true;
      clickConfirm();
      await first;

      const onConfirm = vi.fn();
      const second = dialog.show({ message: 'second', checkboxLabel: 'Ack', onConfirm });

      expect(dialog.modal.querySelectorAll('.confirm-dialog__checkbox').length).toBe(1);
      expect(dialog.modal.querySelector('.confirm-dialog__checkbox input').checked).toBe(false);

      clickConfirm();
      await second;
      expect(onConfirm).toHaveBeenCalledWith({ checkboxChecked: false });
    });

    it('removes the checkbox entirely for a following caller that asks for none', async () => {
      const first = dialog.show({ message: 'first', checkboxLabel: 'Ack' });
      dialog.modal.querySelector('.confirm-dialog__checkbox input').checked = true;
      clickCancel();
      await first;

      // hide() already tore it down.
      expect(checkboxRow()).toBeNull();

      const onConfirm = vi.fn();
      const second = dialog.show({ message: 'second', onConfirm });
      expect(checkboxRow()).toBeNull();
      expect(dialog.checkboxEl).toBeNull();

      clickConfirm();
      await second;
      expect(onConfirm).toHaveBeenCalledWith({ checkboxChecked: false });
    });

    it('clears the checkbox reference on hide()', async () => {
      const promise = dialog.show({ message: 'M', checkboxLabel: 'Ack' });
      expect(dialog.checkboxEl).not.toBeNull();

      clickCancel();
      await promise;

      expect(dialog.checkboxEl).toBeNull();
    });
  });

  describe('unchanged behaviour for existing callers', () => {
    it('resolves to the string "confirm"', async () => {
      const promise = dialog.show({ message: 'M' });
      clickConfirm();
      await expect(promise).resolves.toBe('confirm');
    });

    it('resolves to the string "cancel"', async () => {
      const promise = dialog.show({ message: 'M' });
      clickCancel();
      await expect(promise).resolves.toBe('cancel');
    });

    it('resolves to the string "secondary"', async () => {
      const promise = dialog.show({ message: 'M', secondaryText: 'Third option' });
      clickSecondary();
      await expect(promise).resolves.toBe('secondary');
    });

    it('resolves to "confirm" even with a checkbox present', async () => {
      const promise = dialog.show({ message: 'M', checkboxLabel: 'Ack' });
      dialog.modal.querySelector('.confirm-dialog__checkbox input').checked = true;
      clickConfirm();
      await expect(promise).resolves.toBe('confirm');
    });

    it('keeps btn-danger as the default confirm class', async () => {
      const promise = dialog.show({ message: 'M' });
      const btn = dialog.modal.querySelector('#confirm-dialog-btn');
      expect(btn.classList.contains('btn-danger')).toBe(true);
      clickCancel();
      await promise;
    });

    it('honours an explicit confirmClass without leaving the default behind', async () => {
      const promise = dialog.show({ message: 'M', confirmClass: 'btn-primary' });
      const btn = dialog.modal.querySelector('#confirm-dialog-btn');
      expect(btn.classList.contains('btn-primary')).toBe(true);
      expect(btn.classList.contains('btn-danger')).toBe(false);
      clickCancel();
      await promise;
    });

    it('sets the message via textContent so newlines survive for pre-line rendering', async () => {
      const promise = dialog.show({ message: 'One.\n\nTwo.' });
      expect(dialog.modal.querySelector('#confirm-dialog-message').textContent)
        .toBe('One.\n\nTwo.');
      clickCancel();
      await promise;
    });

    it('still tracks isVisible across show/hide', async () => {
      const promise = dialog.show({ message: 'M', checkboxLabel: 'Ack' });
      expect(dialog.isVisible).toBe(true);
      clickCancel();
      await promise;
      expect(dialog.isVisible).toBe(false);
    });
  });
});
