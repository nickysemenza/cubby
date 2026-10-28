import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueAiEvaluation } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import { aiEvaluationItem } from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readWorkItems } from "~/server/generic/jobs/jobs.fixtures";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { cancelRunAiWork } from "./control";

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
      purpose: "suggestion_sweep",
      trigger: "manual",
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
          assessmentIds: [],
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
    await cancelRunAiWork(ctx.db, runId, "Cancelled by a member");
    const evaluations = await getDb(ctx.db)
      .select({ state: aiEvaluation.state })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId));
    expect(evaluations).toHaveLength(120);
    expect(evaluations.every((row) => row.state === "cancelled")).toBe(true);
    expect(await readWorkItems(ctx.db, { target: "ai.evaluation" })).toEqual(
      [],
    );
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
        assessmentIds: [],
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
      await cancelRunAiWork(ctx.db, first!, "Cancelled by a member", {
        owned: false,
        requested: true,
      }),
    ).toBe(true);
    const [row] = await getDb(ctx.db)
      .select({ state: aiEvaluation.state })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, evaluation.id));
    expect(row?.state).toBe("queued");
    expect(await aiEvaluationItem(ctx.db, evaluation.id)).toMatchObject({
      drain: "ai-evaluation:mailbox-relevance",
    });
  });
});
