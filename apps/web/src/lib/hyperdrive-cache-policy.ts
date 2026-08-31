const maxAgeSeconds = 60;
const staleWhileRevalidateSeconds = 15;

/**
 * Desired account-level policy for HYPERDRIVE_CACHED and its browser guard.
 * Hyperdrive itself must still be updated through Wrangler; keeping the
 * timings together makes the application-side safety window one policy edit.
 */
export const HYPERDRIVE_CACHE_POLICY = {
  maxAgeSeconds,
  staleWhileRevalidateSeconds,
  freshReadSeconds:
    maxAgeSeconds + staleWhileRevalidateSeconds + staleWhileRevalidateSeconds,
} as const;
