/** Navigation passes queued background work; running work is never interrupted.
 * A separate background cap reserves capacity even when every caller is busy. */
export function createConcurrencyLimiter(
  limit: number,
  { backgroundLimit = limit }: { backgroundLimit?: number } = {},
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(backgroundLimit) ||
    backgroundLimit < 1 ||
    backgroundLimit > limit
  )
    throw new Error(
      "Concurrency limits must be positive integers within total capacity",
    );
  let active = 0;
  let backgroundActive = 0;
  const queued: Array<{
    start: () => void;
    priority: "interactive" | "background";
    queuedAt: number;
  }> = [];
  const drain = () => {
    for (;;) {
      if (active >= limit) break;
      const interactive = queued.findIndex(
        (entry) => entry.priority === "interactive",
      );
      const index =
        interactive !== -1
          ? interactive
          : backgroundActive < backgroundLimit
            ? 0
            : -1;
      if (index === -1) break;
      const next = queued.splice(index, 1)[0];
      if (!next) break;
      next.start();
    }
  };
  const acquire = (
    priority: "interactive" | "background" = "interactive",
    signal?: AbortSignal,
  ): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const abort = () => {
        const index = queued.findIndex((entry) => entry.start === start);
        if (index !== -1) queued.splice(index, 1);
        reject(
          signal?.reason ??
            new DOMException("Queued work cancelled", "AbortError"),
        );
        drain();
      };
      const start = () => {
        signal?.removeEventListener("abort", abort);
        active += 1;
        if (priority === "background") backgroundActive += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active -= 1;
          if (priority === "background") backgroundActive -= 1;
          drain();
        });
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      queued.push({ start, priority, queuedAt: Date.now() });
      drain();
    });
  return {
    acquire,
    snapshot: () => ({
      active,
      backgroundActive,
      queued: queued.length,
      oldestQueuedMs: queued[0] ? Date.now() - queued[0].queuedAt : 0,
    }),
    async run<T>(
      work: () => Promise<T>,
      signal: AbortSignal,
      priority: "interactive" | "background" = "interactive",
    ): Promise<T> {
      const release = await acquire(priority, signal);
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
