import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { withJobExecution } from "~/server/generic/jobs/context";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import { cancelJob, retryJob } from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { claimJob } from "~/server/generic/jobs/repo/queue";
import { claimContext } from "~/server/generic/jobs/service/jobs";

import {
  assertWorkflowEffect,
  isWorkflowInterrupted,
  withWorkflowExecution,
} from "./execution";

describe("Workflow effect admission", () => {
  const ctx = withTestDb();

  it("recognizes obsolete Job ownership through wrapped causes", () => {
    const error = new JobSupersededError();
    expect(isWorkflowInterrupted(error)).toBe(true);
    expect(
      isWorkflowInterrupted(new Error("Publication failed", { cause: error })),
    ).toBe(true);
    expect(isWorkflowInterrupted(new Error("Synthetic item failure"))).toBe(
      false,
    );
  });

  // Workflow context must retain the Job fence across cancellation and replacement.
  it("rechecks current Job authority inside every publication transaction", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const saved = await enqueueJob(ctx.db, {
      key: `run:${runId}`,
      kind: "run.execute",
      input: { runId, purpose: "maintenance" },
      runId,
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Synthetic Workflow Job was not claimed");
    const publish = () =>
      withTransactionDatabase(ctx.db, async (tx) => {
        await assertWorkflowEffect(tx);
        await getDb(tx).execute(sql`SELECT 1`);
      });
    await withJobExecution(ctx.db, claim, () =>
      withWorkflowExecution(
        { runId, attempt: claim.generation, job: claimContext(ctx.db, claim) },
        async () => {
          await expect(publish()).resolves.toBeUndefined();
          await cancelJob(ctx.db, saved.id);
          await expect(publish()).rejects.toThrow(/obsolete/);
          await retryJob(ctx.db, saved.id);
          await expect(publish()).rejects.toThrow(/obsolete/);
        },
      ),
    );
    await expect(publish()).resolves.toBeUndefined();
  });
});
