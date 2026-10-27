import { readFileSync } from "node:fs";

import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  enqueueAiEvaluation,
  evaluationSlotKey,
} from "~/server/ai/repo/ai-evaluation-requests";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
  runStep,
} from "~/server/db/schema";
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
    const evaluation = (
      runId: typeof survivor,
      shareKey: string,
      field = "categoryId",
    ) =>
      enqueueAiEvaluation(ctx.db, {
        runId,
        executionKind: "suggestion_sweep",
        shareKey,
        feature: "field-suggestion",
        target: {
          kind: "field",
          entity: "product",
          recordId: product.entityId,
          field,
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
    const orphaned = await evaluation(
      children[1]!,
      "synthetic-orphaned",
      "brandId",
    );
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
  });
});

// Exercise the populated predecessor, including duplicate queued work and its Jobs.
describe("AI evaluation slot cutover", () => {
  const ctx = withTestDb();
  it("backfills keys, retains running evidence and cancels only older open duplicates", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const target = {
      kind: "product" as const,
      entity: "product" as const,
      recordId: crypto.randomUUID(),
      field: null,
      assessmentIds: [],
    };
    await getDb(ctx.db).execute(sql`DROP INDEX "AiEvaluation_open_slot_key"`);
    const rows = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        (["completed", "running", "queued", "retry_wait"] as const).map(
          (state, index) => ({
            runId: owner,
            feature: "product-identity",
            target,
            workKey: `synthetic-predecessor-${index}`,
            provenance: {
              dependencies: [],
              inputFingerprint: `synthetic-input-${index}`,
              optionFingerprint: "",
              model: null,
            },
            snapshot: { revision: index },
            state,
            createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
          }),
        ),
      )
      .returning();
    for (const row of rows)
      await enqueueJob(ctx.db, {
        key: `ai-evaluation:${row.id}`,
        kind: "ai.evaluation",
        input: { evaluationId: row.id },
      });
    // A member Run still waiting on the older duplicate.
    const requester = await ensureRun(ctx.db, ctx.actor, {
      purpose: "suggestion_sweep",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const older = rows.find((row) => row.state === "queued")!;
    await getDb(ctx.db)
      .insert(aiEvaluationRequest)
      .values({ runId: requester, evaluationId: older.id });
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "AiEvaluation" DROP COLUMN "slotKey"`,
    );
    const migration = readFileSync(
      new URL(
        "../../../../../drizzle/0037_derived_values.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes('"slotKey"'));
    expect(migration).toHaveLength(4);
    await withTransactionDatabase(ctx.db, async (tx) => {
      for (const statement of migration)
        await getDb(tx).execute(sql.raw(statement));
    });
    const retained = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, owner));
    const newest = rows.find((row) => row.state === "retry_wait")!;
    expect(retained).toHaveLength(4);
    expect(
      retained.every(
        (row) =>
          row.slotKey ===
          evaluationSlotKey({ feature: "product-identity", target }),
      ),
    ).toBe(true);
    expect(retained.find((row) => row.id === newest.id)?.state).toBe(
      "retry_wait",
    );
    expect(retained.find((row) => row.state === "cancelled")?.receipt).toEqual({
      supersededBy: newest.id,
    });
    expect(retained.find((row) => row.state === "running")?.snapshot).toEqual({
      revision: 1,
    });
    const jobs = await getDb(ctx.db)
      .select()
      .from(job)
      .where(
        inArray(
          job.key,
          rows.map((row) => `ai-evaluation:${row.id}`),
        ),
      );
    expect(jobs.filter((row) => row.state === "cancelled")).toHaveLength(1);
    // The requester's demand moved to the survivor instead of settling as cancelled.
    expect(
      await getDb(ctx.db)
        .select({ evaluationId: aiEvaluationRequest.evaluationId })
        .from(aiEvaluationRequest)
        .where(eq(aiEvaluationRequest.runId, requester)),
    ).toEqual([{ evaluationId: newest.id }]);
    expect(
      jobs.find((row) => row.key === `ai-evaluation:${newest.id}`)?.state,
    ).toBe("queued");
  });
});

// Owner requests must carry settled receipts through the additive page cutover.
describe("evaluation page admission cutover", () => {
  const ctx = withTestDb();
  it("backfills owner demand without cancelling settled work or replacing request receipts", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const items = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        (["queued", "completed"] as const).map((state) => ({
          runId: owner,
          feature: "product-identity",
          state,
          workKey: `synthetic-request-backfill:${state}`,
          target: {
            kind: "product" as const,
            entity: "product" as const,
            recordId: crypto.randomUUID(),
            field: null,
            assessmentIds: [],
          },
          provenance: {
            dependencies: [],
            inputFingerprint: "synthetic-request-backfill",
            optionFingerprint: "synthetic",
            model: null,
          },
          snapshot: {},
          receipt: state === "completed" ? { candidates: 7 } : null,
        })),
      )
      .returning();
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, owner));
    const migration = readFileSync(
      new URL(
        "../../../../../drizzle/0044_evaluation_page_admission.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .filter((statement) =>
        statement.includes('INSERT INTO "AiEvaluationRequest"'),
      );
    for (const statement of migration)
      await getDb(ctx.db).execute(sql.raw(statement));
    const rows = await getDb(ctx.db)
      .select()
      .from(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, owner));
    expect(
      rows.find(
        (row) =>
          row.evaluationId ===
          items.find((item) => item.state === "completed")!.id,
      ),
    ).toMatchObject({ cancelledAt: null, receipt: { candidates: 7 } });
    expect(
      rows.find(
        (row) =>
          row.evaluationId ===
          items.find((item) => item.state === "queued")!.id,
      )?.cancelledAt,
    ).toBeInstanceOf(Date);
    const completed = rows.find(
      (row) =>
        row.evaluationId ===
        items.find((item) => item.state === "completed")!.id,
    )!;
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: { reason: "Synthetic retained request receipt" } })
      .where(eq(aiEvaluationRequest.id, completed.id));
    for (const statement of migration)
      await getDb(ctx.db).execute(sql.raw(statement));
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluationRequest)
          .where(eq(aiEvaluationRequest.id, completed.id))
      )[0]?.receipt,
    ).toEqual({ reason: "Synthetic retained request receipt" });
  });
});
