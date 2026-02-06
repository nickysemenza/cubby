import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { env } from "~/env";
import { db } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

type TimingResult = {
  label: string;
  durationMs: number;
  error?: string;
};

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
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const Route = createFileRoute("/api/debug/timing")({
  server: {
    handlers: {
      GET: async () => {
        const overallStart = performance.now();
        const drizzle = getDb(db);

        const results: TimingResult[] = await Promise.all([
          // 1. DB: simple query
          measure("db: SELECT 1", () =>
            drizzle.execute(sql`SELECT 1`).then(() => {}),
          ),

          // 2. DB: count query (tests actual table scan)
          measure("db: count products", () =>
            drizzle.execute(sql`SELECT count(*) FROM product`).then(() => {}),
          ),

          // 3. USDA API: health/counts endpoint
          measure(`usda: GET ${env.USDA_API_URL}counts`, async () => {
            const res = await fetch(`${env.USDA_API_URL}counts`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.text();
          }),

          // 4. USDA API: single food lookup (batch of 0 — tests connection overhead)
          measure(
            `usda: POST ${env.USDA_API_URL}api/foods/search/batch (empty)`,
            async () => {
              const res = await fetch(
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
          measure(`upc-lookup: GET ${env.UPC_LOOKUP_API_URL}`, async () => {
            const res = await fetch(env.UPC_LOOKUP_API_URL);
            // Don't check status — just measuring reachability
            await res.text();
          }),
        ]);

        const totalMs = Math.round(performance.now() - overallStart);

        return new Response(JSON.stringify({ results, totalMs }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
