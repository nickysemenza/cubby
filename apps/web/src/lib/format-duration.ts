/** Adaptive precision (`999ms`, `12.8s`, `1m 1s`, `6h 39m`), for latencies and run times. */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs >= 3_600_000) {
    const roundedMinutes = Math.round(durationMs / 60_000);
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;
}

/** Whole seconds, then `m ss` (`45s`, `3m 07s`), for estimates and elapsed time. */
export function formatMinutesSeconds(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
