export function isBypassedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/trpc/") ||
    pathname === "/trpc"
  );
}

/**
 * Whether a precache entry must land for the SW install to count as successful.
 *
 * Deliberately excludes `.wasm`: recipebridge is 2.5 MB (~1.0 MB gzip), ~80% of
 * the whole precache payload, and gating `install` on it means every SW update
 * blocks on that download — and fails the install outright on a flaky
 * connection. It stays in the precache manifest (so offline cost math still
 * works once it lands) but rides in the non-blocking `allSettled` set, and the
 * fetch handler falls back to the network when it hasn't been cached yet.
 */
export function isCriticalPrecacheUrl(url: string): boolean {
  return url === "/offline.html" || url.endsWith(".css");
}

/** Only heal exact, successful manifest assets; never cache query variants. */
export function shouldFillPrecache(
  pathname: string,
  search: string,
  responseOk: boolean,
  precacheUrls: ReadonlySet<string>,
): boolean {
  return responseOk && search === "" && precacheUrls.has(pathname);
}
