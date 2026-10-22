import { readFileSync } from "node:fs";

import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { aiEvaluation, run, runStep } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { hasAiRefreshRunCapacity } from "./ai-refresh-admission";
import { ensureRun } from "./ensure-run";
import { ensureRunSteps } from "./run-step";

/** The cutover's data statements; the DDL before them is checked by db:check. */
const cutover = readFileSync(
  new URL("../../../../../drizzle/0008_run_model.sql", import.meta.url),
  "utf8",
)
  .split("--> statement-breakpoint")
  .filter((statement) => !/^\s*(ALTER TABLE|DROP INDEX)/.test(statement));

// Failure modes (R1, R15): an open step-ledger Run keeps a run.execute Job
// paging a cursor the new registry cannot read, its counts are lost, a
// paused Sweep child keeps holding AI refresh capacity (#2873), the cutover
// cancels an evaluation a surviving Run still requests, or a refresh pass
// keeps paging a flat cursor from before the {runId, at} shape.
describe("run model cutover", () => {
  const ctx = withTestDb();

  it("supersedes open step-ledger Runs with their counts and releases Sweep children", async () => {
    const sweep = await ensureRun(ctx.db, ctx.actor, {
      purpose: "sweep",
      trigger: "manual",
      status: "running",
    });
    await ensureRunSteps(ctx.db, sweep, [
      { key: "transfer_pair", label: "Transfer pairs" },
    ]);
    await getDb(ctx.db)
      .update(runStep)
      .set({ state: "running", found: 40, done: 12 })
      .where(eq(runStep.runId, sweep));
    const children = await Promise.all(
      ["first", "second"].map((name) =>
        ensureRun(ctx.db, ctx.actor, {
          purpose: "ai_refresh",
          trigger: "manual",
          status: "running",
          execution: false,
          parentRunId: sweep,
          clientKey: `synthetic-child-${name}`,
        }),
      ),
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused" })
      .where(inArray(run.id, children));
    const finished = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, finished));
    expect(await hasAiRefreshRunCapacity(ctx.db)).toBe(false);
    const survivor = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cutover target" }),
      ctx.actor,
    );
    const evaluation = (runId: typeof survivor, shareKey: string) =>
      enqueueAiEvaluation(ctx.db, {
        runId,
        executionKind: "suggestion_sweep",
        shareKey,
        feature: "field-suggestion",
        target: {
          kind: "field",
          entity: "product",
          recordId: product.entityId,
          field: "categoryId",
          assessmentIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint: `synthetic-${shareKey}`,
          optionFingerprint: "synthetic-options",
          model: null,
        },
        snapshot: {},
        state: "queued",
      });
    // Owned by a released child, but still requested by a live Run.
    const shared = await evaluation(children[0]!, "synthetic-shared");
    expect((await evaluation(survivor, "synthetic-shared")).id).toBe(shared.id);
    const orphaned = await evaluation(children[1]!, "synthetic-orphaned");
    const refresh = await enqueueJob(ctx.db, {
      key: "refresh:recipes",
      kind: "refresh.family",
      input: { family: "recipes" },
    });
    await getDb(ctx.db)
      .update(job)
      .set({ cursor: { after: crypto.randomUUID() } })
      .where(eq(job.id, refresh.id));

    await withTransactionDatabase(ctx.db, async (tx) => {
      for (const statement of cutover)
        await getDb(tx).execute(sql.raw(statement));
    });

    const runs = await getDb(ctx.db)
      .select({ id: run.id, status: run.status, failureCode: run.failureCode })
      .from(run);
    expect(runs.find((row) => row.id === finished)?.status).toBe("completed");
    for (const id of [sweep, ...children])
      expect(runs.find((row) => row.id === id)).toMatchObject({
        status: "failed",
        failureCode: "superseded_by_deployment",
      });
    expect(
      await getDb(ctx.db)
        .select({
          state: runStep.state,
          found: runStep.found,
          done: runStep.done,
        })
        .from(runStep)
        .where(eq(runStep.runId, sweep)),
    ).toEqual([{ state: "paused", found: 40, done: 12 }]);
    expect(
      await getDb(ctx.db)
        .select({ state: job.state })
        .from(job)
        .where(eq(job.runId, sweep)),
    ).toEqual([{ state: "cancelled" }]);
    expect(await hasAiRefreshRunCapacity(ctx.db)).toBe(true);
    const evaluations = await getDb(ctx.db)
      .select({ id: aiEvaluation.id, state: aiEvaluation.state })
      .from(aiEvaluation);
    expect(evaluations).toEqual(
      expect.arrayContaining([
        { id: shared.id, state: "queued" },
        { id: orphaned.id, state: "cancelled" },
      ]),
    );
    const jobState = async (key: string) =>
      (
        await getDb(ctx.db)
          .select({ state: job.state })
          .from(job)
          .where(eq(job.key, key))
      )[0]?.state;
    expect(await jobState(`ai-evaluation:${shared.id}`)).toBe("queued");
    expect(await jobState(`ai-evaluation:${orphaned.id}`)).toBe("cancelled");
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, refresh.id)))[0],
    ).toMatchObject({
      cursor: null,
      generation: refresh.generation + 1,
      state: "queued",
    });
  });
});
