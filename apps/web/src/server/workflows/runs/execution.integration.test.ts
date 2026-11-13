import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import { cancelWork } from "~/server/kernel/api";

import { assertWorkflowEffect, isWorkflowInterrupted } from "./execution";
import { runPassFixture } from "./pass.fixtures";
import { startRunPass } from "./run-pass";

describe("Workflow effect admission", () => {
  const ctx = withTestDb();

  it("recognizes obsolete claim ownership through wrapped causes", () => {
    const error = new JobSupersededError();
    expect(isWorkflowInterrupted(error)).toBe(true);
    expect(
      isWorkflowInterrupted(new Error("Publication failed", { cause: error })),
    ).toBe(true);
    expect(isWorkflowInterrupted(new Error("Synthetic item failure"))).toBe(
      false,
    );
  });

  // Workflow context must retain the Pass fence across cancellation and replacement.
  it("rechecks current Pass authority inside every publication transaction", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const claim = await runPassFixture(ctx.db, runId);
    const publish = (notes = "published") =>
      withTransactionDatabase(ctx.db, async (tx) => {
        await assertWorkflowEffect(tx);
        await getDb(tx).execute(
          sql`UPDATE "Run" SET notes = ${notes} WHERE id = ${runId}`,
        );
      });
    await claim.owned(async () => {
      await expect(publish()).resolves.toBeUndefined();
      await cancelWork(ctx.db, {
        table: "Pass",
        name: "run.execute",
        key: runId,
      });
      await expect(publish("stale")).rejects.toThrow(/obsolete/);
      const savedRun = await getDb(ctx.db).execute<{ notes: string }>(
        sql`SELECT notes FROM "Run" WHERE id = ${runId}`,
      );
      expect(savedRun.rows[0]?.notes).toBe("published");
      await startRunPass(ctx.db, {
        runId,
        purpose: "maintenance",
        generation: claim.generation + 1,
        restart: true,
      });
      await expect(publish()).rejects.toThrow(/obsolete/);
    });
    await expect(publish()).resolves.toBeUndefined();
  });
});
