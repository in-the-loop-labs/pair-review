// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MODULE_PATH = '../../public/js/utils/notification-sounds.js';

function getNotificationSoundsClass() {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  const mod = require(MODULE_PATH);
  return mod.NotificationSounds;
}

function createLocalStorage() {
  return {
    _store: {},
    getItem: vi.fn((key) => global.localStorage._store[key] ?? null),
    setItem: vi.fn((key, value) => { global.localStorage._store[key] = value; }),
    removeItem: vi.fn((key) => { delete global.localStorage._store[key]; }),
  };
}

describe('NotificationSounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.localStorage = createLocalStorage();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    global.document = { hidden: true };
    global.window = {
      location: { href: 'http://localhost/review' },
      focus: vi.fn(),
    };
    delete global.navigator;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete global.localStorage;
    delete global.fetch;
    delete global.document;
    delete global.window;
    delete global.navigator;
  });

  it('stores browser notification preferences in localStorage', () => {
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();

    notifications.setBrowserEnabled('analysis', true);

    expect(global.localStorage.setItem).toHaveBeenCalledWith('pair-review-browser-notify-analysis', 'true');
    expect(notifications.isBrowserEnabled('analysis')).toBe(true);
  });

  it('keeps legacy isEnabled/setEnabled aliases mapped to browser notifications', () => {
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();

    notifications.setEnabled('analysis', true);

    expect(notifications.isEnabled('analysis')).toBe(true);
    expect(global.localStorage.setItem).toHaveBeenCalledWith('pair-review-browser-notify-analysis', 'true');
  });

  it('does not invoke backend APIs for notifications', () => {
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();

    notifications.playChime();
    notifications.playIfEnabled('analysis');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requests browser notification permission', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    global.window.Notification = { permission: 'default', requestPermission };
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();

    const result = await notifications.requestBrowserPermission();

    expect(requestPermission).toHaveBeenCalled();
    expect(result).toBe('granted');
  });

  it('shows browser notifications when enabled, permitted, and hidden', async () => {
    const notificationCtor = vi.fn(function Notification() { this.close = vi.fn(); });
    notificationCtor.permission = 'granted';
    global.window.Notification = notificationCtor;
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();
    notifications.setBrowserEnabled('analysis', true);

    const didNotify = await notifications.showBrowserNotification('analysis', {
      title: 'Pair Review',
      body: 'Analysis complete',
      dedupeKey: 'analysis:123',
    });

    expect(didNotify).toBe(true);
    expect(notificationCtor).toHaveBeenCalledWith('Pair Review', expect.objectContaining({
      body: 'Analysis complete',
      tag: 'analysis:123',
      icon: '/favicon.png',
    }));
  });

  it('prefers service worker notifications when available', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    global.navigator = {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({}),
        ready: Promise.resolve({ showNotification }),
      },
    };
    const notificationCtor = vi.fn(function Notification() { this.close = vi.fn(); });
    notificationCtor.permission = 'granted';
    global.window.Notification = notificationCtor;
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();
    notifications.setBrowserEnabled('analysis', true);

    const didNotify = await notifications.showBrowserNotification('analysis', {
      title: 'Pair Review',
      body: 'Analysis complete',
      dedupeKey: 'analysis:123',
    });

    expect(didNotify).toBe(true);
    expect(global.navigator.serviceWorker.register).toHaveBeenCalledWith('/notification-service-worker.js');
    expect(showNotification).toHaveBeenCalledWith('Pair Review', expect.objectContaining({
      body: 'Analysis complete',
      tag: 'analysis:123',
      icon: '/favicon.png',
      data: { url: 'http://localhost/review' },
    }));
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('does not show browser notifications while visible unless forced', async () => {
    global.document.hidden = false;
    const notificationCtor = vi.fn(function Notification() { this.close = vi.fn(); });
    notificationCtor.permission = 'granted';
    global.window.Notification = notificationCtor;
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();
    notifications.setBrowserEnabled('analysis', true);

    expect(await notifications.showBrowserNotification('analysis')).toBe(false);
    expect(notificationCtor).not.toHaveBeenCalled();

    expect(await notifications.showBrowserNotification('analysis', { showWhenVisible: true })).toBe(true);
    expect(notificationCtor).toHaveBeenCalledOnce();
  });

  it('can show explicit test notifications without enabling an event preference', async () => {
    const notificationCtor = vi.fn(function Notification() { this.close = vi.fn(); });
    notificationCtor.permission = 'granted';
    global.window.Notification = notificationCtor;
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();

    expect(await notifications.showBrowserNotification('analysis', {
      showWhenVisible: true,
      ignorePreference: true,
    })).toBe(true);
    expect(notificationCtor).toHaveBeenCalledOnce();
  });

  it('dedupes repeated notifications', async () => {
    const notificationCtor = vi.fn(function Notification() { this.close = vi.fn(); });
    notificationCtor.permission = 'granted';
    global.window.Notification = notificationCtor;
    const NotificationSounds = getNotificationSoundsClass();
    const notifications = new NotificationSounds();
    notifications.setBrowserEnabled('analysis', true);

    expect(await notifications.notifyIfEnabled('analysis', { dedupeKey: 'analysis:123' })).toBe(true);
    expect(await notifications.notifyIfEnabled('analysis', { dedupeKey: 'analysis:123' })).toBe(false);

    expect(notificationCtor).toHaveBeenCalledOnce();
  });
});
