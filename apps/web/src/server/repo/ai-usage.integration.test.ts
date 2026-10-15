import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import type { AiModelPricing } from "@cubby/shared/ai/pricing";
type ModelCost = NonNullable<AiModelPricing[keyof AiModelPricing]["cost"]>;
import { sql } from "drizzle-orm";
import { MIGRATIONS_FOLDER } from "tooling/db-migrate";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import {
  aiUsage,
  imageProcessingJob,
  imageProcessingAttempt,
} from "~/server/db/schema";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  listAiUsageForRun,
  listRecentAiUsage,
  summarizeAiUsage,
} from "./ai-usage";
import { getDb } from "./database-helpers";

// Integration files share a module graph; create the pricing client only
// after this file installs its catalog socket, even after another file priced.
vi.hoisted(() => {
  vi.resetModules();
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

  const imageJob = async (runId: Awaited<ReturnType<typeof ensureRun>>) => {
    const image = await createImageFixture(
      ctx.db,
      `synthetic-cost-${crypto.randomUUID()}`,
    );
    const [job] = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        shortcode: generateShortcode("imageJob"),
        imageId: parseEntityId("image", image.id),
        runId,
        kind: "describe_image",
        state: "ready",
        sourceContentHash: "a".repeat(64),
        processorRevision: 1,
      })
      .returning({ id: imageProcessingJob.id });
    if (!job) throw new Error("fixture: image job not created");
    return job;
  };

  // An AI run has no member party; the run detail page must still read its
  // usage (the import-run loader only ever served member-scoped runs).
  it("pages an AI run's calls newest first with a full-run subtotal", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const call = (minute: number, chargedCost: number | null) => ({
      feature: "field_suggest",
      provider: "test",
      model: "test-model",
      operation: "suggest",
      runId,
      status: "succeeded" as const,
      chargedCost,
      durationMs: 1,
      createdAt: new Date(Date.UTC(2026, 8, 20, 16, minute)),
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([call(1, 0.5), call(2, null), call(3, 0.25)]);

    const first = await listAiUsageForRun(ctx.db, runId, { limit: 2 });
    // The subtotal and unpriced count cover every call, not just the page;
    // the count also has to arrive as a runtime number, not a string.
    expect(first.chargedCost).toBe(0.75);
    expect(first.chargedUnpricedCount).toBe(1);
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

  // Descendant usage must contribute once to the root, including paid failures;
  // unrelated runs and pagination must not change the total.
  it("includes descendant calls exactly once in the full Run subtotal", async () => {
    const root = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      parentRunId: root,
    });
    const grandchild = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      parentRunId: child,
    });
    const unrelated = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        [root, child, grandchild, unrelated].map((runId, index) => ({
          runId,
          feature: "synthetic",
          provider: "test",
          model: "test-model",
          operation: "review",
          chargedCost: index + 1,
          standardCost: index + 2,
          status: index === 1 ? ("failed" as const) : ("succeeded" as const),
          durationMs: 1,
        })),
      );
    const result = await listAiUsageForRun(ctx.db, root, { limit: 1 });
    expect(result.chargedCost).toBe(6);
    expect(result.count).toBe(3);
    expect(result.records).toHaveLength(1);
    expect((await listAiUsageForRun(ctx.db, child)).chargedCost).toBe(5);
  });

  // Usage can carry both run attribution and attempt lineage; OR membership
  // must count that row once, and retain failed attempts alongside their retry.
  it("deduplicates linked image calls and exposes a retry with missing usage", async () => {
    const root = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      parentRunId: root,
    });
    const job = await imageJob(child);
    const unrelated = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const attempts = [crypto.randomUUID(), crypto.randomUUID()];
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values(
        attempts.map((id, index) => ({
          id,
          jobId: job.id,
          number: index + 1,
          state: index ? "ready" : "failed",
        })),
      );
    const usage = (
      attempt: number,
      chargedCost: number,
      directlyAttributed: boolean,
    ) => ({
      runId: directlyAttributed ? child : unrelated,
      jobKind: "image_processing_attempt",
      jobId: attempts[attempt - 1]!,
      attempt,
      feature: "synthetic-image",
      provider: "test",
      model: "test-model",
      operation: "describe",
      chargedCost,
      standardCost: chargedCost * 2,
      status: attempt === 1 ? ("failed" as const) : ("succeeded" as const),
      durationMs: 1,
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(usage(1, 0.2, true));
    expect(await listAiUsageForRun(ctx.db, root)).toMatchObject({
      count: 1,
      chargedCost: 0.2,
      chargedComplete: false,
      standardComplete: false,
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(usage(2, 0.3, false));
    const complete = await listAiUsageForRun(ctx.db, root, { limit: 1 });
    expect(complete).toMatchObject({
      count: 2,
      chargedCost: 0.5,
      standardCost: 1,
      chargedComplete: true,
      standardComplete: true,
    });
    expect(complete.records).toHaveLength(1);
  });

  it.each(["ready", "skipped"])(
    "records device %s image work as zero charge with an unknown standard comparison",
    async (state) => {
      const root = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
      });
      const job = await imageJob(root);
      await getDb(ctx.db)
        .insert(imageProcessingAttempt)
        .values({
          id: crypto.randomUUID(),
          jobId: job.id,
          number: 1,
          state,
          executor: {
            kind: "device",
            name: "Synthetic device",
            deviceId: crypto.randomUUID(),
            platform: "macos",
            appVersion: "1",
            osVersion: "1",
          },
        });
      expect(await listAiUsageForRun(ctx.db, root)).toMatchObject({
        count: 0,
        chargedCost: 0,
        chargedComplete: true,
        standardComplete: false,
      });
    },
  );

  it("keeps unexecuted image work and unreported external descendant costs incomplete", async () => {
    const root = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await imageJob(root);
    expect(await listAiUsageForRun(ctx.db, root)).toMatchObject({
      chargedComplete: false,
      standardComplete: false,
    });
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic cost reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const external = await ensureRun(ctx.db, ctx.actor, {
      purpose: "photo_inventory",
      trigger: "manual",
      parentRunId: root,
      input: { kind: "photo_inventory", processor: "external", batches: [] },
    });
    expect(await listAiUsageForRun(ctx.db, external)).toMatchObject({
      chargedCost: 0,
      chargedComplete: false,
      standardComplete: false,
    });
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
      chargedCost: 0,
      durationMs: 2,
    });
    const usage = await listAiUsageForRun(ctx.db, runId);
    expect(usage.chargedCost).toBe(0);
    expect(usage.chargedUnpricedCount).toBe(0);
    expect(usage.records[0]).toMatchObject({
      cacheStatus: "none",
      applicationCacheStatus: "hit",
      attempt: 0,
      chargedCost: 0,
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
      recent.map((row) => [row.transport, row.chargedCost]),
    );
    expect(recentCost.cache).toBeNull();
    expect(recentCost.chatgpt).toBeNull();
    expect(recentCost.gateway).toBeNull();

    const summary = await summarizeAiUsage(ctx.db, 7);
    const summaryCost = Object.fromEntries(
      summary.map((row) => [row.transport, row.chargedCost]),
    );
    expect(summaryCost).toMatchObject({ cache: 0, chatgpt: 0 });
    expect(summaryCost.gateway).toBe(0);

    const run = await listAiUsageForRun(ctx.db, runId);
    expect(run.chargedUnpricedCount).toBe(3);
    expect(
      Object.fromEntries(
        run.records.map((row) => [row.transport, row.chargedCost]),
      ),
    ).toEqual({ cache: null, chatgpt: null, gateway: null });
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
        chargedCost: 0,
      },
      { minute: 4, transport: "unknown", chargedCost: 0 },
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
  it("reports a mixed group known subtotal and unknown coverage", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        [0.1, null].map((chargedCost) => ({
          runId,
          feature: "synthetic-mixed",
          operation: "price",
          provider: "openai",
          model: "gpt-6-sol",
          transport: "gateway" as const,
          durationMs: 1,
          chargedCost,
        })),
      );
    const rows = await summarizeAiUsage(ctx.db, 7);
    expect(rows[0]).toMatchObject({
      chargedCost: 0.1,
      chargedUnpricedCount: 1,
      standardCost: 0,
      standardUnpricedCount: 2,
      comparedCalls: 0,
      savings: 0,
    });
  });
  it("never reprices stored token evidence when the current catalog changes", async () => {
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
          chargedCost: null,
        })),
      );
    const summaries = await summarize(ctx.db, 7);
    expect(summaries[0]).toMatchObject({
      chargedCost: 0,
      chargedUnpricedCount: 2,
      standardCost: 0,
      standardUnpricedCount: 2,
    });
  });
});

