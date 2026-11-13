import { type RunId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { kernelPass } from "~/server/db/kernel-schema";
import {
  ledgerParty,
  runControlEvent,
  run as runTable,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRunPass } from "~/server/domains/run/repo/run-execution";
import { readRecordWorkQueue } from "~/server/domains/work/service/work-queue-read";
import type { ShortcodeGeneratorPort } from "~/server/generic/shortcode/repo/shortcode-utils";
import { seedPass, readPasses } from "~/server/kernel/pass.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import { advanceRunPass } from "~/server/workflows/runs/pass.fixtures";

import { readRun, runScaffold } from "./run";

const collisionGenerator = (
  first: string,
  second: string,
): ShortcodeGeneratorPort => {
  const codes = [first, second];
  return {
    generate: (entity) => parseShortcodeFor(entity, codes.shift() ?? second),
  };
};

describe("readRun", () => {
  const ctx = withTestDb();

  // Regression: an AI run has no member party, so its party name reads null.
  // The Run output once declared that name non-null, and the Run detail page
  // failed validation for exactly the runs it was built to show.
  it("reads an AI run that has no member party", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const [row] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));

    const run = await readRun(ctx.db, row!.shortcode);

    expect(run).toMatchObject({
      purpose: "ai_suggest",
      ledgerPartyId: null,
      ledgerPartyName: null,
    });
  });
});

describe("ensureRun shortcode collisions", () => {
  const ctx = withTestDb();

  it("retries a used code for an unkeyed AI run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const next = "RUN-YYYY";
    const id = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest" },
      collisionGenerator(existing!.shortcode, next),
    );
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, id));
    expect(created?.shortcode).toBe(next);
  });

  it("retries a used code and reuses the same client-keyed run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const key = "test:shared-suggestion-run";
    const next = "RUN-ZZZZ";
    const createdId = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest", clientKey: key },
      collisionGenerator(existing!.shortcode, next),
    );
    expect(
      await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        clientKey: key,
      }),
    ).toBe(createdId);
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, createdId));
    expect(created?.shortcode).toBe(next);
  });
});

describe("listRuns", () => {
  const ctx = withTestDb();

  // Automatic usage groups stay stored but do not crowd member session lists.
  it("hides automatic AI Runs until their purpose is explicitly selected", async () => {
    await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const page = { pageIndex: 0, pageSize: 50 };

    const all = await runScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: page,
    });
    const ephemeral = await runScaffold.read(ctx.db, {
      filters: { purpose: ["ai_suggest"], trigger: ["ephemeral"] },
      sorts: [],
      pagination: page,
    });
    const manual = await runScaffold.read(ctx.db, {
      filters: { trigger: ["manual"] },
      sorts: [],
      pagination: page,
    });

    expect(all.data).toEqual([]);
    expect(all.count).toBe(0);
    expect(ephemeral.data).toHaveLength(1);
    expect(manual.data).toHaveLength(0);
  });
});

// A review stop whose open work moved to a retry kept reading "Needs
// review", and funding stops read as review or authorization.
describe("Run lineage and waiting-on reads", () => {
  const ctx = withTestDb();
  const codeOf = async (id: RunId) =>
    (
      await getDb(ctx.db)
        .select({ shortcode: runTable.shortcode })
        .from(runTable)
        .where(eq(runTable.id, id))
    )[0]!.shortcode;

  it("links a retry both ways and reads the predecessor as retried", async () => {
    const earlier = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const later = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, earlier));
    await getDb(ctx.db)
      .update(runTable)
      .set({ predecessorRunId: earlier })
      .where(eq(runTable.id, later));
    const earlierCode = await codeOf(earlier);
    const laterCode = await codeOf(later);

    const predecessor = await readRun(ctx.db, earlierCode);
    const successor = await readRun(ctx.db, laterCode);

    expect(predecessor).toMatchObject({
      status: "needs_review",
      displayStatus: "retried",
      successorRunId: laterCode,
    });
    expect(successor).toMatchObject({
      predecessorRunId: earlierCode,
      successorRunId: null,
    });
  });

  it("reads a funding stop from the Run Pass", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth", failureCode: "execution_limit" })
      .where(eq(runTable.id, runId));
    await getDb(ctx.db)
      .update(kernelPass)
      .set({ waitCause: "funding", availableAt: new Date(Date.now() + 60_000) })
      .where(eq(kernelPass.key, runId));
    expect(await readRun(ctx.db, await codeOf(runId))).toMatchObject({
      displayStatus: "waiting_for_funding",
      waitingOn: { reason: "funding", label: "Waiting for AI funding" },
      stalled: false,
    });
  });
});

