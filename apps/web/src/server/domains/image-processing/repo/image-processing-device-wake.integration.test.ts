import { parseEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  job as durableJob,
  jobInvalidationCapture,
} from "~/server/db/retained-tables";
import { image } from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { dueJobs } from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { productionJobHandlers } from "~/server/workflows/jobs";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  releaseAssignedImageProcessingJob,
  repairImageProcessingExecution,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";

// Review finding: parked device work had no scheduled wakeup. A device's
// refill pull right after a failure found only future backoff and went idle;
// when the backoff (or an abandoned lease) expired nothing rang the device,
// because `image.device` is never drained and nothing else watched it.
describe("parked device work wakes idle companions", () => {
  const ctx = withTestDb();
  const userId = "synthetic-background-user";
  const deviceId = crypto.randomUUID();
  let rings = 0;
  let ringFailures = 0;
  beforeEach(() => {
    rings = 0;
    ringFailures = 0;
    setCfEnv(
      fromPartial<Env>({
        IMAGE_PROCESSING: {
          getByName: () => ({
            ring: async () => {
              if (ringFailures > 0) {
                ringFailures--;
                throw new Error("Synthetic doorbell RPC failure");
              }
              rings++;
              return 1;
            },
          }),
        },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  async function parked() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "shelf.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "c".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const created = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!created) throw new Error("Expected job");
    const lease = await claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION],
      deviceId,
    });
    if (!lease) throw new Error("Expected lease");
    await assignImageProcessingExecutor(ctx.db, {
      jobId: lease.id,
      attemptId: lease.attemptId,
      userId,
      executor: {
        kind: "device",
        deviceId,
        name: "Test phone",
        platform: "ios",
        appVersion: "1",
        osVersion: "26",
      },
    });
    return lease;
  }

  /** Only scheduled server work runs: no unrelated save, pull or connect. */
  const runScheduledServerWork = async () => {
    for (let round = 0; round < 10; round++) {
      const due = (await dueJobs(ctx.db, 20)).filter((row) =>
        row.kind.startsWith("image."),
      );
      if (!due.length) return;
      for (const row of due)
        await advanceJob(ctx.db, row.id, productionJobHandlers);
    }
  };
  /** Time passes: every scheduled availability and lease moves two days back. */
  const elapse = () =>
    getDb(ctx.db)
      .update(durableJob)
      .set({
        availableAt: sql`${durableJob.availableAt} - interval '2 days'`,
        leaseExpiresAt: sql`${durableJob.leaseExpiresAt} - interval '2 days'`,
      });

  it.each(["failure backoff", "abandoned lease"] as const)(
    "rings once parked device work becomes available after its %s",
    async (cause) => {
      const lease = await parked();
      if (cause === "failure backoff")
        await completeImageProcessingJob(ctx.db, {
          result: {
            jobId: lease.id,
            attemptId: lease.attemptId,
            completedAt: new Date().toISOString(),
            outcome: {
              kind: "describe_image",
              status: "failed",
              reason: "Synthetic device failure",
              retryable: true,
            },
          },
        });
      rings = 0;
      await runScheduledServerWork();
      // Nothing is claimable yet, so nothing rings.
      expect(rings).toBe(0);
      await elapse();
      await runScheduledServerWork();
      expect(rings).toBeGreaterThan(0);
    },
  );

  // Review finding: the wake used the best-effort ring, which logs an RPC
  // failure and reports zero companions. When the only parked work had just
  // come due, nothing was scheduled later, so the wake completed and the
  // idle device was never signalled. The durable wake now fails its page on
  // an RPC failure and its retry rings again.
  it("retries the wake after a failed doorbell RPC until it rings", async () => {
    const lease = await parked();
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: lease.id,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "failed",
          reason: "Synthetic device failure",
          retryable: true,
        },
      },
    });
    await runScheduledServerWork();
    await elapse();
    ringFailures = 1;
    rings = 0;
    await runScheduledServerWork();
    expect(ringFailures).toBe(0);
    expect(rings).toBe(0);
    // The failed page keeps the wake scheduled; its retry rings.
    await elapse();
    await runScheduledServerWork();
    expect(rings).toBeGreaterThan(0);
  });

  // Review finding: the watchdog armed the wake on every tick while device
  // work was parked. Arming is a restarting capture, so a tick made a
  // backing-off wake due at once and reset its attempts and error, defeating
  // its backoff after doorbell failures. A live wake now keeps its state.
  it("keeps a backing-off wake's retry state across a watchdog tick", async () => {
    const lease = await parked();
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: lease.id,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "failed",
          reason: "Synthetic device failure",
          retryable: true,
        },
      },
    });
    await runScheduledServerWork();
    await elapse();
    ringFailures = 1;
    await runScheduledServerWork();
    const wake = async () =>
      (
        await getDb(ctx.db)
          .select()
          .from(durableJob)
          .where(eq(durableJob.key, "image.device.wake"))
      )[0]!;
    const backingOff = await wake();
    expect(backingOff).toMatchObject({ state: "retry_wait" });
    expect(backingOff.error).toContain("Synthetic doorbell RPC failure");
    await repairImageProcessingExecution(ctx.db, 25);
    expect(await wake()).toMatchObject({
      state: "retry_wait",
      availableAt: backingOff.availableAt,
      attempts: backingOff.attempts,
      error: backingOff.error,
    });
    expect(
      (await dueJobs(ctx.db, 20)).some((row) => row.id === backingOff.id),
    ).toBe(false);
  });

  it("requeues a finished wake from a watchdog tick without a capture", async () => {
    await parked();
    await runScheduledServerWork();
    await getDb(ctx.db)
      .update(durableJob)
      .set({ state: "completed" })
      .where(eq(durableJob.key, "image.device.wake"));
    const [before] = await getDb(ctx.db)
      .select({ revision: sql<number>`count(*)::int` })
      .from(jobInvalidationCapture)
      .where(eq(jobInvalidationCapture.key, "image.device.wake"));
    await repairImageProcessingExecution(ctx.db, 25);
    const [wake] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.key, "image.device.wake"));
    expect(wake?.state).toBe("queued");
    expect((await dueJobs(ctx.db, 20)).some((row) => row.id === wake?.id)).toBe(
      true,
    );
    const [after] = await getDb(ctx.db)
      .select({ revision: sql<number>`count(*)::int` })
      .from(jobInvalidationCapture)
      .where(eq(jobInvalidationCapture.key, "image.device.wake"));
    expect(after?.revision).toBe(before?.revision);
  });

  // Review finding: recovery read a completed wake, then armed it; a claim or
  // doorbell failure committing in between left a fresh retry that the
  // restarting arm bypassed. A trigger plays that concurrent writer at the
  // point recovery writes (its marker capture or its wake insert).
  it("keeps a retry a concurrent failure writes while recovery runs", async () => {
    await parked();
    await runScheduledServerWork();
    await getDb(ctx.db)
      .update(durableJob)
      .set({ state: "completed" })
      .where(eq(durableJob.key, "image.device.wake"));
    const database = getDb(ctx.db);
    await database.execute(
      sql.raw(`CREATE FUNCTION synthetic_concurrent_wake_retry() RETURNS trigger AS $$
      BEGIN
        UPDATE "Job" SET state = 'retry_wait', attempts = 3,
          error = 'Synthetic concurrent doorbell failure',
          "availableAt" = now() + interval '7 minutes'
        WHERE key = 'image.device.wake' AND state = 'completed';
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await database.execute(
      sql.raw(`CREATE TRIGGER synthetic_concurrent_wake_retry_marker
      BEFORE INSERT ON "JobInvalidation" FOR EACH ROW
      WHEN (NEW.key = 'image.device.wake')
      EXECUTE FUNCTION synthetic_concurrent_wake_retry()`),
    );
    await database.execute(
      sql.raw(`CREATE TRIGGER synthetic_concurrent_wake_retry_job
      BEFORE INSERT ON "Job" FOR EACH ROW
      WHEN (NEW.key = 'image.device.wake')
      EXECUTE FUNCTION synthetic_concurrent_wake_retry()`),
    );
    try {
      await repairImageProcessingExecution(ctx.db, 25);
    } finally {
      await database.execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS synthetic_concurrent_wake_retry_marker ON "JobInvalidation"`,
        ),
      );
      await database.execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS synthetic_concurrent_wake_retry_job ON "Job"`,
        ),
      );
      await database.execute(
        sql.raw(`DROP FUNCTION IF EXISTS synthetic_concurrent_wake_retry()`),
      );
    }
    const [wake] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.key, "image.device.wake"));
    expect(wake).toMatchObject({
      state: "retry_wait",
      attempts: 3,
      error: "Synthetic concurrent doorbell failure",
    });
    expect((await dueJobs(ctx.db, 20)).some((row) => row.id === wake?.id)).toBe(
      false,
    );
  });

  it("rings when a device releases work it cannot run", async () => {
    const lease = await parked();
    rings = 0;
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: lease.id,
        attemptId: lease.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(true);
    await runScheduledServerWork();
    expect(rings).toBeGreaterThan(0);
  });
});
