import type { RunId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import type { ShortcodeGeneratorPort } from "~/server/generic/shortcode/repo/shortcode-utils";

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

  it("reads a funding stop as waiting for funding and rolls up live Jobs", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review", failureCode: "execution_limit" })
      .where(eq(runTable.id, runId));
    for (let index = 0; index < 2; index++)
      await enqueueJob(ctx.db, {
        key: `synthetic.rollup.${index}`,
        kind: "synthetic.rollup",
        input: {},
        runId,
      });

    const read = await readRun(ctx.db, await codeOf(runId));

    expect(read).toMatchObject({
      displayStatus: "waiting_for_funding",
      waitingOn: "2 due",
      stalled: false,
    });
  });

  // Review finding: summaries formatted only `counts`, so a Run whose only
  // Job's executor lease lapsed read as having no live Jobs.
  it("summarizes expired leases awaiting reclaim", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const abandoned = await enqueueJob(ctx.db, {
      key: "synthetic.rollup.abandoned",
      kind: "synthetic.rollup",
      input: {},
      runId,
    });
    await updateJobs(
      ctx.db,
      { id: abandoned.id },
      {
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
        lastClaimedAt: new Date(Date.now() - 5 * 60_000),
      },
    );

    const read = await readRun(ctx.db, await codeOf(runId));

    expect(read?.waitingOn).toBe("1 expired lease awaiting reclaim");
  });
});

describe("Run attention entity view", () => {
  const ctx = withTestDb();
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
    const cancelled = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const [cancelledHistory] = await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(runTable.id, cancelled))
      .returning({ code: runTable.shortcode });
    const old = new Date(Date.now() - 60 * 60_000);
    await getDb(ctx.db)
      .update(runTable)
      .set({ startedAt: old })
      .where(eq(runTable.id, stalled));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, stopped));
    await enqueueJob(ctx.db, {
      key: "synthetic:attention-stall",
      kind: "synthetic.demand",
      runId: stalled,
      input: {},
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
    expect(await readRun(ctx.db, cancelledHistory!.code)).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
  });
});
