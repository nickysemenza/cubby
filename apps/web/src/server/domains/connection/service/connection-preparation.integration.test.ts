import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { and, eq } from "drizzle-orm";
import { TEST_AI_WORK_LAUNCHER } from "tooling/ai-work";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  assessmentState,
  run,
  user,
  expense,
  searchDocument,
  product,
} from "~/server/db/schema";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { executeAiRefreshTarget } from "~/server/domains/run/service/ai-refresh";
import {
  kernelCtx,
  PRIMARY_MODEL,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { readWorkQueueWith } from "~/server/generic/work-queue/repo/work-queue";
import {
  createProductFixture,
  createIngredientFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import { readEntityConnections } from "../repo/entity-connections";
import { prepareEntityConnections } from "./entity-connections";

// Failure modes: model preparation publishes before cancellation is checked;
// the field publisher escapes its caller's fenced transaction; a bespoke review
// key reopens the exact inference a member already graded Wrong inline.
describe("connection preparation and publication authority", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await getDb(ctx.db).insert(user).values({
      id: systemActor().userId,
      name: "Synthetic system",
      email: "synthetic-system@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
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
      trade: "electrical",
      subjectProductId: null,
    });
    return {
      source: { entityKind: "task" as const, entityId: task.output.id },
      task,
      name,
      item,
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

  it("refuses a field target changed while inference is pending even without a refreshed search projection", async () => {
    const { source, item, task } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preparation = prepareEntityConnections(
      ctx.db,
      kernelCtx(ctx),
      source,
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error("Preparation ended before field inference");
        }),
      ]);
      await getDb(ctx.db)
        .update(product)
        .set({ name: "Synthetic changed target identity" })
        .where(eq(product.id, item.entityId));
    } finally {
      release.resolve();
    }
    await expect(preparation).rejects.toThrow(
      /target changed during inference/i,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(
          and(
            eq(assessmentState.recordId, task.entityId),
            eq(assessmentState.status, "pending"),
          ),
        ),
    ).toEqual([]);
  });

  it("refuses an acquisition candidate assigned to another Product while subsequent inference is pending", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic basil powder",
        manufacturer: "Synthetic pantry",
      }),
      ctx.actor,
    );
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic unrelated socket",
        manufacturer: "Synthetic hardware",
      }),
      ctx.actor,
    );
    const ingredient = await createIngredientFixture(
      ctx.db,
      buildEntity("ingredient", { name: "Synthetic basil powder" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "ingredient", ingredient.entityId);
    const charge = await createRepoEntity(ctx, "expense", {
      name: "Synthetic basil powder",
      trade: "electrical",
      cost: 18,
      costType: "materials",
    });
    await refreshSearchDocument(ctx.db, "expense", charge.entityId);
    const [before] = await getDb(ctx.db)
      .select({ hash: searchDocument.sourceHash })
      .from(searchDocument)
      .where(eq(searchDocument.entityId, charge.entityId));
    if (!before)
      throw new Error("Synthetic expense search projection is missing");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preparation = prepareEntityConnections(
      ctx.db,
      kernelCtx(ctx),
      { entityKind: "product", entityId: item.id },
      {
        suggestPorts: {
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (input) => {
            entered.resolve();
            await release.promise;
            return chooseFirst(input);
          },
        },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        preparation.then(() => {
          throw new Error(
            "Connection preparation ended before external inference",
          );
        }),
      ]);
      // This real stored-value drift intentionally leaves SearchDocument unchanged.
      await getDb(ctx.db)
        .update(expense)
        .set({ productId: other.entityId })
        .where(eq(expense.id, charge.entityId));
      expect(
        (
          await getDb(ctx.db)
            .select({ hash: searchDocument.sourceHash })
            .from(searchDocument)
            .where(eq(searchDocument.entityId, charge.entityId))
        )[0],
      ).toEqual(before);
    } finally {
      release.resolve();
    }
    const publish = await preparation;
    await expect(withTransactionDatabase(ctx.db, publish)).rejects.toThrow(
      /evidence changed|no longer eligible|already assigned/i,
    );
    expect(
      (
        await getDb(ctx.db)
          .select({ productId: expense.productId })
          .from(expense)
          .where(eq(expense.id, charge.entityId))
      )[0]?.productId,
    ).toBe(other.entityId);
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(
          and(
            eq(assessmentState.family, "recommendation"),
            eq(assessmentState.recordId, item.entityId),
            eq(assessmentState.active, true),
            eq(assessmentState.status, "pending"),
          ),
        ),
    ).toEqual([]);
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

  it("removes stale field connections from Relations and the household Work aggregate", async () => {
    const { source, item } = await fixture();
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
    await withTransactionDatabase(ctx.db, publish);
    expect(await readEntityConnections(ctx.db, source)).toContainEqual(
      expect.objectContaining({
        relation: "task-subject-product",
        integration: { kind: "field-review", field: "subjectProductId" },
      }),
    );
    // The suggested value names the target, so the Product reads it too.
    expect(
      await readEntityConnections(ctx.db, {
        entityKind: "product",
        entityId: item.id,
      }),
    ).toContainEqual(
      expect.objectContaining({
        relation: "task-subject-product",
        integration: { kind: "field-review", field: "subjectProductId" },
      }),
    );
    const before = await readWorkQueueWith(
      async () => [],
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100 }),
      false,
      ctx.actor,
    );
    expect(before.items).toContainEqual(
      expect.objectContaining({
        key: "suggestions:field",
        suggestionFamily: "field",
      }),
    );
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic renamed target evidence" })
      .where(eq(product.id, item.entityId));
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);
    const after = await readWorkQueueWith(
      async () => [],
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100 }),
      false,
      ctx.actor,
    );
    expect(after.items).not.toContainEqual(
      expect.objectContaining({
        key: "suggestions:field",
        suggestionFamily: "field",
      }),
    );
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
