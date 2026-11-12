/**
 * The session the server already read for the page request. The first
 * `/get-session` the auth client issues after hydration answers from it, so a
 * document load does not repeat the lookup. Expiry, refresh and later reads
 * stay with the server: only that one fresh, unparameterized GET is served.
 */
/** The `/get-session` response body, as JSON text. */
export type SessionSeed = string;

const SEED_LIFETIME_MS = 30_000;
let seeded = false;
let seed: { body: string; at: number } | null = null;

export function seedClientSession(value: SessionSeed | null): void {
  if (seeded || value === null || typeof window === "undefined") return;
  seeded = true;
  seed = { body: value, at: Date.now() };
}

const isFirstSessionRead = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const url = new URL(request?.url ?? String(input), window.location.origin);
  return (
    url.pathname.endsWith("/get-session") &&
    !url.searchParams.has("disableCookieCache")
  );
};

/** `fetch` for the auth client: serves the seeded session once, then defers. */
export const sessionSeededFetch: typeof fetch = (input, init) => {
  if (
    seed !== null &&
    Date.now() - seed.at < SEED_LIFETIME_MS &&
    isFirstSessionRead(input, init)
  ) {
    const { body } = seed;
    seed = null;
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );
  }
  seed = null;
  return fetch(input, init);
};
