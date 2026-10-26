import { and, eq, like } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { cancelRunAiWork } from "./control";

// Production finding: Run cancel called cancelJob once per evaluation inside
// one transaction under the global AI admission lock and timed out for large
// Runs. Cancel is one set-based statement.
describe("Run AI work cancel", () => {
  const ctx = withTestDb();

  it("stops every owned evaluation's Job in one pass", async () => {
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
    const executions = await getDb(ctx.db)
      .select({ state: job.state })
      .from(job)
      .where(
        and(eq(job.kind, "ai.evaluation"), like(job.key, "ai-evaluation:%")),
      );
    expect(executions).toHaveLength(120);
    expect(executions.every((row) => row.state === "cancelled")).toBe(true);
  });
});
