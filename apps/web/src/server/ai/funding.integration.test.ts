import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import * as databaseHelpers from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readAiBudget, setCreditBudget } from "./budget";
import { isBackgroundRun, readChatGptPlanAvailability } from "./funding";

describe("AI budget admission", () => {
  const ctx = withTestDb();
  it("reads fresh settings and filtered usage together, including an empty ledger", async () => {
    const now = new Date("2026-10-01T01:00:00.000Z");
    expect(await readAiBudget(ctx.db, now)).toMatchObject({
      credit: { limitUsd: 1.5, spentUsd: 0 },
      plan: { limitUsd: 2, spentUsd: 0 },
      paid: { limitUsd: 1, spentUsd: 0 },
    });
    await setCreditBudget(ctx.db, {
      creditLimitUsd: 3,
      openaiCreditLimitUsd: 1.5,
      planLimitUsd: 4,
      paidLimitUsd: 5,
    });
    expect(await readAiBudget(ctx.db, now)).toMatchObject({
      credit: { limitUsd: 3, spentUsd: 0 },
      plan: { limitUsd: 4, spentUsd: 0 },
      paid: { limitUsd: 5, spentUsd: 0 },
    });
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    for (const [billingReason, standardCost, chargedCost] of [
      ["subscriber_credit", 0.25, 0],
      ["plan", 0.5, 0],
      ["standard", 0.75, 0.6],
      ["cache", 9, 0],
    ] as const) {
      await getDb(ctx.db)
        .insert(aiUsage)
        .values({
          runId,
          feature: "synthetic-budget",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          createdAt: now,
          standardCost,
          chargedCost,
          costEvidence: {
            standard: { source: "estimate", pricingSource: "pi_sdk" },
            charged: { source: "estimate", pricingSource: "pi_sdk" },
            billingReason,
          },
        });
    }
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        {
          runId,
          feature: "synthetic-budget",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          standardCost: 10,
          createdAt: new Date("2026-09-30T23:59:59.999Z"),
        },
        {
          runId,
          feature: "synthetic-budget",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          standardCost: 10,
          createdAt: now,
          deletedAt: now,
        },
        {
          runId,
          feature: "synthetic-budget",
          provider: "typesafe",
          model: "typesafe/jev",
          operation: "synthetic.decision",
          durationMs: 1,
          standardCost: 10,
          createdAt: now,
        },
      ]);
    expect(await readAiBudget(ctx.db, now)).toMatchObject({
      credit: { limitUsd: 3, spentUsd: 0 },
      openaiCredit: { limitUsd: 1.5, spentUsd: 0.25 },
      plan: { limitUsd: 4, spentUsd: 0.5 },
      paid: { limitUsd: 5, spentUsd: 0.6 },
    });
  });
});

// A local budget boundary is only a re-probe time. Reporting it as OpenAI's
// reset gives false usage information; withholding a real hint loses recovery.
describe("AI funding availability", () => {
  const ctx = withTestDb();
  it.each([
    ["background", true],
    ["ai_suggest", false],
  ] as const)(
    "reads concurrent immutable origins for %s",
    async (purpose, expected) => {
      const runId = await ensureRun(ctx.db, ctx.actor, { purpose });
      expect(
        await Promise.all(
          Array.from({ length: 32 }, () => isBackgroundRun(ctx.db, runId)),
        ),
      ).toEqual(Array(32).fill(expected));
      expect(await isBackgroundRun(ctx.db, runId)).toBe(expected);
    },
  );

  it("rechecks missing origins and recovers after a failed origin read", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const unavailable = new Error("Synthetic unavailable origin database");
    const read = vi
      .spyOn(databaseHelpers, "getDb")
      .mockImplementationOnce(() => {
        throw unavailable;
      });
    try {
      await expect(isBackgroundRun(ctx.db, runId)).rejects.toBe(unavailable);
    } finally {
      read.mockRestore();
    }
    expect(await isBackgroundRun(ctx.db, runId)).toBe(true);

    const missingId = runEntityId.parse(crypto.randomUUID());
    expect(await isBackgroundRun(ctx.db, missingId)).toBe(false);
    const [template] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    const { shortcode: _shortcode, ...values } = template!;
    await insertWithShortcode(ctx.db, "run", { ...values, id: missingId });
    expect(await isBackgroundRun(ctx.db, missingId)).toBe(true);
  });

  it.each([
    ["", null],
    [',"resets_at":1790838000', "2026-10-01T07:00:00.000Z"],
    [',"resets_in_seconds":3600', "2026-10-01T02:00:00.000Z"],
  ])(
    "separates quota reset hints from the internal probe: %s",
    async (hint, until) => {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
      });
      await getDb(ctx.db)
        .insert(aiUsage)
        .values({
          runId,
          feature: "synthetic-plan",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          transport: "chatgpt",
          failure: `{"error":{"code":"subscription_sharing_usage_limit_exceeded"${hint}}}`,
          createdAt: new Date("2026-10-01T01:00:00.000Z"),
        });
      const planConnection = async () => ({
        connected: true,
        needsReauthorization: false,
      });
      expect(
        await readChatGptPlanAvailability(ctx.db, {
          planConnection,
          now: new Date("2026-10-01T01:30:00.000Z"),
        }),
      ).toMatchObject({ state: "paused", until });
      expect(
        await readChatGptPlanAvailability(ctx.db, {
          planConnection,
          now: new Date("2026-10-01T06:00:00.000Z"),
        }),
      ).toMatchObject(
        until && new Date(until) > new Date("2026-10-01T06:00:00.000Z")
          ? { state: "paused", until }
          : { state: "available", until: null },
      );
    },
  );
});
