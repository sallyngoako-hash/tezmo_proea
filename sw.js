/* TEZMO PRO service worker: receives signal pushes from the server and shows the phone notification. No caching, so updates are never blocked. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach((c) => c.postMessage({ type: 'signal', id: d.id || '' }));       /* the open app syncs at once */
    if (cs.some((c) => c.visibilityState === 'visible')) return;                  /* the open app shows the signal itself */
    await self.registration.showNotification(d.title || 'TEZMO PRO EA', {
      body: d.body || '', tag: d.id || 'tezmo-signal', renotify: false,           /* same signal id = one notification only */
      icon: '/icon-192.png', badge: '/icon-192.png', data: { id: d.id || '' },
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { await c.focus(); return; } }
    if (self.clients.openWindow) await self.clients.openWindow('/');
  })());
});
