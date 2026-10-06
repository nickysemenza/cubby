import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AiModelPricing } from "@cubby/shared/ai/pricing";
type ModelCost = NonNullable<AiModelPricing[keyof AiModelPricing]["cost"]>;
import { sql } from "drizzle-orm";
import { MIGRATIONS_FOLDER } from "tooling/db-migrate";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { aiUsage } from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  listAiUsageForRun,
  listRecentAiUsage,
  summarizeAiUsage,
} from "./ai-usage";
import { getDb } from "./database-helpers";

vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("models.dev")
        ? Response.json({
            openai: {
              models: {
                "gpt-6-sol": {
                  cost: { input: 2, output: 10, cache_read: 0.2 },
                },
              },
            },
          })
        : realFetch(input, init),
  );
});

function stubPricingCatalog(catalog: {
  openai: { models: Record<string, { cost: ModelCost }> };
}) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("models.dev")
        ? Response.json(catalog)
        : realFetch(input, init),
  );
}
beforeEach(() =>
  stubPricingCatalog({
    openai: {
      models: {
        "gpt-6-sol": { cost: { input: 2, output: 10, cache_read: 0.2 } },
      },
    },
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("listAiUsageForRun", () => {
  const ctx = withTestDb();

  // An AI run has no member party; the run detail page must still read its
  // usage (the import-run loader only ever served member-scoped runs).
  it("pages an AI run's calls newest first with a full-run subtotal", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const call = (minute: number, estimatedCost: number | null) => ({
      feature: "field_suggest",
      provider: "test",
      model: "test-model",
      operation: "suggest",
      runId,
      status: "succeeded" as const,
      estimatedCost,
      durationMs: 1,
      createdAt: new Date(Date.UTC(2026, 8, 20, 16, minute)),
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([call(1, 0.5), call(2, null), call(3, 0.25)]);

    const first = await listAiUsageForRun(ctx.db, runId, { limit: 2 });
    // The subtotal and unpriced count cover every call, not just the page;
    // the count also has to arrive as a runtime number, not a string.
    expect(first.pricedSubtotal).toBe(0.75);
    expect(first.unpricedCount).toBe(1);
    expect(first.records.map((row) => row.createdAt.getUTCMinutes())).toEqual([
      3, 2,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAiUsageForRun(ctx.db, runId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.records.map((row) => row.createdAt.getUTCMinutes())).toEqual([
      1,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("retains an application hit as a zero-cost usage event", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db).insert(aiUsage).values({
      feature: "field-suggestion",
      provider: "typesafe",
      model: "typesafe/jev",
      operation: "suggestFields.product.categoryId",
      runId,
      cacheStatus: "none",
      applicationCacheStatus: "hit",
      attempt: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      durationMs: 2,
    });
    const usage = await listAiUsageForRun(ctx.db, runId);
    expect(usage.pricedSubtotal).toBe(0);
    expect(usage.unpricedCount).toBe(0);
    expect(usage.records[0]).toMatchObject({
      cacheStatus: "none",
      applicationCacheStatus: "hit",
      attempt: 0,
      estimatedCost: 0,
    });
  });
});

describe("AiUsage transport", () => {
  const ctx = withTestDb();

  async function insertCalls(
    calls: (Partial<typeof aiUsage.$inferInsert> & { minute: number })[],
  ) {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        calls.map(({ minute, ...call }) => ({
          feature: "field-suggestion",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "suggestFields.product.categoryId",
          runId,
          status: "succeeded" as const,
          transport: "gateway" as const,
          durationMs: 1,
          createdAt: new Date(Date.now() - (60 - minute) * 60_000),
          ...call,
        })),
      );
    return runId;
  }

  // The usage page's filters must narrow the whole history, not the newest
  // page: three newest ChatGPT failures would otherwise hide every older
  // gateway call behind a limit of 2.
  it("filters recent calls before applying the limit", async () => {
    await insertCalls([
      { minute: 1, transport: "gateway", feature: "location-description" },
      { minute: 2, transport: "gateway", feature: "recipe-flow" },
      { minute: 3, transport: "chatgpt", status: "failed" },
      { minute: 4, transport: "chatgpt", status: "failed" },
      { minute: 5, transport: "chatgpt", status: "failed" },
    ]);

    const gateway = await listRecentAiUsage(ctx.db, {
      limit: 2,
      filters: { transport: "gateway" },
    });
    expect(gateway.map((row) => row.feature)).toEqual([
      "recipe-flow",
      "location-description",
    ]);
    expect(gateway.every((row) => row.transport === "gateway")).toBe(true);

    const failed = await listRecentAiUsage(ctx.db, {
      limit: 200,
      filters: { status: "failed", transport: "chatgpt" },
    });
    expect(failed).toHaveLength(3);
  });

  it("matches provider, model, and feature exactly and query case-insensitively", async () => {
    await insertCalls([
      {
        minute: 1,
        operation: "describeShelf",
        feature: "location-description",
      },
      { minute: 2, model: "claude-sonnet-5", provider: "anthropic" },
      { minute: 3, feature: "recipe-flow", operation: "generateRecipeFlow" },
    ]);
    const features = async (
      filters: NonNullable<Parameters<typeof listRecentAiUsage>[1]["filters"]>,
    ) =>
      (await listRecentAiUsage(ctx.db, { limit: 50, filters })).map(
        (row) => row.feature,
      );

    expect(await features({ provider: "anthropic" })).toEqual([
      "field-suggestion",
    ]);
    expect(await features({ model: "claude-sonnet-5" })).toEqual([
      "field-suggestion",
    ]);
    expect(await features({ feature: "recipe" })).toEqual([]);
    expect(await features({ feature: "recipe-flow" })).toEqual(["recipe-flow"]);
    // query spans feature, model, and operation without regard to case.
    expect(await features({ query: "DESCRIBESHELF" })).toEqual([
      "location-description",
    ]);
    expect(await features({ query: "Sonnet" })).toEqual(["field-suggestion"]);
    expect(await features({ query: "RECIPE" })).toEqual(["recipe-flow"]);
    // LIKE metacharacters in a query are literal text, not wildcards.
    expect(await features({ query: "%" })).toEqual([]);
  });

  it("keeps transports apart in the daily summary and run usage", async () => {
    const runId = await insertCalls([
      { minute: 1, transport: "gateway" },
      { minute: 2, transport: "chatgpt" },
      { minute: 3, transport: "chatgpt" },
    ]);

    const summary = await summarizeAiUsage(ctx.db, 7);
    expect(
      summary
        .map((row) => ({ transport: row.transport, count: row.count }))
        .sort((a, b) => a.transport.localeCompare(b.transport)),
    ).toEqual([
      { transport: "chatgpt", count: 2 },
      { transport: "gateway", count: 1 },
    ]);

    const run = await listAiUsageForRun(ctx.db, runId);
    expect(run.records.map((row) => row.transport)).toEqual([
      "chatgpt",
      "chatgpt",
      "gateway",
    ]);
  });

  // Rows written before the writer zeroed them carry tokens but no cost; the
  // read-time fallback must not price a replay or plan call as API spend.
  it("never prices an unpriced cache or ChatGPT row from its tokens", async () => {
    stubPricingCatalog({
      openai: {
        models: {
          "gpt-6-sol": { cost: { input: 2, output: 10, cache_read: 0.2 } },
        },
      },
    });
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const runId = await insertCalls([
      { minute: 1, transport: "cache", attempt: 1, ...tokens },
      { minute: 2, transport: "chatgpt", ...tokens },
      { minute: 3, transport: "gateway", ...tokens },
    ]);

    const recent = await listRecentAiUsage(ctx.db, { limit: 10 });
    const recentCost = Object.fromEntries(
      recent.map((row) => [row.transport, row.estimatedCost]),
    );
    expect(recentCost.cache).toBe(0);
    expect(recentCost.chatgpt).toBe(0);
    expect(recentCost.gateway).toBeGreaterThan(0);

    const summary = await summarizeAiUsage(ctx.db, 7);
    const summaryCost = Object.fromEntries(
      summary.map((row) => [row.transport, row.estimatedCost]),
    );
    expect(summaryCost).toMatchObject({ cache: 0, chatgpt: 0 });
    expect(summaryCost.gateway).toBe(recentCost.gateway);

    const run = await listAiUsageForRun(ctx.db, runId);
    expect(run.unpricedCount).toBe(1);
    expect(
      Object.fromEntries(
        run.records.map((row) => [row.transport, row.estimatedCost]),
      ),
    ).toEqual({ cache: 0, chatgpt: 0, gateway: null });
  });

  it("rejects a transport outside the shared vocabulary", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await expect(
      getDb(ctx.db).execute(
        sql`INSERT INTO "AiUsage" ("feature", "provider", "model", "operation", "runId", "durationMs", "transport") VALUES ('f', 'p', 'm', 'o', ${runId}, 1, 'api')`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "AiUsage_transport_check" },
    });
  });

  // The migration backfills only positive evidence: a gateway log id proves
  // the gateway carried the call, and an application-cache hit proves no
  // model call happened. Everything else — including zero-cost rows, which
  // might be ChatGPT plan calls or cache replays — stays unknown.
  it("backfills historical rows from positive evidence only", async () => {
    const migration = readdirSync(MIGRATIONS_FOLDER)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"))
      .find((body) =>
        /ALTER TABLE "AiUsage" ADD COLUMN "transport"/.test(body),
      );
    expect(migration).toBeDefined();
    const backfill = (migration ?? "")
      .split("--> statement-breakpoint")
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) => statement.startsWith("UPDATE"));
    expect(backfill).toHaveLength(2);

    await insertCalls([
      { minute: 1, transport: "unknown", gatewayLogId: "log-synthetic-1" },
      { minute: 2, transport: "unknown", gatewayLogId: "" },
      {
        minute: 3,
        transport: "unknown",
        applicationCacheStatus: "hit",
        attempt: 0,
        estimatedCost: 0,
      },
      { minute: 4, transport: "unknown", estimatedCost: 0 },
      { minute: 5, transport: "unknown", cacheStatus: "hit" },
      { minute: 6, transport: "unknown", status: "failed" },
    ]);
    for (const statement of backfill)
      await getDb(ctx.db).execute(sql.raw(statement));

    const rows = await getDb(ctx.db)
      .select({ createdAt: aiUsage.createdAt, transport: aiUsage.transport })
      .from(aiUsage)
      .orderBy(aiUsage.createdAt);
    expect(rows.map((row) => row.transport)).toEqual([
      "gateway",
      "unknown",
      "cache",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
});

describe("daily context tier pricing", () => {
  const ctx = withTestDb();
  it("keeps a mixed priced and tokenless group unknown", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        [0.1, null].map((estimatedCost) => ({
          runId,
          feature: "synthetic-mixed",
          operation: "price",
          provider: "openai",
          model: "gpt-6-sol",
          transport: "gateway" as const,
          durationMs: 1,
          estimatedCost,
        })),
      );
    const rows = await summarizeAiUsage(ctx.db, 7);
    expect(rows[0]?.estimatedCost).toBeNull();
  });
  it("prices each unpriced call before aggregating its day", async () => {
    stubPricingCatalog({
      openai: {
        models: {
          "gpt-6-sol": {
            cost: {
              input: 2,
              output: 10,
              tiers: [
                {
                  tier: { type: "context", size: 272000 },
                  input: 4,
                  output: 20,
                },
              ],
            },
          },
        },
      },
    });
    vi.resetModules();
    const { summarizeAiUsage: summarize } = await import("./ai-usage");
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        [0, 1].map(() => ({
          runId,
          feature: "synthetic-tier",
          operation: "price",
          provider: "openai",
          model: "gpt-6-sol",
          transport: "gateway" as const,
          inputTokens: 150_000,
          outputTokens: 0,
          durationMs: 1,
          estimatedCost: null,
        })),
      );
    const summaries = await summarize(ctx.db, 7);
    expect(summaries[0]?.estimatedCost).toBeCloseTo(0.6);
  });
});
