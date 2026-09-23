import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { aiUsage } from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import { listAiUsageForRun } from "./ai-usage";
import { getDb } from "./database-helpers";

describe("listAiUsageForRun", () => {
  const ctx = withTestDb();

  // An AI run has no member party; the run detail page must still read its
  // usage (the import-run loader only ever served member-scoped runs).
  it("pages an AI run's calls newest first with a full-run subtotal", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });
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
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });
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
