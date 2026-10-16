import { getErrorMessage } from "@cubby/shared";

import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import type { TimingResult } from "~/lib/timing.contract";
import { db } from "~/server/db";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";
import {
  countProducts as countProductsRepo,
  pingDb,
} from "~/server/entity-kernel/repo/debug";

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

export const handlers: HttpRouteHandlers<Record<never, never>, "GET"> = {
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
      measure("db: count products", () => countProductsRepo(db).then(() => {})),
    ]);
    const dbParallelMs = Math.round(performance.now() - dbParallelStart);
    const dbParallelResult: TimingResult = {
      label: "db: parallel wall time (should ≈ max, not sum)",
      durationMs: dbParallelMs,
    };

    const release = requestUsdaRelease();
    const [usdaStatus, usdaBatch] = await Promise.all([
      measure("usda release: status()", () => release.status().then(() => {})),
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
};
