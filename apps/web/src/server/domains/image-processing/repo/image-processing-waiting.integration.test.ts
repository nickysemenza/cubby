import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { fundingWaiters } from "~/server/ai/funding-wait";
import { getDb } from "~/server/db/helpers";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { imageExecutionReceipts } from "~/server/domains/image-processing/repo/execution-receipts";
import { readImageExecutions } from "~/server/domains/image-processing/repo/image-execution.fixtures";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

import {
  imageJobDisplayStateSql,
  imageJobWaitingOn,
  imageJobWaitingOnReasonSql,
} from "./image-job-state";
import {
  claimImageProcessingJob,
  createTransparentDerivativeAndJob,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";

describe("device work waits parked and records no attempt", () => {
  const ctx = withTestDb();

  async function subjectLiftJob() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "c".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      sourceContentHash: hash,
      key: `pending/${crypto.randomUUID()}.png`,
    });
    if (!scheduled) throw new Error("Expected persisted job");
    return scheduled.jobId;
  }
  const attemptsOf = (jobId: ImageJobId) =>
    getDb(ctx.db)
      .select()
      .from(imageExecutionReceipts)
      .where(eq(imageExecutionReceipts.jobId, jobId));
  const jobOf = async (jobId: ImageJobId) => {
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    if (!job) throw new Error("Missing job");
    return job;
  };

  it("parks device work out of the server drain without attempts or polling", async () => {
    const jobId = await subjectLiftJob();
    const [execution] = await readImageExecutions(ctx.db, jobId);
    if (!execution) throw new Error("Missing execution");
    expect(execution).toMatchObject({
      kind: "device",
      state: "queued",
      attempts: 0,
    });

    expect(await readImageExecutions(ctx.db, jobId)).toMatchObject([
      { state: "queued", attempts: 0 },
    ]);
    expect(await attemptsOf(jobId)).toHaveLength(0);
    expect((await jobOf(jobId)).attempts).toBe(0);
    expect(imageJobWaitingOn(await jobOf(jobId), new Date())).toMatchObject({
      reason: "waiting_device",
      lane: "apple_device",
    });
    const [displayed] = await getDb(ctx.db)
      .select({ state: imageJobDisplayStateSql() })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(displayed?.state).toBe("waiting_for_device");
  });

  it("classifies the same image wait in SQL and in memory", async () => {
    const jobId = await subjectLiftJob();
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    for (const fields of [
      {
        waitReason: "ai_funding_window" as const,
        runAt: future,
        leaseUntil: null,
      },
      { waitReason: "device" as const, runAt: future, leaseUntil: null },
      { waitReason: null, runAt: future, leaseUntil: null },
      { waitReason: null, runAt: now, leaseUntil: future },
      { waitReason: null, runAt: now, leaseUntil: null },
    ]) {
      await getDb(ctx.db)
        .update(imageProcessingJob)
        .set(fields)
        .where(eq(imageProcessingJob.id, jobId));
      const [row] = await getDb(ctx.db)
        .select({
          reason: imageJobWaitingOnReasonSql("ImageProcessingJob", now),
        })
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, jobId));
      expect(row?.reason).toBe(
        imageJobWaitingOn(await jobOf(jobId), now).reason,
      );
    }
  });

  it("counts and wakes image jobs waiting for funding", async () => {
    const jobId = await subjectLiftJob();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({
        runAt: new Date(Date.now() + 60_000),
        waitReason: "ai_funding_window",
      })
      .where(eq(imageProcessingJob.id, jobId));
    const waiter = fundingWaiters.find((entry) => entry.name === "images")!;
    const now = new Date();
    expect(await waiter.count(ctx.db, now)).toBe(1);
    expect(await waiter.wake(ctx.db, now, true)).toBe(1);
    expect(await waiter.count(ctx.db, now)).toBe(0);
    expect((await jobOf(jobId)).runAt.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("creates exactly one attempt when a device takes the lease", async () => {
    const jobId = await subjectLiftJob();
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["subject_lift"],
      leaseMs: 60_000,
    });
    if (!lease) throw new Error("Expected lease");
    expect(await attemptsOf(jobId)).toHaveLength(0);
    expect((await jobOf(jobId)).attempts).toBe(0);
    const assignment = {
      jobId,
      attemptId: lease.attemptId,
      executor: {
        kind: "device" as const,
        deviceId: parseEntityId("device", crypto.randomUUID()),
        name: "Test Mac",
        platform: "macos" as const,
        appVersion: "1",
        osVersion: "26",
      },
    };
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(true);
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(false);
    const attempts = await attemptsOf(jobId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: lease.attemptId,
      number: 1,
      state: "running",
    });
    expect(attempts[0]?.diagnostics).toMatchObject({
      sourceContentHash: lease.sourceContentHash,
      sourceKey: lease.originalKey,
    });
    expect((await jobOf(jobId)).attempts).toBe(1);
  });
});
