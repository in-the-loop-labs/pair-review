// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Prefer an existing tab that is already showing the notified review.
    for (const client of windowClients) {
      if (client.url === targetUrl && 'focus' in client) {
        await client.focus();
        return;
      }
    }

    // Otherwise open a new tab directly to the review instead of clobbering an
    // unrelated pair-review tab the user may be actively using.
    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
