/// <reference lib="webworker" />
import {
  isBypassedPath,
  isCriticalPrecacheUrl,
  shouldFillPrecache,
} from "./sw-policy";

/**
 * Cubby service worker (app-shell offline).
 *
 * Scope: this is a CLIENT artifact served as a static asset from `dist/client`.
 * It runs in the browser, NOT inside the Cloudflare Worker — SSR is untouched.
 *
 * Strategy (see docs/plans/2026-06-02-mobile-web-implementation-plan.md):
 *  - Precache the build's hashed static assets + WASM blobs (injected
 *    `__WB_MANIFEST`) + the `/offline` page, for instant warm loads and so the
 *    scanner / cost math survive a flaky network.
 *  - Navigations: network-first; if the network is unreachable, serve the
 *    precached `/offline` page. Successful navigation responses are NEVER
 *    cached — they may be authenticated, server-rendered HTML.
 *  - `/api/*`, `/trpc/*`, and auth endpoints are bypassed entirely: the SW does
 *    not call respondWith for them, so nothing stale or auth-sensitive is served.
 *
 * Hand-rolled (no Workbox runtime deps) to keep the dependency surface small and
 * the caching rules explicit. scripts/build-sw.mjs bundles this file and replaces
 * `self.__WB_MANIFEST` with the precache list after the client build.
 */

// The WebWorker lib types `self` as the generic WorkerGlobalScope; alias it to
// the service-worker scope so lifecycle/client/fetch events type correctly.
const sw = self as unknown as ServiceWorkerGlobalScope;

// A standalone static page (NOT a router route) so it can be served as a
// navigation fallback without booting the SPA / causing a hydration mismatch.
const OFFLINE_URL = "/offline.html";

// Precache list, injected at build time: scripts/build-sw.mjs replaces the
// `self.__WB_MANIFEST` token via esbuild define. Keep it as a bare `self.`
// member access so that replacement matches.
const manifest: Array<{ url: string; revision: string | null }> =
  // @ts-expect-error -- __WB_MANIFEST is injected by the build, not a real type
  self.__WB_MANIFEST;

// Cache name is keyed to the build: a digest of every asset revision changes
// whenever the build output changes. An updated worker waits until the old
// worker controls no clients, then activation safely drops the old cache.
const BUILD_TAG = manifest
  .map((e) => e.revision ?? e.url)
  .join("|")
  .split("")
  .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
const CACHE_NAME = `cubby-shell-${BUILD_TAG >>> 0}`;

// URLs to precache: every build asset plus the offline fallback page.
const PRECACHE_URLS = [
  ...new Set([...manifest.map((e) => e.url), OFFLINE_URL]),
];
const PRECACHE_URL_SET = new Set(PRECACHE_URLS);

// Paths the SW must NEVER intercept — always hit the network directly so auth
// and data are never served from cache.
sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const critical = PRECACHE_URLS.filter(isCriticalPrecacheUrl);
      const optional = PRECACHE_URLS.filter(
        (url) => !isCriticalPrecacheUrl(url),
      );
      // A Worker without its offline page or styles is not a viable offline
      // shell. Fail installation so the previous complete SW remains. The WASM
      // is deliberately NOT in this set (see `isCriticalPrecacheUrl`) — it's
      // ~80% of the payload, and the fetch handler falls back to the network
      // for anything the optional pass didn't manage to cache.
      await cache.addAll(
        critical.map((url) => new Request(url, { cache: "reload" })),
      );
      await Promise.allSettled(
        optional.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      );
      // Do not skip waiting: force-activating this worker would mix its cache
      // with pages still executing the previous deployment's application code.
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("cubby-shell-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      // Do not claim already-open pages. They keep one internally-consistent
      // worker/cache generation until their next normal navigation.
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs; let everything else hit the network.
  if (request.method !== "GET" || url.origin !== sw.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  // Navigations: network-first, fall back to the precached offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const offline = await cache.match(OFFLINE_URL);
          return (
            offline ??
            new Response("Offline", { status: 503, statusText: "Offline" })
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first against the precache, fall back to network.
  // If a best-effort precache entry failed during install, a later successful
  // request fills that exact manifest entry so offline coverage heals itself.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (
        shouldFillPrecache(
          url.pathname,
          url.search,
          response.ok,
          PRECACHE_URL_SET,
        )
      ) {
        // Best-effort heal: a quota failure must not fail an asset that fetched fine.
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })(),
  );
});
