import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { env } from "~/env";
import { getErrorMessage } from "~/lib/error-utils";
import { getBindingFetcher } from "~/server/cf-env";
import { db } from "~/server/db";
import {
  countProducts as countProductsRepo,
  pingDb,
} from "~/server/repo/debug";

export const timingResultSchema = z.object({
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

        // Service binding fetch in prod, global fetch (public URL) in dev
        const usdaFetch = getBindingFetcher("USDA_API");
        const upcFetch = getBindingFetcher("UPC_LOOKUP");
        const usdaVia = usdaFetch ? "binding" : "url";
        const upcVia = upcFetch ? "binding" : "url";

        const [usdaCounts, usdaBatch, upcPing] = await Promise.all([
          // 3. USDA API: health/counts endpoint
          measure(
            `usda (${usdaVia}): GET ${env.USDA_API_URL}counts`,
            async () => {
              const res = await (usdaFetch ?? fetch)(
                `${env.USDA_API_URL}counts`,
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              await res.text();
            },
          ),

          // 4. USDA API: single food lookup (batch of 0 — tests connection overhead)
          measure(
            `usda (${usdaVia}): POST ${env.USDA_API_URL}api/foods/search/batch (empty)`,
            async () => {
              const res = await (usdaFetch ?? fetch)(
                `${env.USDA_API_URL}api/foods/search/batch`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ lookups: [] }),
                },
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              await res.text();
            },
          ),

          // 5. UPC lookup worker ping
          measure(
            `upc-lookup (${upcVia}): GET ${env.UPC_LOOKUP_API_URL}`,
            async () => {
              const res = await (upcFetch ?? fetch)(env.UPC_LOOKUP_API_URL);
              // Don't check status — just measuring reachability
              await res.text();
            },
          ),
        ]);

        const results: TimingResult[] = [
          selectOne,
          countProducts,
          dbParallelResult,
          usdaCounts,
          usdaBatch,
          upcPing,
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
