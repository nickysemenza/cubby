import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { assertWorkflowEffect, withWorkflowExecution } from "./execution";

describe("Workflow effect admission", () => {
  const ctx = withTestDb();

  // A memoized earlier guard cannot authorize a later effect after cancellation,
  // or attempt replacement, including a retry of the same callback.
  it("rechecks current authority inside every publication transaction", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: {
          attempt: 1,
          total: 0,
          done: 0,
          applied: 0,
          queued: 0,
          failed: 0,
          diagnostics: [],
        },
      })
      .where(eq(run.id, runId));
    const publish = () =>
      withTransactionDatabase(ctx.db, async (tx) => {
        await assertWorkflowEffect(tx);
        await getDb(tx).execute(sql`SELECT 1`);
      });
    await withWorkflowExecution({ runId, attempt: 1 }, async () => {
      await expect(publish()).resolves.toBeUndefined();
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed" })
        .where(eq(run.id, runId));
      await expect(publish()).rejects.toMatchObject({ reason: "cancelled" });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "running",
          progress: {
            attempt: 2,
            total: 0,
            done: 0,
            applied: 0,
            queued: 0,
            failed: 0,
            diagnostics: [],
          },
        })
        .where(eq(run.id, runId));
      await expect(publish()).rejects.toMatchObject({ reason: "superseded" });
    });
    // Interactive writers have their own authority and do not inherit a Run.
    await expect(publish()).resolves.toBeUndefined();
  });
});
