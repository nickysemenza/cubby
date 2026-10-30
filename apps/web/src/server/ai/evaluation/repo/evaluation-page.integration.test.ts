import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  publishAiEvaluation,
  settleAiEvaluations,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import {
  enqueueAiEvaluation,
  enqueueAiEvaluations,
} from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import { markAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import { prepareEvaluationEvidence } from "~/server/ai/evaluation/repo/evaluation-page";
import { aiEvaluationJobHandler } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import {
  aiEvaluationItem,
  drainAiEvaluations,
  withClaimedAiEvaluation,
} from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import {
  getDb,
  uuidArrayParam,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest, run } from "~/server/db/schema";
import { readAiRefreshWorkSummary } from "~/server/domains/run/repo/ai-work-state";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { runAiEvaluationExecution } from "~/server/domains/run/service/ai-evaluation-execution";
import {
  updateJobs,
  updateWorkItems,
} from "~/server/generic/jobs/jobs.fixtures";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { advanceJob } from "~/server/generic/jobs/service/jobs";

// Real pooled transactions exercise drain items, slot uniqueness and publication authority.
describe("AI evaluation drain publication", () => {
  const ctx = withTestDb();
  async function seed(
    count: number,
    feature = "product-identity",
    purpose: "ai_refresh" | "ai_suggest" = "ai_refresh",
  ) {
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-page-release",
      { enabled: true },
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger: "scheduled",
      status: "running",
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
    const inputs = Array.from({ length: count }, (_, sequence) => ({
      input: {
        runId,
        executionKind: "ai_refresh" as const,
        shareKey: null,
        feature,
        target: aiEvaluationTarget.parse({
          kind: "product",
          entity: "product",
          recordId: crypto.randomUUID(),
          field: null,
          assessmentIds: [],
        }),
        provenance: aiProvenance.parse({
          dependencies: dependencyStamps(activation.manifest, [
            "product-identity",
          ]),
          inputFingerprint: `synthetic-input-${sequence}`,
          optionFingerprint: "synthetic-options",
          model: null,
        }),
        snapshot: {},
      },
      sequence,
    }));
    const rows = await enqueueAiEvaluations(ctx.db, inputs);
    return { runId, rows, inputs };
  }

  it("keeps one owed item per evaluation across bounded evidence pages", async () => {
    const seeded = await seed(12);
    for (const row of seeded.rows)
      expect(await aiEvaluationItem(ctx.db, row.id)).toMatchObject({
        drain: "ai-evaluation:product-identity",
        attempts: 0,
      });
    // Mixed urgency and prior attempts must survive admission without reticketing.
    for (const [index, row] of seeded.rows.entries())
      await updateWorkItems(
        ctx.db,
        { refs: [row.id] },
        {
          priority: index < 4 ? 0 : 2,
          attempts: 2,
          readyAt: new Date(index * 1000),
        },
      );
    const workRows = async (ids: readonly string[]) =>
      (
        await getDb(ctx.db)
          .execute(sql`SELECT to_jsonb(w) AS value FROM "WorkItem" w
        WHERE target='ai.evaluation' AND ref=ANY(${uuidArrayParam(ids)}) ORDER BY ref`)
      ).rows;
    const original = await workRows(seeded.rows.map((row) => row.id));
    let before = original;
    const captured: string[] = [];
    const payload = "x".repeat(2 * 1024 * 1024);
    const oversized = "y".repeat(4 * 1024 * 1024);
    let overflow: string[] = [];
    const handler = aiEvaluationJobHandler({
      ...runAiEvaluationExecution(),
      async preparePage(db, targets) {
        const admission = await prepareEvaluationEvidence(db, targets, {
          async prepare(_db, wave) {
            if (!captured.length) {
              // A producer can replace an observed suffix ticket during capture.
              await markAiEvaluationWork(db, [seeded.rows.at(-1)!.id]);
              before = await workRows(seeded.rows.map((row) => row.id));
            }
            return wave.map((target) => {
              const id = target.evaluation.id;
              captured.push(id);
              return id === seeded.rows[1]!.id
                ? {
                    kind: "failed" as const,
                    target,
                    error: new Error("Synthetic preparation failure"),
                  }
                : {
                    kind: "ready" as const,
                    target,
                    evidenceDigest:
                      target.evaluation.provenance.inputFingerprint,
                    prepared: id === seeded.rows[0]!.id ? oversized : payload,
                  };
            });
          },
        });
        overflow = admission.overflow;
        return {
          ready: new Map(
            admission.ready.map(({ target }) => [
              target.evaluation.id,
              { target, weight: 1 },
            ]),
          ),
          failures: admission.failures,
          oversized: admission.oversized,
          overflow,
          publish: async (_tx, ids) =>
            ids.map((evaluationId) => ({
              evaluationId,
              state: "completed" as const,
              receipt: { synthetic: true },
            })),
        };
      },
    });
    const execution = await readJob(ctx.db, {
      key: "ai-evaluation:product-identity",
    });
    if (!execution) throw new Error("Synthetic evaluation drain missing");
    const handlers = { "ai.evaluation": handler };
    expect(await advanceJob(ctx.db, execution.id, handlers)).toBe("succeeded");
    expect(captured.length).toBeLessThan(seeded.rows.length);
    expect(captured).not.toContain(seeded.rows.at(-1)!.id);
    expect(overflow).toHaveLength(9);
    expect(before).not.toEqual(original);
    expect(await workRows(overflow)).toEqual(
      before.filter(({ value }) =>
        overflow.includes((value as { ref: string }).ref),
      ),
    );
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation)).filter(
        (row) => row.state === "failed",
      ),
    ).toHaveLength(2);
    for (
      let page = 0;
      page < seeded.rows.length && (await workRows(overflow)).length;
      page++
    )
      expect(await advanceJob(ctx.db, execution.id, handlers)).toBe(
        "succeeded",
      );
    expect(await workRows(seeded.rows.map((row) => row.id))).toEqual([]);
    const settled = await getDb(ctx.db).select().from(aiEvaluation);
    expect(settled.filter((row) => row.state === "completed")).toHaveLength(10);
    expect(settled.map((row) => row.snapshot)).toEqual(
      seeded.rows.map((row) => row.snapshot),
    );
  });

  it("settles receipt sets, preserves explicit retry receipts, and wakes each coordinator", async () => {
    const seeded = await seed(3);
    await enqueueJob(ctx.db, {
      key: `run:${seeded.runId}`,
      kind: "run.execute",
      input: {},
      availableAt: new Date(Date.now() + 60_000),
    });
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: { retryEvaluationId: crypto.randomUUID() } })
      .where(eq(aiEvaluationRequest.evaluationId, seeded.rows[0]!.id));
    await withTransactionDatabase(ctx.db, (tx) =>
      settleAiEvaluations(
        tx,
        seeded.rows.map((row) => ({
          evaluationId: row.id,
          state: "completed" as const,
          receipt: { synthetic: true },
        })),
      ),
    );
    const requests = await getDb(ctx.db).select().from(aiEvaluationRequest);
    expect(
      requests.find((entry) => entry.evaluationId === seeded.rows[0]!.id)
        ?.receipt,
    ).toHaveProperty("retryEvaluationId");
    expect(
      requests.filter(
        (entry) =>
          z.object({ synthetic: z.boolean() }).safeParse(entry.receipt).success,
      ),
    ).toHaveLength(2);
    const coordinator = await readJob(ctx.db, { key: `run:${seeded.runId}` });
    expect(coordinator!.availableAt.getTime()).toBeLessThan(Date.now() + 1000);
  });

  it("refuses publication once the drain lease is lost", async () => {
    const seeded = await seed(1);
    const id = seeded.rows[0]!.id;
    const drain = (await aiEvaluationItem(ctx.db, id))!.drain;
    const refused = await withClaimedAiEvaluation(
      ctx.db,
      id,
      async (claimed) => {
        // Another worker reclaimed the drain after this lease expired.
        await updateJobs(
          ctx.db,
          { key: drain },
          { leaseToken: sql`gen_random_uuid()` },
        );
        return publishAiEvaluation(
          ctx.db,
          id,
          claimed.attemptToken,
          async () => ({
            synthetic: true,
          }),
        ).then(
          () => null,
          (error: unknown) => error,
        );
      },
    );
    expect(refused).toBeInstanceOf(Error);
    const [row] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, id));
    expect(row?.state).toBe("queued");
    expect(await aiEvaluationItem(ctx.db, id)).toBeDefined();
  });

  it.each(["ai_refresh", "suggestion_sweep", "mail_reclassify"] as const)(
    "reuses completed input only for automatic refresh (%s)",
    async (executionKind) => {
      const seeded = await seed(1);
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ executionKind, state: "completed" })
        .where(eq(aiEvaluation.id, seeded.rows[0]!.id));
      const next = await enqueueAiEvaluation(ctx.db, {
        ...seeded.inputs[0]!.input,
        executionKind,
      });
      expect(next.id === seeded.rows[0]!.id).toBe(
        executionKind === "ai_refresh",
      );
    },
  );

  it("summarizes refresh progress", async () => {
    const seeded = await seed(4);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "completed" })
      .where(eq(aiEvaluation.id, seeded.rows[0]!.id));
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "failed", error: "Synthetic evaluation failure" })
      .where(eq(aiEvaluation.id, seeded.rows[1]!.id));
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        state: "obsolete",
        receipt: { retryEvaluationId: crypto.randomUUID() },
      })
      .where(eq(aiEvaluation.id, seeded.rows[2]!.id));
    const summary = await readAiRefreshWorkSummary(ctx.db, seeded.runId, 2);
    expect(summary.progress).toMatchObject({
      attempt: 2,
      selected: 3,
      completed: 1,
      failed: 1,
      queued: 1,
      obsolete: 0,
      errors: ["Synthetic evaluation failure"],
    });
    expect(summary.pending).toEqual([{ id: seeded.rows[3]!.id }]);
    expect(summary.failureText).toBe("Synthetic evaluation failure");
  });

  it("keeps parked evaluation work when its Run resumes before publication", async () => {
    const feature = "synthetic-resume-feature";
    const seeded = await seed(1, feature);
    const evaluation = seeded.rows[0]!;
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused", trigger: "manual" })
      .where(eq(run.id, seeded.runId));
    await updateWorkItems(
      ctx.db,
      { refs: [evaluation.id] },
      { priority: 0, readyAt: sql`now()` },
    );
    const execution = await enqueueJob(ctx.db, {
      key: `ai-evaluation:${feature}`,
      kind: "ai.evaluation",
      input: {},
    });
    const handler = aiEvaluationJobHandler(runAiEvaluationExecution());
    let resumed = false;
    const outcome = await advanceJob(ctx.db, execution.id, {
      "ai.evaluation": {
        prepare: (db, claim, context) =>
          handler.prepare(db, claim, {
            ...context,
            async fenced(work, options) {
              await withTransactionDatabase(db, async (tx) => {
                await getDb(tx)
                  .update(run)
                  .set({ status: "running" })
                  .where(eq(run.id, seeded.runId));
                await markAiEvaluationWork(tx, [evaluation.id], {
                  revive: true,
                });
              });
              resumed = true;
              return context.fenced(work, options);
            },
          }),
      },
    });
    expect(outcome).toBe("succeeded");
    expect(resumed).toBe(true);
    expect(await aiEvaluationItem(ctx.db, evaluation.id)).toBeDefined();
  });

  it("retires queued obsolete generations without inference and parks paused authority", async () => {
    const seeded = await seed(2);
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-generation-before",
      { enabled: true },
    );
    const manifest = structuredClone(activation.manifest);
    manifest["product-identity"]!.policyFingerprint += ":changed";
    await activateAiRefresh(ctx.db, "synthetic-generation-changed", {
      enabled: true,
      manifest,
    });
    await activateAiRefresh(ctx.db, "synthetic-generation-current", {
      enabled: true,
    });
    const ids = seeded.rows.map((row) => row.id);
    expect(await drainAiEvaluations(ctx.db, ids)).toEqual(["succeeded"]);
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation)).every(
        (entry) => entry.state === "obsolete",
      ),
    ).toBe(true);
    const paused = await seed(1, "synthetic-paused-feature");
    const [pausedId] = paused.rows.map((row) => row.id);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused" })
      .where(eq(run.id, paused.runId));
    expect(await drainAiEvaluations(ctx.db, [pausedId!])).toEqual([
      "succeeded",
    ]);
    // A parked item clears; launching the Run again re-marks it.
    expect(await aiEvaluationItem(ctx.db, pausedId!)).toBeUndefined();
    const [parked] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, pausedId!));
    expect(parked?.state).toBe("queued");
  });
});
