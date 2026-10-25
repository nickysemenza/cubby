import type { RunId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job, run as runTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import type { ShortcodeGeneratorPort } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readRunCatalogActivity } from "./catalog-activity";
import { getRunByShortcode, listRuns } from "./run";

const collisionGenerator = (
  first: string,
  second: string,
): ShortcodeGeneratorPort => {
  const codes = [first, second];
  return {
    generate: (entity) => parseShortcodeFor(entity, codes.shift() ?? second),
  };
};

describe("getRunByShortcode", () => {
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

    const run = await getRunByShortcode(ctx.db, row!.shortcode);

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

  // Regression: the list once hid ephemeral runs unless a special flag was
  // set, so every decision pass and AI action was missing from `/runs`.
  it("lists ephemeral AI runs unfiltered and by trigger", async () => {
    await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const page = { pageIndex: 0, pageSize: 50 };

    const all = await listRuns(ctx.db, {}, [], page);
    const ephemeral = await listRuns(
      ctx.db,
      { trigger: ["ephemeral"] },
      [],
      page,
    );
    const manual = await listRuns(ctx.db, { trigger: ["manual"] }, [], page);

    expect(all.data).toEqual([
      expect.objectContaining({ purpose: "ai_suggest", trigger: "ephemeral" }),
    ]);
    expect(ephemeral.data).toHaveLength(1);
    expect(manual.data).toHaveLength(0);
  });
});

describe("Run catalog activity", () => {
  const ctx = withTestDb();

  it("separates latest starts from latest completions and excludes deleted runs", async () => {
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const later = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const running = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const deleted = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    for (const [id, startedAt, endedAt] of [
      [first, "2025-01-01T00:00:00Z", "2025-01-04T00:00:00Z"],
      [later, "2025-01-02T00:00:00Z", "2025-01-03T00:00:00Z"],
      [running, "2025-01-05T00:00:00Z", null],
      [deleted, "2025-01-06T00:00:00Z", "2025-01-07T00:00:00Z"],
    ] as const) {
      await getDb(ctx.db)
        .update(runTable)
        .set({
          startedAt: new Date(startedAt),
          endedAt: endedAt ? new Date(endedAt) : null,
        })
        .where(eq(runTable.id, id));
    }
    await getDb(ctx.db)
      .update(runTable)
      .set({ deletedAt: new Date("2025-01-08T00:00:00Z") })
      .where(eq(runTable.id, deleted));
    const activity = await readRunCatalogActivity(ctx.db);
    expect(
      activity.latest.find((row) => row.purpose === "ai_suggest"),
    ).toMatchObject({
      status: "running",
      startedAt: "2025-01-05T00:00:00.000Z",
    });
    expect(
      activity.completed.find((row) => row.purpose === "ai_suggest"),
    ).toMatchObject({
      startedAt: "2025-01-01T00:00:00.000Z",
      endedAt: "2025-01-04T00:00:00.000Z",
    });
    expect(
      activity.latest.find((row) => row.purpose === "background"),
    ).toMatchObject({ status: "completed" });
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

    const predecessor = await getRunByShortcode(ctx.db, earlierCode);
    const successor = await getRunByShortcode(ctx.db, laterCode);

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

    const read = await getRunByShortcode(ctx.db, await codeOf(runId));

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
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
        lastClaimedAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(job.id, abandoned.id));

    const read = await getRunByShortcode(ctx.db, await codeOf(runId));

    expect(read?.waitingOn).toBe("1 expired lease awaiting reclaim");
  });
});
