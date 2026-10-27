import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest, run } from "~/server/db/schema";

import { ensureRun } from "./ensure-run";

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
