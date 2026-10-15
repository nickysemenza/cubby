/** Rejects a zero or negative literal at compile time. */
const positiveSeconds = <N extends number>(
  seconds: N & (`${N}` extends `-${string}` | "0" ? never : unknown),
) => seconds;

const maxAgeSeconds = 60;
// Must stay positive: `freshReadSeconds` keeps the browser strong beyond the
// complete bounded-stale window only because it adds this window twice.
const staleWhileRevalidateSeconds = positiveSeconds(15);

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
