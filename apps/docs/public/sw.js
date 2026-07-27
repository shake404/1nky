// Self-destroying service worker.
//
// docs.1nky.com briefly served the 1NKY PWA during a deploy mistake, which
// registered the app's service worker on THIS origin. That stale worker then
// hijacked navigations here and served the app shell instead of the docs.
//
// This replaces it: when a browser update-checks /sw.js (it does so on
// navigation and periodically), it gets this worker, which clears every cache
// this origin holds, unregisters itself, and reloads open docs tabs so they
// fetch the real docs from the network. After one visit the origin is clean.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* nothing to clear */
      }
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })(),
  );
});
