import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { db } from "~/server/db";
import {
  countProducts as countProductsRepo,
  pingDb,
} from "~/server/repo/debug";
import { requestUsdaRelease } from "~/server/usda-release/client";

const timingResultSchema = z.object({
  label: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const timingResponseSchema = z.object({
  results: z.array(timingResultSchema),
  totalMs: z.number(),
});

export type TimingResult = z.infer<typeof timingResultSchema>;
export type TimingResponse = z.infer<typeof timingResponseSchema>;

async function measure(
  label: string,
  fn: () => Promise<void>,
): Promise<TimingResult> {
  const start = performance.now();
  try {
    await fn();
    return { label, durationMs: Math.round(performance.now() - start) };
  } catch (e) {
    return {
      label,
      durationMs: Math.round(performance.now() - start),
      error: getErrorMessage(e),
    };
  }
}

export const Route = createFileRoute("/api/debug/timing")({
  server: {
    handlers: {
      GET: async () => {
        // This endpoint leaks DB latencies and upstream service URLs (topology),
        // so it is a dev-only diagnostic. Gate on the same PROD signal the app
        // uses elsewhere (router.tsx); return 404 in production so it is
        // indistinguishable from a nonexistent route.
        if (import.meta.env.PROD) {
          return new Response("Not Found", { status: 404 });
        }

        const overallStart = performance.now();

        // Run DB queries in parallel to verify they use separate connections
        const dbParallelStart = performance.now();
        const [selectOne, countProducts] = await Promise.all([
          measure("db: SELECT 1", () => pingDb(db)),
          measure("db: count products", () =>
            countProductsRepo(db).then(() => {}),
          ),
        ]);
        const dbParallelMs = Math.round(performance.now() - dbParallelStart);
        const dbParallelResult: TimingResult = {
          label: "db: parallel wall time (should ≈ max, not sum)",
          durationMs: dbParallelMs,
        };

        const release = requestUsdaRelease();
        const [usdaStatus, usdaBatch] = await Promise.all([
          measure("usda release: status()", () =>
            release.status().then(() => {}),
          ),
          // An empty batch measures the Durable Object round trip alone.
          measure("usda release: lookupBatch([])", () =>
            release.lookupBatch([]).then(() => {}),
          ),
        ]);

        const results: TimingResult[] = [
          selectOne,
          countProducts,
          dbParallelResult,
          usdaStatus,
          usdaBatch,
        ];

        const totalMs = Math.round(performance.now() - overallStart);

        return new Response(JSON.stringify({ results, totalMs }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