describe("Run attention entity view", () => {
  const ctx = withTestDb();
  // Recovery must preserve paid answers and uncertain history while settled work leaves Needs you.
  it("projects historical recovery and refuses an unknown scope", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      execution: false,
    });
    const [history] = await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed", failureCode: "ai_work_failed" })
      .where(eq(runTable.id, runId))
      .returning();
    if (!history) throw new Error("Missing synthetic Run");
    const visible = async (wanted: boolean) => {
      const page = await runScaffold.read(ctx.db, {
        filters: { purpose: ["ai_refresh"], needsAttention: true },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      expect(page.data.some((row) => row.id === history.shortcode)).toBe(
        wanted,
      );
      const work = await readRecordWorkQueue(ctx.db, {
        id: history.shortcode,
        memberPartyId: null,
        memberOnly: false,
      });
      expect(work.items.some((row) => row.family === "account")).toBe(wanted);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(runTable)
            .where(eq(runTable.id, runId))
        )[0],
      ).toEqual(history);
    };
    await visible(true); // No durable owned roster.
    await expect(
      controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: history.shortcode, action: "retry" },
        "ai_refresh",
      ),
    ).rejects.toThrow("no current fields scope");
    await visible(true);
    expect(await readPasses(ctx.db, { runId })).toEqual([]);

    const member = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic recovery member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.shortcode, member.output.id));
    for (const action of ["run_now_paid", "resume"] as const) {
      const pausedEmptyId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_refresh",
        trigger: "scheduled",
        execution: false,
      });
      const [pausedEmpty] = await getDb(ctx.db)
        .update(runTable)
        .set({
          status: action === "run_now_paid" ? "paused_auth" : "paused",
          failureCode: action === "run_now_paid" ? "execution_limit" : null,
        })
        .where(eq(runTable.id, pausedEmptyId))
        .returning();
      if (!pausedEmpty) throw new Error("Missing synthetic paused Run");
      await seedPass(ctx.db, {
        name: "run.execute",
        key: pausedEmptyId,
        runId: pausedEmptyId,
        cancelledAt: new Date(),
      });
      const pausedPasses = await readPasses(ctx.db, { runId: pausedEmptyId });
      await expect(
        controlWorkflowRun(
          ctx.db,
          ctx.actor,
          { runPublicId: pausedEmpty.shortcode, action },
          "ai_refresh",
        ),
      ).rejects.toThrow("no current fields scope");
      expect(await readPasses(ctx.db, { runId: pausedEmptyId })).toEqual(
        pausedPasses,
      );
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(runTable)
            .where(eq(runTable.id, pausedEmptyId))
        )[0],
      ).toEqual(pausedEmpty);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runControlEvent)
          .where(eq(runControlEvent.runId, pausedEmptyId)),
      ).toEqual([]);
    }

    const emptyJobOwner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      execution: false,
    });
    await (
      await import("~/server/workflows/runs/run-pass")
    ).startRunPass(ctx.db, {
      runId: emptyJobOwner,
      purpose: "ai_refresh",
      generation: 1,
      restart: false,
    });
    await advanceRunPass(ctx.db);
    expect(await readRunPass(ctx.db, emptyJobOwner)).toMatchObject({
      state: "waiting",
      lastError: expect.stringContaining("no current fields scope"),
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(runTable)
          .where(eq(runTable.id, emptyJobOwner))
      )[0]?.status,
    ).not.toBe("completed");
  });

  it("filters and sorts stalled Runs ahead of newer stopped Runs", async () => {
    const stalled = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const stopped = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const stoppedHistories = [];
    for (const { failureCode, retiredAt } of [
      { failureCode: "user_cancelled", retiredAt: null },
      { failureCode: "dispatch_aborted", retiredAt: null },
      { failureCode: "agent_failed", retiredAt: new Date() },
    ]) {
      const cancelled = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
        execution: false,
      });
      const [history] = await getDb(ctx.db)
        .update(runTable)
        .set({ status: "failed", failureCode, retiredAt })
        .where(eq(runTable.id, cancelled))
        .returning({
          code: runTable.shortcode,
          failureCode: runTable.failureCode,
        });
      stoppedHistories.push(history!);
    }
    const old = new Date(Date.now() - 60 * 60_000);
    await getDb(ctx.db)
      .update(runTable)
      .set({ startedAt: old })
      .where(eq(runTable.id, stalled));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, stopped));
    await seedPass(ctx.db, {
      name: "run.execute",
      key: stalled,
      runId: stalled,
      availableAt: old,
    });
    const page = await runScaffold.read(ctx.db, {
      filters: { purpose: ["ai_suggest"], needsAttention: true },
      sorts: [
        { orderBy: "stalled", direction: "desc" },
        { orderBy: "startedAt", direction: "desc" },
      ],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(page.data).toHaveLength(2);
    expect(page.data.map((row) => row.stalled)).toEqual([true, false]);
    expect(page.data.map((row) => row.status)).toEqual(["running", "failed"]);
    for (const history of stoppedHistories) {
      expect(await readRun(ctx.db, history.code)).toMatchObject({
        status: "failed",
        failureCode: history.failureCode,
      });
    }
  });
});
