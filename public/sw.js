/* CRM service worker: shows phone notifications (Web Push) and opens the right page when one is tapped.
   No offline caching — the CRM always loads fresh from the server. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'CRM', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'CRM';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '/dashboard' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/dashboard';
  // same site only
  const target = new URL(raw, self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin) && 'focus' in w) {
          return w.focus().then(() => ('navigate' in w ? w.navigate(url) : undefined));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
