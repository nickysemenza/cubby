import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { dispatchImageProcessingWakeup } from "~/server/image-processing/dispatch";

import { getDb } from "./database-helpers";
import { createUploadedImageRecord } from "./image";
import {
  claimImageProcessingJob,
  createTransparentDerivativeAndJob,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";
import {
  pruneExecutorlessWaitingAttempts,
  updateImageProcessingSettings,
} from "./image-processing-maintenance";

describe("waiting for a device records no attempt", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });

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
  const makeDue = (jobId: string) =>
    getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(imageProcessingJob.id, jobId));
  const attemptsOf = (jobId: string) =>
    getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.jobId, jobId));
  const jobOf = async (jobId: string) => {
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    if (!job) throw new Error("Missing job");
    return job;
  };
  const eventsOf = (jobId: string) =>
    getDb(ctx.db)
      .select()
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));

  it("writes no attempt and leaves job.attempts alone across idle cycles", async () => {
    const jobId = await subjectLiftJob();
    for (let cycle = 0; cycle < 4; cycle++) {
      await makeDue(jobId);
      expect(await dispatchImageProcessingWakeup(ctx.db, jobId)).toBe(
        "waiting",
      );
    }
    expect(await attemptsOf(jobId)).toHaveLength(0);
    const job = await jobOf(jobId);
    expect(job.attempts).toBe(0);
    expect(job.state).toBe("waiting_for_device");
    const events = await eventsOf(jobId);
    expect(events.filter((e) => e.event === "dispatch.waiting")).toHaveLength(
      1,
    );
    expect(events.some((e) => e.event === "attempt.claimed")).toBe(false);
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
        deviceId: crypto.randomUUID(),
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

  it("prunes executor-less waiting attempts with their events and fixes job.attempts", async () => {
    const jobId = await subjectLiftJob();
    const db = getDb(ctx.db);
    // Legacy rows: two idle waiting attempts, then one real (numbered 3).
    const [a, b, c] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    await db.insert(imageProcessingAttempt).values([
      { id: a, jobId, number: 1, state: "waiting" },
      { id: b, jobId, number: 2, state: "waiting" },
      {
        id: c,
        jobId,
        number: 3,
        state: "failed",
        executor: {
          kind: "device",
          deviceId: crypto.randomUUID(),
          name: "Test Mac",
          platform: "macos",
          appVersion: "1",
          osVersion: "26",
        },
      },
    ]);
    await db.insert(imageProcessingEvent).values([
      { jobId, eventKey: `${a}:claimed`, event: "attempt.claimed" },
      { jobId, eventKey: `${a}:waiting`, event: "dispatch.waiting" },
      { jobId, eventKey: `${b}:claimed`, event: "attempt.claimed" },
      { jobId, eventKey: `${b}:waiting`, event: "dispatch.waiting" },
      { jobId, eventKey: `${c}:claimed`, event: "attempt.claimed" },
    ]);
    await db
      .update(imageProcessingJob)
      .set({ attempts: 3 })
      .where(eq(imageProcessingJob.id, jobId));

    expect(await pruneExecutorlessWaitingAttempts(ctx.db, 100)).toBe(2);
    expect(await pruneExecutorlessWaitingAttempts(ctx.db, 100)).toBe(0);

    expect((await attemptsOf(jobId)).map((row) => row.id)).toEqual([c]);
    expect((await eventsOf(jobId)).map((e) => e.eventKey)).toEqual([
      `${c}:claimed`,
    ]);
    expect((await jobOf(jobId)).attempts).toBe(1);
  });
});
