import { MEMBER_CANCELLED_AI_WORK } from "@cubby/schemas/ai-evaluation";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueAiEvaluation } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import {
  aiEvaluationItem,
  owedAiEvaluations,
} from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
  runStep,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { ensureRunSteps } from "~/server/domains/run/repo/run-step";
import { retryRunStep } from "~/server/domains/run/service/step-run";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  cancelRunAiWork,
  controlWorkflowRun,
  readmitFailedAiWork,
} from "./control";

// Production finding: Run cancel called cancelJob once per evaluation inside
// one transaction under the global AI admission lock and timed out for large
// Runs. Cancel is set-based.
describe("Run AI work cancel", () => {
  const ctx = withTestDb();

  it("drops every owned evaluation's item in one pass", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cancel target" }),
      ctx.actor,
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "sweep",
      trigger: "manual",
      input: { kind: "sweep", families: [{ family: "field", scope: {} }] },
      execution: false,
    });
    for (let index = 0; index < 120; index++)
      await enqueueAiEvaluation(ctx.db, {
        runId,
        executionKind: "suggestion_sweep",
        shareKey: null,
        workKey: `synthetic-cancel:${index}`,
        feature: "field-suggestion",
        target: {
          kind: "field",
          entity: "product",
          // One open evaluation per target slot: each is its own target.
          recordId: index === 0 ? product.entityId : crypto.randomUUID(),
          field: "categoryId",
          suggestionIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint: `synthetic-input-${index}`,
          optionFingerprint: "synthetic-options",
          model: null,
        },
        snapshot: {},
        state: "queued",
        result: null,
      });
    const [superseded] = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId))
      .limit(1);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        state: "cancelled",
        runAt: null,
        error: "Superseded by synthetic evidence",
      })
      .where(eq(aiEvaluation.id, superseded!.id));
    await cancelRunAiWork(ctx.db, runId, MEMBER_CANCELLED_AI_WORK);
    // Retrying failures must not re-admit the work the member stopped.
    await readmitFailedAiWork(ctx.db, runId, {
      owned: true,
      requested: true,
      attempt: 1,
    });
    const evaluations = await getDb(ctx.db)
      .select({ state: aiEvaluation.state })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId));
    expect(evaluations).toHaveLength(120);
    expect(evaluations.every((row) => row.state === "cancelled")).toBe(true);
    expect(await owedAiEvaluations(ctx.db)).toBe(0);
    const [cancelled] = await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, runId))
      .returning({ code: run.shortcode });
    await ensureRunSteps(ctx.db, runId, [
      { key: "field_evaluate", label: "Fields: evaluate" },
    ]);
    await getDb(ctx.db)
      .update(runStep)
      .set({ state: "failed", pausedReason: MEMBER_CANCELLED_AI_WORK })
      .where(eq(runStep.runId, runId));
    await expect(retryRunStep(ctx.db, runId, "field_evaluate")).rejects.toThrow(
      "Cancelled AI work stays stopped",
    );
    expect(
      (
        await getDb(ctx.db)
          .select({ status: run.status, failureCode: run.failureCode })
          .from(run)
          .where(eq(run.id, runId))
      )[0],
    ).toEqual({ status: "failed", failureCode: "user_cancelled" });
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: cancelled!.code, action: "retry" },
      "sweep",
    );
    const restarted = await getDb(ctx.db)
      .select({
        id: aiEvaluation.id,
        state: aiEvaluation.state,
        receipt: aiEvaluation.receipt,
      })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId));
    expect(restarted.filter((item) => item.state === "cancelled")).toHaveLength(
      120,
    );
    expect(restarted.filter((item) => item.state === "queued")).toHaveLength(
      119,
    );
    expect(restarted.find((item) => item.id === superseded!.id)).toMatchObject({
      state: "cancelled",
      receipt: null,
    });
    expect(
      (
        await getDb(ctx.db)
          .select({ status: run.status })
          .from(run)
          .where(eq(run.id, runId))
      )[0]?.status,
    ).toBe("running");
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(runStep)
          .where(eq(runStep.runId, runId))
      )[0]?.state,
    ).toBe("queued");
  });

  it("keeps work another live requester still wants", async () => {
    const shared = {
      executionKind: "mail_reclassify" as const,
      shareKey: "synthetic-shared-reclassify",
      feature: "mailbox-relevance",
      target: {
        kind: "email" as const,
        entity: "email" as const,
        recordId: parseEntityId("email", crypto.randomUUID()),
        field: null,
        suggestionIds: [],
      },
      provenance: {
        dependencies: [],
        inputFingerprint: "synthetic-shared-input",
        optionFingerprint: "",
        model: null,
      },
      snapshot: {},
      state: "queued" as const,
      result: null,
    };
    const [first, second] = await Promise.all(
      ["first", "second"].map(() =>
        ensureRun(ctx.db, ctx.actor, {
          purpose: "mail_reclassify",
          trigger: "manual",
          execution: false,
        }),
      ),
    );
    const evaluation = await enqueueAiEvaluation(ctx.db, {
      ...shared,
      runId: first!,
    });
    expect(
      (await enqueueAiEvaluation(ctx.db, { ...shared, runId: second! })).id,
    ).toBe(evaluation.id);
    // Reclassification requests shared work; it owns none.
    expect(
      await cancelRunAiWork(ctx.db, first!, MEMBER_CANCELLED_AI_WORK, {
        owned: false,
        requested: true,
      }),
    ).toBe(true);
    const stoppedRequests = await getDb(ctx.db)
      .select()
      .from(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, first!));
    await readmitFailedAiWork(ctx.db, first!, {
      owned: false,
      requested: true,
      attempt: 1,
    });
    expect(
      await getDb(ctx.db).select({ id: aiEvaluation.id }).from(aiEvaluation),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluationRequest)
        .where(eq(aiEvaluationRequest.runId, first!)),
    ).toEqual(stoppedRequests);
    const [row] = await getDb(ctx.db)
      .select({ state: aiEvaluation.state })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, evaluation.id));
    expect(row?.state).toBe("queued");
    expect(await aiEvaluationItem(ctx.db, evaluation.id)).toMatchObject({
      feature: "mailbox-relevance",
    });
    expect(
      await readmitFailedAiWork(ctx.db, first!, {
        owned: false,
        requested: true,
        attempt: 1,
        reviveCancelled: true,
      }),
    ).toBe(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluationRequest)
          .where(
            and(
              eq(aiEvaluationRequest.runId, first!),
              eq(aiEvaluationRequest.evaluationId, evaluation.id),
            ),
          )
      )[0],
    ).toMatchObject({ cancelledAt: null, receipt: null });
    await cancelRunAiWork(ctx.db, first!, MEMBER_CANCELLED_AI_WORK, {
      owned: false,
      requested: true,
    });
    const withdrawnAgain = await getDb(ctx.db)
      .select()
      .from(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, first!));
    const paidResult = { decision: "synthetic-retained-result" };
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "failed", runAt: null, result: paidResult })
      .where(eq(aiEvaluation.id, evaluation.id));
    expect(
      await readmitFailedAiWork(ctx.db, second!, {
        owned: false,
        requested: true,
        attempt: 1,
      }),
    ).toBe(1);
    const retried = await getDb(ctx.db)
      .select({
        id: aiEvaluation.id,
        state: aiEvaluation.state,
        result: aiEvaluation.result,
      })
      .from(aiEvaluation);
    expect(retried).toHaveLength(2);
    expect(retried.find((item) => item.id !== evaluation.id)).toMatchObject({
      state: "result_ready",
      result: paidResult,
    });
    expect(retried.find((item) => item.id === evaluation.id)).toMatchObject({
      state: "failed",
      result: paidResult,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluationRequest)
        .where(eq(aiEvaluationRequest.runId, first!)),
    ).toEqual(withdrawnAgain);
  });
});
