import type { RunStepPageSample } from "@cubby/schemas/run-step";

import { withDatabaseOperationMetrics } from "~/server/db/db-observability";

/** Phase wall times (ms) and peak in-flight work one page measured itself. */
type PageWorkSample = Pick<RunStepPageSample, "timings" | "concurrency">;

/**
 * Where one step page spends its time. A driver times its phases here, or
 * adds the sample its repository already measured; the step stores the
 * result as `RunStep.meta.page`. Repeated phases add up; peaks keep the max.
 */
export type PageWork = {
  time<T>(phase: string, work: () => Promise<T>): Promise<T>;
  add(sample: PageWorkSample): void;
};

/**
 * Runs one page with a fresh recorder and counts its queries through the
 * traced pg pool's metrics. A page that recorded no phase stores no sample,
 * so readers say "not measured"; zero counted queries means the page ran
 * outside the traced pool, so the count is null rather than 0.
 */
export async function measurePage<T>(
  page: (work: PageWork) => Promise<T>,
): Promise<{ result: T; sample: RunStepPageSample | null }> {
  const startedAt = performance.now();
  const timings: Record<string, number> = {};
  const concurrency: Record<string, number> = {};
  const add = (sample: PageWorkSample) => {
    for (const [phase, ms] of Object.entries(sample.timings))
      timings[phase] = (timings[phase] ?? 0) + Math.round(ms);
    for (const [phase, peak] of Object.entries(sample.concurrency ?? {}))
      concurrency[phase] = Math.max(concurrency[phase] ?? 0, peak);
  };
  const work: PageWork = {
    add,
    time: async (phase, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        add({ timings: { [phase]: performance.now() - started } });
      }
    },
  };
  return withDatabaseOperationMetrics(async (metrics) => {
    const result = await page(work);
    if (!Object.keys(timings).length) return { result, sample: null };
    return {
      result,
      sample: {
        wallMs: Math.round(performance.now() - startedAt),
        ...(metrics.queryCount ||
        metrics.acquireCount ||
        metrics.clientQueueCount
          ? {
              database: {
                queryTotalMs: Math.round(metrics.queryDurationSumMs),
                queryActiveWallMs: Math.round(metrics.queryActiveWallMs),
                queryMaxMs: Math.round(metrics.queryMaxDurationMs),
                poolWaitTotalMs: Math.round(metrics.acquireDurationSumMs),
                poolWaitActiveWallMs: Math.round(metrics.acquireActiveWallMs),
                clientQueueTotalMs: Math.round(
                  metrics.clientQueueDurationSumMs,
                ),
                clientQueueActiveWallMs: Math.round(
                  metrics.clientQueueActiveWallMs,
                ),
              },
            }
          : {}),
        timings,
        queries: metrics.queryCount || null,
        ...(Object.keys(concurrency).length && { concurrency }),
      },
    };
  });
}

/** `forEachConcurrently` starts `min(limit, items)` workers at once. */
export const peakWorkers = (limit: number, items: number) =>
  Math.min(limit, items);
