import { projectAiModelPricing } from "@cubby/shared/ai/pricing";
import { reconstructHistoricalAiCosts } from "./ai-cost-backfill";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { z } from "zod";

import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

it("preserves legacy charges and late writers across the AI cost expand/contract migration", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_ai_cost_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.href });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await client.connect();
    const journal = z
      .object({ entries: z.array(z.object({ tag: z.string() })) })
      .parse(
        JSON.parse(
          readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
        ),
      );
    const index = journal.entries.findIndex((entry) =>
      entry.tag.endsWith("_ai_cost_accounting_expand"),
    );
    if (index < 1) throw new Error("AI cost expansion has no predecessor");
    await migrateDatabase(drizzle(client), {
      through: journal.entries[index - 1]!.tag,
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
      through: journal.entries[index]!.tag,
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
    const pool = new Pool({ connectionString: url.href });
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
    } finally {
      connection.release();
      await pool.end();
    }
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 60_000);
