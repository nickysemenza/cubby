import { withMigrationDatabase } from "./test-database-lease";
import { projectAiModelPricing } from "@cubby/shared/ai/pricing";
import { reconstructHistoricalAiCosts } from "./ai-cost-backfill";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";

it("preserves legacy charges and late writers across the AI cost expand/contract migration", async () => {
  return withMigrationDatabase(async (client, databaseUrl) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_ai_cost_accounting_expand"),
    );
    if (index < 1) throw new Error("AI cost expansion has no predecessor");
    await migrateDatabase(drizzle(client), {
      through: tags[index - 1]!,
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-cost-member', 'Synthetic member', 'cost@example.invalid')`,
    );
    const owner = await client.query<{ id: string }>(
      `INSERT INTO "Run" (shortcode, "actorName", "actorUserId", "actorEmail", purpose, trigger, status) VALUES ('RUN-4K7M', 'Synthetic member', 'synthetic-cost-member', 'cost@example.invalid', 'ai_suggest', 'manual', 'completed') RETURNING id`,
    );
    const runId = owner.rows[0]!.id;
    const writeLegacy = (
      transport: string,
      amount: number | null,
      inputTokens = 100,
      cacheStatus = "none",
    ) =>
      client.query(
        `INSERT INTO "AiUsage" ("runId", provider, model, feature, operation, transport, "estimatedCost", "inputTokens", "cacheStatus", "durationMs") VALUES ($1, 'openai', 'gpt-6-luna', 'synthetic', 'synthetic', $2, $3, $4, $5, 1)`,
        [runId, transport, amount, inputTokens, cacheStatus],
      );
    await writeLegacy("gateway", 0.025);
    await writeLegacy("chatgpt", 0);
    await writeLegacy("direct", null);
    await writeLegacy("cache", 0.01);
    await writeLegacy("cache", 0, 0);
    await writeLegacy("chatgpt", 0.02);
    await writeLegacy("gateway", 0, 0, "hit");
    const before = (
      await client.query(
        `SELECT id, "estimatedCost", "inputTokens" FROM "AiUsage" ORDER BY id`,
      )
    ).rows;
    await migrateDatabase(drizzle(client), {
      through: tags[index]!,
    });
    const expanded = (
      await client.query(
        `SELECT "standardCost", "chargedCost", "costEvidence", transport FROM "AiUsage" ORDER BY id`,
      )
    ).rows;
    expect(expanded.every((row) => row.standardCost === null)).toBe(true);
    expect(
      expanded.find(
        (row) => row.transport === "chatgpt" && row.chargedCost === 0,
      ),
    ).toMatchObject({
      chargedCost: 0,
      costEvidence: { billingReason: "plan" },
    });
    await writeLegacy("gateway", 0.005);
    await migrateDatabase(drizzle(client));
    const after = (
      await client.query(
        `SELECT id, "chargedCost", "inputTokens", "costEvidence" FROM "AiUsage" ORDER BY id`,
      )
    ).rows;
    expect(after).toHaveLength(8);
    for (const original of before) {
      expect(after.find((row) => row.id === original.id)).toMatchObject({
        chargedCost: original.estimatedCost,
        inputTokens: original.inputTokens,
        costEvidence: { original: { estimatedCost: original.estimatedCost } },
      });
    }
    expect(
      after.some(
        (row) =>
          row.costEvidence.original.estimatedCost > 0.004 &&
          row.costEvidence.original.estimatedCost < 0.006 &&
          row.chargedCost !== null,
      ),
    ).toBe(true);
    expect(
      (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'AiUsage' AND column_name = 'estimatedCost'`,
        )
      ).rows,
    ).toHaveLength(0);
    const pricing = projectAiModelPricing({
      openai: {
        id: "openai",
        name: "Synthetic provider",
        env: [],
        npm: "",
        doc: "",
        models: {
          "gpt-6-luna": {
            id: "gpt-6-luna",
            name: "Synthetic model",
            description: "",
            attachment: false,
            reasoning: false,
            tool_call: false,
            release_date: "2026-01",
            last_updated: "2026-01",
            modalities: { input: ["text"], output: ["text"] },
            open_weights: false,
            limit: { context: 100000, output: 10000 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    });
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    try {
      expect(
        await reconstructHistoricalAiCosts(connection, pricing, false),
      ).toMatchObject({ scanned: 8, priced: 5, unknown: 3, applied: false });
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM "AiUsage" WHERE "standardCost" IS NOT NULL`,
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        await reconstructHistoricalAiCosts(connection, pricing, true),
      ).toMatchObject({ scanned: 8, priced: 5, unknown: 3, applied: true });
      expect(
        await reconstructHistoricalAiCosts(
          connection,
          projectAiModelPricing({}),
          true,
        ),
      ).toMatchObject({ scanned: 0 });
      const reconstructed = (
        await client.query(
          `SELECT id, "chargedCost", "standardCost", "costEvidence" FROM "AiUsage" ORDER BY id`,
        )
      ).rows;
      expect(reconstructed.map((row) => [row.id, row.chargedCost])).toEqual(
        after.map((row) => [row.id, row.chargedCost]),
      );
      expect(
        reconstructed.every(
          (row) =>
            row.costEvidence.reconstruction.outcome ===
            (row.standardCost === null ? "unavailable" : "priced"),
        ),
      ).toBe(true);
      expect(
        reconstructed
          .filter((row) => row.standardCost !== null)
          .every((row) => row.costEvidence.standard.source === "reconstructed"),
      ).toBe(true);
      expect(
        reconstructed
          .filter((row) => row.standardCost === null)
          .every((row) => row.costEvidence.standard === null),
      ).toBe(true);
      expect(
        reconstructed.filter((row) => row.standardCost === null),
      ).toHaveLength(3);
      expect(
        reconstructed.filter((row) => row.standardCost === 0.0001),
      ).toHaveLength(5);
      // Production histories cannot afford a network round trip for each row.
      await client.query(
        `INSERT INTO "AiUsage" ("runId", provider, model, feature, operation, transport, "inputTokens", "durationMs", "chargedCost", "costEvidence")
        SELECT $1, 'openai', 'gpt-6-luna', 'synthetic', 'synthetic', 'gateway', 100, 1, 0.001,
        '{"standard":null,"charged":{"source":"historical_recorded"},"billingReason":"unknown","original":{"estimatedCost":0.001}}'::jsonb
        FROM generate_series(1, 401)`,
        [runId],
      );
      const queries = vi.spyOn(connection, "query");
      expect(
        await reconstructHistoricalAiCosts(connection, pricing, true),
      ).toMatchObject({ scanned: 401, priced: 401, applied: true });
      const writes = queries.mock.calls.filter(
        ([query]) =>
          typeof query === "string" && query.trimStart().startsWith("UPDATE"),
      );
      expect(writes.length).toBeLessThanOrEqual(4);
      queries.mockRestore();
      expect(
        await reconstructHistoricalAiCosts(connection, pricing, true),
      ).toMatchObject({ scanned: 0 });
    } finally {
      connection.release();
      await pool.end();
    }
  });
}, 60_000);
