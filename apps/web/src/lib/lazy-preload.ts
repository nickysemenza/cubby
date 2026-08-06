/** Cache a dynamic-import loader so every intent signal shares one promise. */
export function createCachedLoader<T>(
  loader: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= loader());
}

export interface IdlePreloadTarget {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

/** Schedule a preload after paint, with a deterministic fallback for Safari. */
export function scheduleIdlePreload(
  target: IdlePreloadTarget,
  preload: () => void,
  options: { timeoutMs: number; fallbackMs: number },
): () => void {
  const idle = target.requestIdleCallback?.(preload, {
    timeout: options.timeoutMs,
  });
  if (idle !== undefined) return () => target.cancelIdleCallback?.(idle);
  const timer = target.setTimeout(preload, options.fallbackMs);
  return () => target.clearTimeout(timer);
}
