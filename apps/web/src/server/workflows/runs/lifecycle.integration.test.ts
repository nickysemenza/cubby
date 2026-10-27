import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { withJobExecution } from "~/server/generic/jobs/context";
import {
  claimJob,
  renewJob,
  publishJobPage,
} from "~/server/generic/jobs/repo/external-claim";
import { pauseJob } from "~/server/generic/jobs/repo/operator";
import { dueJobs } from "~/server/generic/jobs/repo/queue";

import { controlWorkflowRun } from "./control";
import {
  launchWorkflowRun,
  recordRunProgress,
  reconcileWorkflowRuns,
} from "./lifecycle";

describe("Run Job admission", () => {
  const ctx = withTestDb();
  it.each(["execution_limit", null])(
    "stops idle Sweep ownership and projects only its execution-limit pause: %s",
    async (failureCode) => {
      const id = await ensureRun(ctx.db, ctx.actor, {
        purpose: "sweep",
        trigger: "manual",
        status: "running",
        input: {
          kind: "sweep",
          families: [{ family: "statement_transaction", scope: {} }],
        },
      });
      const [execution] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, `run:${id}`));
      expect(execution?.recoveryTimeoutMs).toBe(30 * 60_000);
      const claim = await claimJob(ctx.db, execution!.id);
      if (!claim) throw new Error("Expected Sweep claim");
      await getDb(ctx.db)
        .update(job)
        .set({ lastUsefulProgressAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(job.id, claim.id));
      await getDb(ctx.db)
        .update(run)
        .set({ status: "paused_auth", failureCode })
        .where(eq(run.id, id));
      expect(await renewJob(ctx.db, claim)).toBe(true);
      await dueJobs(ctx.db);
      expect(await publishJobPage(ctx.db, claim, { done: true })).toBe(false);
      await reconcileWorkflowRuns(ctx.db);
      const [owner] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, id));
      expect(owner?.status).toBe(
        failureCode === "execution_limit" ? "failed" : "paused_auth",
      );
      expect(owner?.failureCode).toBe(failureCode ? "job_failed" : null);
    },
  );

  it("commits Run and execution together, coalesces launches, and fences cancellation", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const launches = await Promise.all([
      launchWorkflowRun(ctx.db, {
        runId: id,
        purpose: "maintenance",
        automatic: true,
      }),
      launchWorkflowRun(ctx.db, {
        runId: id,
        purpose: "maintenance",
        automatic: true,
      }),
    ]);
    expect(launches[0]?.instanceId).toBe(launches[1]?.instanceId);
    const [execution] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, `run:${id}`));
    if (!execution) throw new Error("Missing execution");
    const claimed = await claimJob(ctx.db, execution.id);
    if (!claimed) throw new Error("Missing claim");
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    if (!owner) throw new Error("Missing Run");
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: owner.shortcode, action: "cancel" },
      "maintenance",
    );
    let published = false;
    expect(
      await publishJobPage(ctx.db, claimed, { done: true }, async () => {
        published = true;
      }),
    ).toBe(false);
    expect(published).toBe(false);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
        ?.failureCode,
    ).toBe("user_cancelled");
  });

  // Progress must use the same Job generation as publication; an old Worker
  // must not retain a heartbeat after a member pauses its execution.
  it("records current Job progress and fences progress after pause", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const [execution] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, `run:${id}`));
    if (!execution) throw new Error("Missing execution");
    const claim = await claimJob(ctx.db, execution.id);
    if (!claim) throw new Error("Missing claim");
    await expect(
      withJobExecution(ctx.db, claim, () =>
        recordRunProgress(ctx.db, id, "working", "Synthetic page", {
          attempt: claim.generation,
          sequence: 1,
        }),
      ),
    ).resolves.toEqual({ recorded: true });
    await pauseJob(ctx.db, execution.id);
    await expect(
      withJobExecution(ctx.db, claim, () =>
        recordRunProgress(ctx.db, id, "late", "Synthetic stale page", {
          attempt: claim.generation,
          sequence: 2,
        }),
      ),
    ).rejects.toThrow("Job generation or lease is obsolete");
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    expect(owner?.liveProgress?.phase).toBe("working");
  });

  it("rolls Run and Job admission back with the caller transaction", async () => {
    const key = "synthetic-run-rollback";
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await ensureRun(tx, ctx.actor, {
          purpose: "maintenance",
          trigger: "manual",
          status: "running",
          clientKey: key,
        });
        throw new Error("Synthetic rejected admission");
      }),
    ).rejects.toThrow("Synthetic rejected admission");
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.clientKey, key)),
    ).toEqual([]);
    expect(await getDb(ctx.db).select().from(job)).toEqual([]);
  });
});
