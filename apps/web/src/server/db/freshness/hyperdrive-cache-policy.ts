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
 * Normal GitHub deployment applies this policy before publishing the Worker;
 * the member marker covers the entire bounded-stale window.
 */
export const HYPERDRIVE_CACHE_POLICY = {
  maxAgeSeconds,
  staleWhileRevalidateSeconds,
  // API clients may retain a verified old marker after the browser guard ends.
  markerValiditySeconds: 24 * 60 * 60,
  freshReadSeconds:
    maxAgeSeconds + staleWhileRevalidateSeconds + staleWhileRevalidateSeconds,
} as const;