describe("independent persisted cost totals", () => {
  const ctx = withTestDb();
  it("compares only matched calls and retains independent unknown coverage", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values(
        [
          {
            standardCost: 0.4,
            chargedCost: 0,
            costEvidence: {
              standard: { source: "estimate" as const },
              charged: { source: "estimate" as const },
              billingReason: "plan" as const,
            },
          },
          {
            standardCost: null,
            chargedCost: 0.2,
            costEvidence: {
              standard: null,
              charged: { source: "provider_reported" as const },
              billingReason: "discount" as const,
            },
          },
          {
            standardCost: 0.3,
            chargedCost: null,
            costEvidence: {
              standard: { source: "estimate" as const },
              charged: null,
              billingReason: "unknown" as const,
            },
          },
        ].map((costs) => ({
          ...costs,
          runId,
          feature: "synthetic-costs",
          operation: "compare",
          provider: "synthetic",
          model: "synthetic",
          transport: "gateway" as const,
          durationMs: 1,
        })),
      );
    const expected = {
      standardCost: 0.7,
      chargedCost: 0.2,
      standardUnpricedCount: 1,
      chargedUnpricedCount: 1,
      savings: 0.4,
      comparedCalls: 1,
      count: 3,
    };
    const run = await listAiUsageForRun(ctx.db, runId);
    expect(run).toMatchObject(expected);
    expect(run.billingReasons?.sort()).toEqual(["discount", "plan", "unknown"]);
    expect((await summarizeAiUsage(ctx.db, 7))[0]).toMatchObject(expected);
  });
});
