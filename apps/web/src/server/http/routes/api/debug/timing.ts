import { getErrorMessage } from "@cubby/shared";

import { env } from "~/env";
import type { HttpRouteHandlers } from "~/lib/http/route-handler";
import type { TimingResult } from "~/lib/perf/timing.contract";
import { lookupUPCitemdb } from "~/server/clients/upc/upcitemdb";
import { db } from "~/server/db";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";
import {
  countProducts as countProductsRepo,
  pingDb,
} from "~/server/entity-kernel/repo/debug";
import {
  authenticate,
  BROWSER_AUTH,
  isChallenge,
} from "~/server/http/authenticate";

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
  GET: async ({ request }) => {
    // Production diagnostics expose infrastructure details only to members.
    const authenticated = await authenticate(request, BROWSER_AUTH);
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    if (isChallenge(authenticated))
      return Response.json(
        { error: authenticated.message },
        { status: authenticated.status, headers },
      );
    authenticated.responseHeaders.forEach((value, key) =>
      headers.append(key, value),
    );

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

    const [usdaStatus, usdaBatch, upcLookup] = await Promise.all([
      measure("usda release: status()", async () => {
        await requestUsdaRelease().status();
      }),
      // An empty batch measures the Durable Object round trip alone.
      measure("usda release: lookupBatch([])", async () => {
        await requestUsdaRelease().lookupBatch([]);
      }),
      measure("upc: upstream lookup", async () => {
        if (env.UPC_UPSTREAM_DISABLED === "true")
          throw new Error("UPC upstream lookup is disabled");
        // A synthetic code probes the provider without cache writes or AI work.
        // A definitive miss is a successful round trip; transient failures are not.
        const result = await lookupUPCitemdb("000000000000", {
          fetch,
          timeoutSignal: AbortSignal.timeout,
          decideOfferComparability: async () => "unknown",
        });
        if (result.status === "error") throw result.error;
      }),
    ]);

    const results: TimingResult[] = [
      selectOne,
      countProducts,
      dbParallelResult,
      usdaStatus,
      usdaBatch,
      upcLookup,
    ];

    const totalMs = Math.round(performance.now() - overallStart);

    return Response.json({ results, totalMs }, { headers });
  },
};
