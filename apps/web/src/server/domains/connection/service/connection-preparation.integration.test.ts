import { and, eq } from "drizzle-orm";
import { TEST_AI_WORK_LAUNCHER } from "tooling/ai-work";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiEvaluation, assessmentState, run } from "~/server/db/schema";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { executeAiRefreshTarget } from "~/server/domains/run/service/ai-refresh";
import {
  kernelCtx,
  PRIMARY_MODEL,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import { prepareEntityConnections } from "./entity-connections";

// Failure modes: model preparation publishes before cancellation is checked;
// the field publisher escapes its caller's fenced transaction; a bespoke review
// key reopens the exact inference a member already graded Wrong inline.
describe("connection preparation and publication authority", () => {
  const ctx = withTestDb();
  async function fixture() {
    const name = "Synthetic publication fence wrench";
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    const task = await createRepoEntity(ctx, "task", {
      name,
      subjectProductId: null,
    });
    return {
      source: { entityKind: "task" as const, entityId: task.output.id },
      task,
      name,
    };
  }
  const chooseFirst: DecisionPort = async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0];
    if (!choice) throw new Error("Synthetic Product option is missing");
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.7,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? 0.7 : 0.3 / Math.max(1, keys.length - 1),
            ]),
          ),
        },
      },
    };
  };

  for (const change of ["cancel", "obsolete"] as const)
    it(`publishes no actionable Assessment when an in-flight attempt becomes ${change}`, async () => {
      const { source, task } = await fixture();
      const activation = await activateAiRefresh(
        ctx.db,
        "synthetic-connection-fence",
        { enabled: true },
      );
      const runId = await scheduleConnectionRefresh(ctx.db, source);
      if (!runId)
        throw new Error("Synthetic connection evaluation was not scheduled");
      const [evaluation] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.runId, runId));
      if (!evaluation)
        throw new Error("Synthetic connection evaluation is missing");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const execution = executeAiRefreshTarget(ctx.db, evaluation.id, {
        context: kernelCtx(ctx),
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      });
      try {
        await Promise.race([
          entered.promise,
          execution.then(() => {
            throw new Error(
              "Connection evaluation ended before external inference",
            );
          }),
        ]);
        expect(
          await getDb(ctx.db)
            .select()
            .from(assessmentState)
            .where(
              and(
                eq(assessmentState.recordId, task.entityId),
                eq(assessmentState.active, true),
                eq(assessmentState.status, "pending"),
              ),
            ),
        ).toEqual([]);
        if (change === "cancel") {
          const [owner] = await getDb(ctx.db)
            .select()
            .from(run)
            .where(eq(run.id, runId));
          if (!owner) throw new Error("Synthetic connection Run is missing");
          await controlWorkflowRun(
            ctx.db,
            ctx.actor,
            { runPublicId: owner.shortcode, action: "cancel" },
            "ai_refresh",
            TEST_AI_WORK_LAUNCHER,
          );
        } else {
          const feature = activation.manifest["entity-connections"];
          if (!feature)
            throw new Error(
              "Connection feature is absent from the active manifest",
            );
          await activateAiRefresh(ctx.db, "synthetic-obsolete-connection", {
            enabled: true,
            manifest: {
              ...activation.manifest,
              "entity-connections": {
                ...feature,
                promptVersion: "synthetic-next-connection-policy",
              },
            },
          });
        }
      } finally {
        release.resolve();
      }
      await execution;
      expect(
        await getDb(ctx.db)
          .select()
          .from(assessmentState)
          .where(
            and(
              eq(assessmentState.recordId, task.entityId),
              eq(assessmentState.active, true),
              eq(assessmentState.status, "pending"),
            ),
          ),
      ).toEqual([]);
      const [settled] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.id, evaluation.id));
      expect(settled?.state).not.toBe("completed");
    });

  it("rolls field publication back with the fenced caller transaction", async () => {
    const { source, task } = await fixture();
    const publish = await prepareEntityConnections(
      ctx.db,
      kernelCtx(ctx),
      source,
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: chooseFirst,
        },
      },
    );
    await expect(
      withTransactionDatabase(ctx.db, async (transactionDb) => {
        await publish(transactionDb);
        expect(
          await getDb(transactionDb)
            .select()
            .from(assessmentState)
            .where(
              and(
                eq(assessmentState.recordId, task.entityId),
                eq(assessmentState.field, "subjectProductId"),
                eq(assessmentState.active, true),
                eq(assessmentState.status, "pending"),
              ),
            ),
        ).toContainEqual(
          expect.objectContaining({
            field: "subjectProductId",
            status: "pending",
          }),
        );
        throw new Error("synthetic fenced rollback");
      }),
    ).rejects.toThrow("synthetic fenced rollback");
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(
          and(
            eq(assessmentState.recordId, task.entityId),
            eq(assessmentState.active, true),
            eq(assessmentState.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });

  it("withholds the same served field evidence after inline Wrong Feedback", async () => {
    const { source, task, name } = await fixture();
    const context = kernelCtx(ctx);
    const suggestPorts = {
      decisionModel: PRIMARY_MODEL,
      decisionPort: chooseFirst,
    };
    const inline = await inferFieldAssessments(
      context,
      {
        entity: "task",
        entityId: source.entityId,
        targets: ["subjectProductId"],
        basisMode: "provided",
        basis: { name, subjectProductId: null },
        decisionModel: PRIMARY_MODEL,
      },
      suggestPorts,
    );
    const id = inline.suggestions.subjectProductId?.assessmentId;
    if (!id) throw new Error("Synthetic inline field Assessment is missing");
    await reviewAssessment(ctx.db, context, {
      assessmentId: id,
      operationId: "synthetic-inline-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const publish = await prepareEntityConnections(ctx.db, context, source, {
      suggestPorts,
    });
    await publish(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(
          and(
            eq(assessmentState.recordId, task.entityId),
            eq(assessmentState.field, "subjectProductId"),
            eq(assessmentState.active, true),
            eq(assessmentState.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });
});
