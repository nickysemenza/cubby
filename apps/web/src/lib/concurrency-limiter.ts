export const abortError = () =>
  new DOMException("Request cancelled", "AbortError");

/** Run at most `limit` tasks at once, FIFO; a task whose signal aborts while
 * queued is dropped without ever starting. */
export function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queued: Array<() => void> = [];
  const drain = () => {
    const slots = limit - active;
    for (let index = 0; index < slots; index += 1) {
      const next = queued.shift();
      if (!next) break;
      next();
    }
  };
  return {
    run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          const index = queued.indexOf(start);
          if (index !== -1) queued.splice(index, 1);
          reject(abortError());
        };
        const start = () => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            abort();
            return;
          }
          active += 1;
          Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        queued.push(start);
        drain();
      });
    },
  };
}

/**
 * Run `work` over `items`, at most `limit` at once. After a failure no new
 * item starts; the started ones settle before the first failure is thrown,
 * so no work outlives the caller (or its database scope).
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !failures.length) {
        try {
          await work(items[next++]!);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw failures[0];
}
