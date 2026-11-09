/** Delay for a zero-based consecutive reconnect attempt. */
export const reconnectDelay = (attempt: number): number =>
  Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
