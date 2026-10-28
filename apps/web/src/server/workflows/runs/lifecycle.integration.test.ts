import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { withJobExecution } from "~/server/generic/jobs/context";
import {
  claimExternal,
  settleExternalClaim,
} from "~/server/generic/jobs/repo/external-claim";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { pauseJob } from "~/server/generic/jobs/repo/operator";
import { claimContext } from "~/server/generic/jobs/service/jobs";

import { controlWorkflowRun } from "./control";
import { withWorkflowExecution } from "./execution";
import { launchWorkflowRun, recordRunProgress } from "./lifecycle";

describe("Run Job admission", () => {
  const ctx = withTestDb();
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
    const claimed = await claimExternal(ctx.db, execution.id);
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
      await settleExternalClaim(ctx.db, claimed, { done: true }, async () => {
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
    const [execution] = await readJobs(ctx.db, { key: `run:${id}` });
    if (!execution) throw new Error("Missing execution");
    const claim = await claimExternal(ctx.db, execution.id);
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
