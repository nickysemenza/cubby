import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import * as databaseHelpers from "~/server/db/helpers";
import { ask } from "~/server/db/kernel-schema";
import { aiEvaluation, aiUsage, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { seedJobs, updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { readAiBudget, setAiBudget } from "./budget";
import {
  isBackgroundRun,
  readAiFundingStatus,
  readChatGptPlanAvailability,
} from "./funding";
import {
  fundingWaiters,
  readFundingWaits,
  resumeFundingPausedRuns,
} from "./funding-wait";

describe("AI budget admission", () => {
  const ctx = withTestDb();
  it("reads fresh settings and filtered usage together, including an empty ledger", async () => {
    const now = new Date("2026-10-01T01:00:00.000Z");
    expect(await readAiBudget(ctx.db, now)).toMatchObject({
      credit: { spentUsd: 0 },
      plan: { limitUsd: 2, spentUsd: 0 },
      paid: { limitUsd: 1, spentUsd: 0 },
    });
    await setAiBudget(ctx.db, { planLimitUsd: 4, paidLimitUsd: 5 });
    expect(await readAiBudget(ctx.db, now)).toMatchObject({
      credit: { spentUsd: 0 },
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
          model: "gpt-6.1-sol",
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
          model: "gpt-6.1-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          standardCost: 10,
          createdAt: new Date("2026-09-30T23:59:59.999Z"),
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
      credit: { spentUsd: 0 },
      openaiCredit: { spentUsd: 0.25 },
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
          model: "gpt-6.1-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          transport: "chatgpt",
          status: "failed",
          failure: hint
            ? `{"error":{"code":"subscription_sharing_usage_limit_exceeded"${hint}}}`
            : "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
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

  // Failure mode: after a member funds a source, evaluations parked for
  // funding keep waiting until the six-hour window ends.
  it("wakes evaluations and asks waiting for funding, and only those", async () => {
    const later = new Date(Date.now() + 60 * 60_000);
    const row = (waitCause: string) => ({
      executionKind: "ai_refresh" as const,
      feature: "field-suggestion",
      workKey: crypto.randomUUID(),
      target: {
        kind: "field" as const,
        entity: "product",
        recordId: crypto.randomUUID(),
        field: "name",
        suggestionIds: [],
      },
      provenance: {
        dependencies: [],
        inputFingerprint: "synthetic",
        optionFingerprint: "synthetic",
        model: null,
      },
      snapshot: {},
      state: "queued" as const,
      runAt: later,
      waitCause,
    });
    const [funding, provider] = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values([row("ai_funding_window"), row("provider_capacity")])
      .returning({ id: aiEvaluation.id });
    const [fundingAsk, providerAsk, unknownAsk] = await getDb(ctx.db)
      .insert(ask)
      .values(
        (
          [
            { state: "queued", waitCause: "funding" },
            { state: "queued", waitCause: "provider_capacity" },
            { state: "unknown", waitCause: "funding" },
          ] as const
        ).map((state) => ({
          inputHash: crypto.randomUUID(),
          feature: "synthetic.funding",
          producer: "model" as const,
          promptVersion: "1",
          input: {},
          availableAt: later,
          ...state,
        })),
      )
      .returning({ id: ask.id });
    // The funding page names what the wake brings back and when it retries.
    expect((await readAiFundingStatus(ctx.db)).waiting).toEqual({
      resumeAt: expect.any(String),
      runs: 0,
      work: 2,
    });
    const waiter = fundingWaiters.find(
      (entry) => entry.name === "evaluations",
    )!;
    const now = new Date();
    expect(await waiter.count(ctx.db, now)).toBe(1);
    expect(await waiter.wake(ctx.db, now, true)).toBe(1);
    expect(await waiter.count(ctx.db, now)).toBe(0);
    const read = async (id: string) =>
      (
        await getDb(ctx.db)
          .select({
            runAt: aiEvaluation.runAt,
            waitCause: aiEvaluation.waitCause,
          })
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, id))
      )[0];
    const woken = await read(funding!.id);
    expect(woken?.waitCause).toBeNull();
    expect(woken?.runAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await read(provider!.id))?.waitCause).toBe("provider_capacity");
    const asks = fundingWaiters.find((entry) => entry.name === "asks")!;
    expect(await asks.count(ctx.db, now)).toBe(1);
    expect(await asks.wake(ctx.db, now, true)).toBe(1);
    expect(await asks.count(ctx.db, now)).toBe(0);
    const storedAsks = await getDb(ctx.db).select().from(ask);
    expect(
      storedAsks.find((row) => row.id === fundingAsk!.id)?.waitCause,
    ).toBeNull();
    expect(
      storedAsks.find((row) => row.id === providerAsk!.id)?.waitCause,
    ).toBe("provider_capacity");
    expect(storedAsks.find((row) => row.id === unknownAsk!.id)?.state).toBe(
      "unknown",
    );
  });

  it("counts and releases eligible Run and Job rows in a funding wake", async () => {
    const queue = captureBackgroundQueue();
    try {
      await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic funding member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const discovery = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "running",
        input: {
          emailAuditVersion: 1,
          mailboxId: "synthetic-funding-mailbox",
          scopedQueries: [],
          executionPolicy: "import",
        },
      });
      const imported = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_import",
        trigger: "scheduled",
        status: "running",
      });
      const unrelated = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
      });
      const predecessor = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_import",
        trigger: "scheduled",
        execution: false,
      });
      await getDb(ctx.db)
        .update(run)
        .set({ predecessorRunId: predecessor })
        .where(eq(run.id, unrelated));
      const past = new Date(Date.now() - 60_000);
      for (const [id, status] of [
        [discovery, "paused_auth"],
        [imported, "needs_review"],
        [unrelated, "paused_auth"],
        [predecessor, "paused_auth"],
      ] as const)
        await getDb(ctx.db)
          .update(run)
          .set({ status, failureCode: "execution_limit", updatedAt: past })
          .where(eq(run.id, id));
      await seedJobs(ctx.db, [
        {
          key: "synthetic.funding.future",
          kind: "synthetic.funding",
          input: {},
        },
      ]);
      await updateJobs(
        ctx.db,
        { key: "synthetic.funding.future" },
        {
          availableAt: new Date(Date.now() + 60_000),
          waitReason: "provider_capacity",
        },
      );
      const now = new Date(Date.now() + 1000);
      const runs = fundingWaiters.find((entry) => entry.name === "runs")!;
      const jobs = fundingWaiters.find((entry) => entry.name === "jobs")!;
      expect(await readFundingWaits(ctx.db, now)).toEqual({ runs: 2, work: 1 });
      expect(await runs.count(ctx.db, now)).toBe(2);
      expect(await runs.wake(ctx.db, now, true)).toBe(2);
      expect(await runs.count(ctx.db, new Date(now.getTime() + 10_000))).toBe(
        0,
      );
      expect(await jobs.count(ctx.db, now)).toBe(1);
      expect(await jobs.wake(ctx.db, now, true)).toBe(1);
      expect(await jobs.count(ctx.db, now)).toBe(0);
      expect(await readFundingWaits(ctx.db, now)).toEqual({ runs: 0, work: 0 });
      const [untouched] = await getDb(ctx.db)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, unrelated));
      expect(untouched?.status).toBe("paused_auth");
      const [superseded] = await getDb(ctx.db)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, predecessor));
      expect(superseded?.status).toBe("paused_auth");
      // Re-arm the same synthetic work for the production wake journey.
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "paused_auth",
          failureCode: "execution_limit",
          progress: null,
          updatedAt: past,
        })
        .where(eq(run.id, discovery));
      await updateJobs(
        ctx.db,
        { key: "synthetic.funding.future" },
        {
          availableAt: new Date(Date.now() + 60_000),
          waitReason: "provider_capacity",
        },
      );
      expect(
        await resumeFundingPausedRuns(ctx.db, { now, anyWindow: true }),
      ).toBe(2);
    } finally {
      queue.restore();
    }
  });
});
