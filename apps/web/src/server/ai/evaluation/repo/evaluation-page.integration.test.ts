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
  completeAiEvaluation,
  publishAiEvaluation,
  settleAiEvaluations,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import {
  enqueueAiEvaluation,
  enqueueAiEvaluations,
} from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import { markAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import { prepareEvaluationEvidence } from "~/server/ai/evaluation/repo/evaluation-page";
import {
  runAiEvaluationPage,
  type AiEvaluationExecution,
} from "~/server/ai/evaluation/service/ai-evaluation-drain";
import {
  aiEvaluationItem,
  drainAiEvaluations,
  updateAiEvaluationWork,
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
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

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
        feature: "product-identity",
        attempts: 0,
      });
    // Mixed urgency and prior attempts must survive admission without reticketing.
    for (const [index, row] of seeded.rows.entries())
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({
          priority: index < 4 ? 0 : 2,
          attempts: 2,
          runAt: new Date(index * 1000),
        })
        .where(eq(aiEvaluation.id, row.id));
    const workRows = async (ids: readonly string[]) =>
      (
        await getDb(ctx.db)
          .execute(sql`SELECT jsonb_build_object('ref', w.id, 'priority', w.priority, 'attempts', w.attempts, 'runAt', w."runAt") AS value FROM "AiEvaluation" w
        WHERE w."runAt" IS NOT NULL AND w.id=ANY(${uuidArrayParam(ids)}) ORDER BY w.id`)
      ).rows;
    const original = await workRows(seeded.rows.map((row) => row.id));
    let before = original;
    const captured: string[] = [];
    const payload = "x".repeat(2 * 1024 * 1024);
    const oversized = "y".repeat(4 * 1024 * 1024);
    let overflow: string[] = [];
    const execution: AiEvaluationExecution = {
      ...runAiEvaluationExecution(),
      async preparePage(db, targets) {
        const admission = await prepareEvaluationEvidence(db, targets, {
          async prepare(_db, wave) {
            if (!captured.length) {
              // A producer can replace an observed suffix ticket during capture.
              await markAiEvaluationWork(db, [wave.at(-1)!.evaluation.id]);
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
    };
    const advance = async () =>
      (await runAiEvaluationPage(ctx.db, execution, "product-identity"))
        .outcome;
    expect(await advance()).toBe("succeeded");
    expect(captured.length).toBeLessThan(seeded.rows.length);
    expect(captured).not.toContain(seeded.rows.at(-1)!.id);
    // Unadmitted and unobserved items alike keep their tickets and attempts.
    const owed = seeded.rows.slice(3).map((row) => row.id);
    expect(overflow).toContain(owed[0]);
    expect(before).not.toEqual(original);
    expect(await workRows(owed)).toEqual(
      before.filter(({ value }) =>
        owed.includes((value as { ref: string }).ref),
      ),
    );
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation)).filter(
        (row) => row.state === "failed",
      ),
    ).toHaveLength(2);
    for (
      let page = 0;
      page < seeded.rows.length && (await workRows(owed)).length;
      page++
    )
      expect(await advance()).toBe("succeeded");
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

  it("refuses publication once the page's lease is lost", async () => {
    const seeded = await seed(1);
    const id = seeded.rows[0]!.id;
    const refused = await withClaimedAiEvaluation(
      ctx.db,
      id,
      async (claimed) => {
        // Another worker reclaimed the row after this lease expired.
        await getDb(ctx.db)
          .update(aiEvaluation)
          .set({ leaseToken: crypto.randomUUID() })
          .where(eq(aiEvaluation.id, id));
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

  // A page may hold a provider call for minutes, and a mark can arrive at any moment.
  describe.each([
    {
      name: "new input",
      revive: false,
      calls: 2,
      priority: 1,
    },
    {
      name: "more urgent demand for the same input",
      revive: true,
      calls: 1,
      priority: 2,
    },
  ])(
    "a mark for $name during a paid attempt",
    ({ revive, calls, priority }) => {
      it("lets no sibling page pay, and settles the latest intent", async () => {
        const feature = "synthetic-overlap-feature";
        const { rows } = await seed(1, feature);
        const id = rows[0]!.id;
        await updateAiEvaluationWork(ctx.db, [id], {
          priority,
          runAt: new Date(0),
        });
        const paid: string[] = [];
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = () => {};
        const inFlight = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const execution: AiEvaluationExecution = {
          ...runAiEvaluationExecution(),
          async execute(db, claimed) {
            paid.push(claimed.attemptToken);
            entered();
            await released;
            await withTransactionDatabase(db, (tx) =>
              completeAiEvaluation(tx, claimed.id, claimed.attemptToken, {
                synthetic: true,
              }),
            );
          },
        };
        const first = runAiEvaluationPage(ctx.db, execution, feature);
        await inFlight;

        await markAiEvaluationWork(ctx.db, [id], { revive });
        await runAiEvaluationPage(ctx.db, execution, feature);
        expect(paid).toHaveLength(1);

        release();
        await first;
        await runAiEvaluationPage(ctx.db, execution, feature);
        expect(paid).toHaveLength(calls);
        expect(await aiEvaluationItem(ctx.db, id)).toBeUndefined();
        const [settled] = await getDb(ctx.db)
          .select({ state: aiEvaluation.state, lease: aiEvaluation.leaseToken })
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, id));
        expect(settled).toEqual({ state: "completed", lease: null });
      });
    },
  );

  it("keeps parked evaluation work when its Run resumes before publication", async () => {
    const feature = "synthetic-resume-feature";
    const seeded = await seed(1, feature);
    const evaluation = seeded.rows[0]!;
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused", trigger: "manual" })
      .where(eq(run.id, seeded.runId));
    await updateAiEvaluationWork(ctx.db, [evaluation.id], {
      priority: 0,
      runAt: new Date(0),
    });
    let resumed = false;
    const { outcome } = await runAiEvaluationPage(
      ctx.db,
      runAiEvaluationExecution(),
      feature,
      (context) => ({
        ...context,
        async fenced(work, options) {
          await withTransactionDatabase(ctx.db, async (tx) => {
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
    );
    expect(outcome).not.toBe("failed");
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
