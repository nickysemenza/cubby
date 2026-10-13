import {
  createAiModelPricing,
  priceAiUsage,
  aiCostEvidenceSchema,
} from "@cubby/shared/ai/pricing";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";

import { createPostgresPool } from "./postgres-pool";
import { resolveTargetUrl } from "./db-migrate";

const historicalUsage = z.object({
  id: z.uuid(),
  provider: z.string(),
  model: z.string(),
  transport: z.string(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  costEvidence: aiCostEvidenceSchema,
});

/** A single captured catalog reconstructs comparisons; recorded charges never change. */
export async function reconstructHistoricalAiCosts(
  client: PoolClient,
  pricing: NonNullable<
    Awaited<ReturnType<ReturnType<typeof createAiModelPricing>["current"]>>
  >,
  apply: boolean,
) {
  const capturedAt = new Date().toISOString();
  let cursor = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let priced = 0;
  let unknown = 0;
  await client.query("BEGIN");
  try {
    // Includes deleted usage: reconstruction preserves the complete retained history.
    for (;;) {
      const result = await client.query(
        `SELECT id, provider, model, transport, "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costEvidence"
        FROM "AiUsage" WHERE id > $1 AND "costEvidence" ? 'original'
          AND "costEvidence"->'standard' = 'null'::jsonb
          AND NOT "costEvidence" ? 'reconstruction'
        ORDER BY id LIMIT 200`,
        [cursor],
      );
      const rows = z.array(historicalUsage).parse(result.rows);
      if (rows.length === 0) break;
      for (const row of rows) {
        const quote =
          row.transport === "cache"
            ? { amount: null, evidence: null }
            : priceAiUsage(pricing, row.provider, row.model, row);
        const standard =
          quote.amount === null
            ? null
            : {
                source: "reconstructed" as const,
                pricingSource: "models.dev" as const,
                ...(quote.evidence?.pricingSnapshot
                  ? {
                      pricingSnapshot: {
                        ...quote.evidence.pricingSnapshot,
                        capturedAt,
                      },
                    }
                  : {}),
              };
        scanned += 1;
        if (quote.amount === null) unknown += 1;
        else priced += 1;
        if (apply)
          await client.query(
            `UPDATE "AiUsage" SET "standardCost" = $2,
          "costEvidence" = jsonb_set(jsonb_set("costEvidence", '{standard}', $3::jsonb), '{reconstruction}', $4::jsonb)
          WHERE id = $1 AND "costEvidence"->'standard' = 'null'::jsonb
          AND NOT "costEvidence" ? 'reconstruction'`,
            [
              row.id,
              quote.amount,
              JSON.stringify(standard),
              JSON.stringify({
                capturedAt,
                outcome: quote.amount === null ? "unavailable" : "priced",
              }),
            ],
          );
      }
      cursor = rows.at(-1)!.id;
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { scanned, priced, unknown, applied: apply, capturedAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const catalog = createAiModelPricing({
    onError: (error) => {
      throw error;
    },
  });
  const pricing = await catalog.current();
  if (!pricing)
    throw new Error(
      "Historical reconstruction requires an available pricing catalog.",
    );
  const pool = createPostgresPool({
    connectionString: resolveTargetUrl(values.target),
  });
  const client = await pool.connect();
  try {
    console.log(
      JSON.stringify(
        await reconstructHistoricalAiCosts(client, pricing, values.apply),
      ),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.main) await main();
