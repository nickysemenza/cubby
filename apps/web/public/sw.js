// Retired service worker. Cubby no longer installs as a PWA, but browsers that
// registered the old app-shell worker re-fetch this URL on navigation. Keep it
// here (do not delete it): this version has no fetch handler, clears every
// cache the old worker filled, unregisters itself, and reloads open pages so
// they stop being served from stale precached assets.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      } catch {
        // Best effort: unregistering below still stops the stale worker.
      }
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        try {
          await client.navigate(client.url);
        } catch {
          // The page may have closed or be cross-origin; it reloads on next visit.
        }
      }
    })(),
  );
});
