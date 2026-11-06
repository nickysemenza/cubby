import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run, runStep } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { withJobExecution } from "~/server/generic/jobs/context";
import { JobRetryableError } from "~/server/generic/jobs/errors";
import {
  claimJob,
  publishJobPage,
  updateJobs,
} from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { pauseJob, retryJob } from "~/server/generic/jobs/repo/operator";
import { claimContext } from "~/server/generic/jobs/service/jobs";

import { controlWorkflowRun } from "./control";
import { withWorkflowExecution } from "./execution";
import {
  launchWorkflowRun,
  recordRunProgress,
  resumeClaimedWorkflowRun,
  claimWorkflowRun,
} from "./lifecycle";

describe("Run Job admission", () => {
  const ctx = withTestDb();
  // A generic Job retry must restore its reconciled Run too. Admission waits
  // for a competing pass, and member stops still win over an old lease.
  it("restores a recovered Run only under its live Job claim and available admission slot", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    await launchWorkflowRun(ctx.db, {
      runId: id,
      purpose: "maintenance",
      automatic: true,
    });
    const [execution] = await readJobs(ctx.db, { key: `run:${id}` });
    if (!execution) throw new Error("Synthetic Run execution missing");
    const progress = aiRefreshProgress.parse({ selected: 7, completed: 2 });
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        failureCode: "job_failed",
        endedAt: new Date(),
        progress,
      })
      .where(eq(run.id, id));
    await updateJobs(
      ctx.db,
      { id: execution.id },
      { state: "failed", attempts: 3 },
    );
    await retryJob(ctx.db, execution.id);
    const competing = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const claim = await claimJob(ctx.db, execution.id);
    if (!claim) throw new Error("Synthetic recovered Job missing");
    const owned = <T>(work: () => Promise<T>) =>
      withJobExecution(ctx.db, claim, () =>
        withWorkflowExecution(
          {
            runId: id,
            attempt: claim.generation,
            job: claimContext(ctx.db, claim),
          },
          work,
        ),
      );
    const params = { runId: id, attempt: claim.generation };
    await expect(
      owned(() => resumeClaimedWorkflowRun(ctx.db, params)),
    ).rejects.toBeInstanceOf(JobRetryableError);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]?.status,
    ).toBe("failed");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, competing));
    await owned(() => resumeClaimedWorkflowRun(ctx.db, params));
    expect(await owned(() => claimWorkflowRun(ctx.db, params))).toMatchObject({
      id,
      status: "running",
      failureCode: null,
      endedAt: null,
      progress: { ...progress, attempt: claim.generation },
    });
    await pauseJob(ctx.db, execution.id);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "job_failed" })
      .where(eq(run.id, id));
    await expect(
      owned(() => resumeClaimedWorkflowRun(ctx.db, params)),
    ).rejects.toThrow(/obsolete/);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]?.status,
    ).toBe("failed");
  });

  it("refuses a finished Run whose pruned Job no longer does", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "completed",
    });
    await expect(
      launchWorkflowRun(ctx.db, {
        runId: id,
        purpose: "maintenance",
        automatic: true,
      }),
    ).resolves.toBeNull();
    await expect(
      launchWorkflowRun(ctx.db, { runId: id, purpose: "maintenance" }),
    ).rejects.toThrow("Completed Run cannot be relaunched");
    expect(await readJobs(ctx.db, { key: `run:${id}` })).toEqual([]);
  });

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
    const [execution] = await readJobs(ctx.db, { key: `run:${id}` });
    if (!execution) throw new Error("Missing execution");
    const claimed = await claimJob(ctx.db, execution.id);
    if (!claimed) throw new Error("Missing claim");
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    if (!owner) throw new Error("Missing Run");
    await getDb(ctx.db)
      .insert(runStep)
      .values({
        runId: id,
        key: "synthetic-cancelled-scan",
        label: "Synthetic scan",
        position: 0,
        state: "running",
        found: 10,
        done: 1,
        skipped: 2,
        cursor: { after: "synthetic-retained-cursor" },
      });
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
    expect(
      (
        await getDb(ctx.db).select().from(runStep).where(eq(runStep.runId, id))
      )[0],
    ).toMatchObject({
      state: "failed",
      done: 1,
      skipped: 2,
      failed: 0,
      errors: [],
      cursor: { after: "synthetic-retained-cursor" },
      pausedReason: "Cancelled by a member",
      endedAt: expect.any(Date),
    });
  });

  // Progress must use the same Job generation as publication; an old Worker
  // must not retain a heartbeat after a member pauses its execution.
  it("records current Job progress and fences progress after pause", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const [execution] = await readJobs(ctx.db, { key: `run:${id}` });
    if (!execution) throw new Error("Missing execution");
    const claim = await claimJob(ctx.db, execution.id);
    if (!claim) throw new Error("Missing claim");
    await expect(
      withJobExecution(ctx.db, claim, () =>
        withWorkflowExecution(
          {
            runId: id,
            attempt: claim.generation,
            job: claimContext(ctx.db, claim),
          },
          () =>
            recordRunProgress(ctx.db, id, "working", "Synthetic page", {
              attempt: claim.generation,
              sequence: 1,
            }),
        ),
      ),
    ).resolves.toEqual({ recorded: true });
    await pauseJob(ctx.db, execution.id);
    await expect(
      withJobExecution(ctx.db, claim, () =>
        withWorkflowExecution(
          {
            runId: id,
            attempt: claim.generation,
            job: claimContext(ctx.db, claim),
          },
          () =>
            recordRunProgress(ctx.db, id, "late", "Synthetic stale page", {
              attempt: claim.generation,
              sequence: 2,
            }),
        ),
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
    expect(await readJobs(ctx.db, {})).toEqual([]);
  });
});
