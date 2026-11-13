import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run, runStep } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRunPass } from "~/server/domains/run/repo/run-execution";
import { JobRetryableError } from "~/server/generic/jobs/errors";
import { cancelWork } from "~/server/kernel/api";

import { controlWorkflowRun } from "./control";
import {
  launchWorkflowRun,
  recordRunProgress,
  resumeClaimedWorkflowRun,
  claimWorkflowRun,
} from "./lifecycle";
import { runPassFixture } from "./pass.fixtures";

describe("Run Pass admission", () => {
  const ctx = withTestDb();
  // A generic Job retry must restore its reconciled Run too. Admission waits
  // for a competing pass, and member stops still win over an old lease.
  it("restores a recovered Run only under its live Pass claim and available admission slot", async () => {
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
    const execution = await readRunPass(ctx.db, id);
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
    await cancelWork(ctx.db, { table: "Pass", name: "run.execute", key: id });
    await launchWorkflowRun(ctx.db, { runId: id, purpose: "maintenance" });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "job_failed" })
      .where(eq(run.id, id));
    const competing = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const claim = await runPassFixture(ctx.db, id);
    const owned = claim.owned;
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
    await cancelWork(ctx.db, { table: "Pass", name: "run.execute", key: id });
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

  it("refuses a finished Run whose pruned Pass no longer does", async () => {
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
    expect(await readRunPass(ctx.db, id)).toBeNull();
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
    const execution = await readRunPass(ctx.db, id);
    if (!execution) throw new Error("Missing execution");
    const fundingDeadline = new Date(Date.now() + 3_600_000);
    await getDb(ctx.db)
      .execute(sql`UPDATE "Pass" SET "availableAt" = ${fundingDeadline.toISOString()}::timestamp,
      "waitCause" = 'funding', attempts = 1 WHERE name = 'run.execute' AND key = ${id}`);
    await launchWorkflowRun(ctx.db, {
      runId: id,
      purpose: "maintenance",
      automatic: true,
    });
    const waiting = await readRunPass(ctx.db, id);
    expect(waiting?.availableAt).toEqual(fundingDeadline);
    expect(waiting?.waitCause).toBe("funding");
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "paused_auth",
        failureCode: "execution_limit",
      })
      .where(eq(run.id, id));
    await launchWorkflowRun(ctx.db, { runId: id, purpose: "maintenance" });
    const resumed = await readRunPass(ctx.db, id);
    expect(resumed).toMatchObject({
      runId: id,
      generation: execution.generation,
      attempts: 1,
    });
    if (!resumed) throw new Error("Missing resumed execution");
    expect(resumed.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    const claimed = await runPassFixture(ctx.db, id);
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
    await expect(
      claimed.owned(() =>
        claimWorkflowRun(ctx.db, { runId: id, attempt: claimed.generation }),
      ),
    ).rejects.toThrow(/obsolete/);
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
  it("records current Pass progress and fences progress after pause", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const execution = await readRunPass(ctx.db, id);
    if (!execution) throw new Error("Missing execution");
    const claim = await runPassFixture(ctx.db, id);
    const record = (sequence: number) =>
      claim.owned(() =>
        recordRunProgress(
          ctx.db,
          id,
          sequence === 1 ? "working" : "late",
          "Synthetic page",
          { attempt: claim.generation, sequence },
        ),
      );
    await expect(record(1)).resolves.toEqual({ recorded: true });
    await cancelWork(ctx.db, { table: "Pass", name: "run.execute", key: id });
    await expect(record(2)).rejects.toThrow(/obsolete/);
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    expect(owner?.liveProgress?.phase).toBe("working");
  });

  it("rolls Run and Pass admission back with the caller transaction", async () => {
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
    expect(
      (await getDb(ctx.db).execute(sql`SELECT * FROM "Pass"`)).rows,
    ).toEqual([]);
  });
});
