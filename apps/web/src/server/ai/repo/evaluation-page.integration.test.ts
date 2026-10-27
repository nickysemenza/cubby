import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq, sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import {
  publishAiEvaluation,
  settleAiEvaluations,
} from "~/server/ai/repo/ai-evaluation";
import {
  enqueueAiEvaluation,
  enqueueAiEvaluations,
} from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  job,
  run,
} from "~/server/db/schema";
import { readAiRefreshWorkSummary } from "~/server/domains/run/repo/ai-work-state";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  aiEvaluationItem,
  drainAiEvaluations,
  withClaimedAiEvaluation,
} from "~/server/domains/run/service/ai-evaluation-drain.fixtures";
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

  it("marks one item per evaluation on its feature drain", async () => {
    const seeded = await seed(2);
    for (const row of seeded.rows)
      expect(await aiEvaluationItem(ctx.db, row.id)).toMatchObject({
        drain: "ai-evaluation:product-identity",
        attempts: 0,
      });
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
    const [coordinator] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, `run:${seeded.runId}`));
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
        await getDb(ctx.db).execute(
          sql`UPDATE "Job" SET "leaseToken" = gen_random_uuid() WHERE key = ${drain}`,
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
