/** A page keeps its limiter across input changes; obsolete work cannot open a second pool.
 * Each in-flight request pins a Neon backend and an AI Gateway call: on 2026-09-21 a
 * 32-wide burst from one page pinned enough backends to OOM the 1 GB / 0.25 CU compute
 * for ~80s (37 failed suggestFields plus every other query in that window) and produced
 * 135 AI Gateway 429s. Halving to 16 leaves total work unchanged — rows just fill in
 * later — until Jev response caching removes the redundant calls entirely. */
export function createSuggestionScheduler(limit = 16) {
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
          reject(
            new DOMException("Suggestion request cancelled", "AbortError"),
          );
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
