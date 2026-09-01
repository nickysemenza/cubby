import { QUEUE_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  dispatchQueuedBackgroundJobs,
  sweepStrandedBackgroundJobs,
} from "~/server/background-dispatch";
import {
  processBackgroundJob,
  processBackgroundQueueMessage,
} from "~/server/background-queue";
import type { BackgroundQueueProducer } from "~/server/background-queue-types";
import { setCfEnv } from "~/server/cf-env";
import { backgroundJob } from "~/server/db/schema";
import {
  abandonBackgroundJob,
  BACKGROUND_JOB_LEASE_MS,
  cancelAbandonedStrandedJobs,
  countAbandonedStrandedJobs,
  createBackgroundBatchWithJobs,
  failOrRetryBackgroundJob,
  findRecoverableStrandedJobs,
  finishBackgroundJob,
  getBackgroundBatchDetail,
  getBackgroundBatchSummary,
  markBackgroundJobRunning,
  STRANDED_JOB_MAX_AGE_MS,
  STRANDED_JOB_MIN_AGE_MS,
  startOrReuseBackgroundWorkflow,
} from "~/server/repo/background-jobs";
import { getDb } from "~/server/repo/database-helpers";

type QueueBody = Parameters<BackgroundQueueProducer["send"]>[0];
type QueueMessage = { body: QueueBody };

function queueFor(sent: QueueMessage[][]): BackgroundQueueProducer {
  return {
    send: async () => {},
    sendBatch: async (messages) => {
      sent.push([...messages]);
    },
  };
}

function queueEnv(sent: QueueMessage[][]): Env {
  return fromPartial<Env>({ BACKGROUND_QUEUE: queueFor(sent) });
}

describe("background job persistence", () => {
  const ctx = withTestDb();

  afterEach(() => setCfEnv());

  it("summarizes job transitions on the batch", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: "test:embedding:one",
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        },
      ],
    });

    const jobId = jobIds[0];
    expect(jobId).toBeDefined();

    let detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.status).toBe("queued");
    expect(detail?.queuedJobs).toBe(1);

    await markBackgroundJobRunning(ctx.db, jobId!);
    detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.status).toBe("running");
    expect(detail?.runningJobs).toBe(1);
    expect(detail?.jobs[0]?.attempts).toBe(1);

    await finishBackgroundJob(ctx.db, jobId!, "skipped");
    detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.status).toBe("succeeded");
    expect(detail?.skippedJobs).toBe(1);
    expect(detail?.wallDurationMs).not.toBeNull();
  });

  it("abandons a dead-lettered job that the stranded sweep can no longer reach", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: "test:embedding:dead-letter",
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        },
      ],
    });
    const jobId = jobIds[0]!;

    // Drive the row into the "stuck queued" state: delivered at least once, so
    // `attempts > 0`, then reset to `queued` by the retry path. The stranded
    // sweep only reclaims rows with `attempts = 0`, so nothing else settles it
    // once Cloudflare stops redelivering.
    await markBackgroundJobRunning(ctx.db, jobId);
    await expect(
      failOrRetryBackgroundJob(ctx.db, jobId, new Error("transient")),
    ).resolves.toBe("retry");
    let detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.jobs[0]?.status).toBe("queued");
    expect(detail?.jobs[0]?.attempts).toBeGreaterThan(0);
    await expect(findRecoverableStrandedJobs(ctx.db, 10)).resolves.toEqual([]);

    await expect(
      abandonBackgroundJob(ctx.db, jobId, "dead-lettered"),
    ).resolves.toBe(true);

    detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.jobs[0]?.status).toBe("failed");
    expect(detail?.jobs[0]?.lastError).toBe("dead-lettered");
    // The parent batch must settle too, or the UI shows it running forever.
    expect(detail?.status).toBe("failed");

    // Replayed dead letters must not overwrite a terminal row.
    await expect(
      abandonBackgroundJob(ctx.db, jobId, "second delivery"),
    ).resolves.toBe(false);
    detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.jobs[0]?.lastError).toBe("dead-lettered");
  });

  it("reclaims a running job only after its worker lease expires", async () => {
    const { jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: "test:embedding:leased",
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        },
      ],
    });
    const jobId = jobIds[0]!;

    expect((await markBackgroundJobRunning(ctx.db, jobId))?.attempts).toBe(1);
    await expect(markBackgroundJobRunning(ctx.db, jobId)).resolves.toBeNull();
    await expect(
      processBackgroundJob(
        ctx.db,
        jobId,
        "entity-embedding.backfill.coordinator",
      ),
    ).resolves.toBe("leased");
    const retries: Array<{ delaySeconds: number }> = [];
    await processBackgroundQueueMessage(ctx.db, {
      body: {
        version: QUEUE_MESSAGE_VERSION,
        queueType: "background",
        batchId: "lease-test",
        jobId,
        kind: "entity-embedding.backfill.coordinator",
      },
      ack: () => {},
      retry: (options) => {
        if (options) retries.push(options);
      },
    });
    expect(retries).toEqual([
      {
        delaySeconds: BACKGROUND_JOB_LEASE_MS / 1_000,
      },
    ]);

    await getDb(ctx.db)
      .update(backgroundJob)
      .set({
        startedAt: new Date(Date.now() - BACKGROUND_JOB_LEASE_MS - 1_000),
      })
      .where(eq(backgroundJob.id, jobId));

    const reclaimed = await markBackgroundJobRunning(ctx.db, jobId);
    expect(reclaimed).toMatchObject({ status: "running", attempts: 2 });
  });

  it("atomically reuses an active workflow and permits a new one after terminal completion", async () => {
    const dedupeKey = `test:workflow-concurrent:${crypto.randomUUID()}`;
    const input = {
      kind: "entity-embedding.backfill.coordinator" as const,
      source: "maintenance" as const,
      dedupeKey,
      metadata: { cursor: null },
      initialJobs: Array.from({ length: 2 }, (_, index) => ({
        kind: "entity-embedding.backfill.coordinator" as const,
        dedupeKey: `${dedupeKey}:seed:${index}`,
        payload: {},
      })),
    };

    const starts = await Promise.all([
      startOrReuseBackgroundWorkflow(ctx.db, input),
      startOrReuseBackgroundWorkflow(ctx.db, input),
    ]);
    expect(starts.filter((start) => !start.reused)).toHaveLength(1);
    expect(new Set(starts.map((start) => start.batch.id)).size).toBe(1);

    const active = starts.find((start) => !start.reused)!;
    const reused = starts.find((start) => start.reused)!;
    expect(active.jobIds).toHaveLength(2);
    expect(new Set(active.jobIds).size).toBe(2);
    expect([...reused.jobIds].sort()).toEqual([...active.jobIds].sort());
    const detail = await getBackgroundBatchDetail(ctx.db, active.batch.id);
    expect(detail?.totalJobs).toBe(2);
    expect(detail?.metadata).toEqual({ cursor: null, reused: true });
    expect(detail?.jobs.map((job) => job.id).sort()).toEqual(
      [...active.jobIds].sort(),
    );

    for (const jobId of active.jobIds) {
      await markBackgroundJobRunning(ctx.db, jobId);
      await finishBackgroundJob(ctx.db, jobId, "succeeded");
    }

    const restarted = await startOrReuseBackgroundWorkflow(ctx.db, input);
    expect(restarted.reused).toBe(false);
    expect(restarted.batch.id).not.toBe(active.batch.id);
    expect(restarted.jobIds).toHaveLength(2);
  });

  it("delivers 201 persisted queued jobs in queue-sized chunks", async () => {
    const sent: QueueMessage[][] = [];
    setCfEnv(queueEnv(sent));
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: Array.from({ length: 201 }, (_, index) => ({
        kind: "entity-embedding.refresh" as const,
        dedupeKey: `test:queued-delivery:${index}`,
        payload: { entityType: "product", entityId: crypto.randomUUID() },
      })),
    });

    await dispatchQueuedBackgroundJobs(ctx.db, {
      batchId,
      jobIds,
      batchKind: "entity-embedding.refresh",
    });

    expect(sent.map((batch) => batch.length)).toEqual([100, 100, 1]);
    expect(
      sent.flatMap((batch) => batch.map((message) => message.body.jobId)),
    ).toEqual(jobIds);
    expect(
      sent.flat().every((message) => message.body.batchId === batchId),
    ).toBe(true);
  });

  it("marks a batch failed when a max-attempt job fails", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "location-ai.description.refresh",
      source: "backfill",
      jobs: [
        {
          kind: "location-ai.description.refresh",
          dedupeKey: "test:location-ai:one",
          payload: { locationId: crypto.randomUUID() },
          maxAttempts: 1,
        },
      ],
    });
    const jobId = jobIds[0];
    expect(jobId).toBeDefined();

    await markBackgroundJobRunning(ctx.db, jobId!);
    const outcome = await failOrRetryBackgroundJob(
      ctx.db,
      jobId!,
      new Error("boom"),
    );

    const detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(outcome).toBe("failed");
    expect(detail?.status).toBe("failed");
    expect(detail?.failedJobs).toBe(1);
    expect(detail?.jobs[0]?.lastError).toBe("boom");
  });

  // A dispatch whose invocation dies mid-sendBatch leaves the durable row at
  // queued/attempts=0 with no wakeup and nothing thrown. These pin the
  // reconciliation that repairs it, and the age split that stops it from
  // re-driving an old backlog nobody wants paid for.
  describe("stranded job reconciliation", () => {
    const stubQueue = () => {
      const sent: QueueMessage[][] = [];
      setCfEnv(queueEnv(sent));
      return sent;
    };

    const ageJob = async (jobId: string, ageMs: number) =>
      await getDb(ctx.db)
        .update(backgroundJob)
        .set({ createdAt: new Date(Date.now() - ageMs) })
        .where(eq(backgroundJob.id, jobId));

    const makeJobs = async (count: number, tag: string) =>
      await createBackgroundBatchWithJobs(ctx.db, {
        kind: "entity-embedding.refresh",
        source: "mutation",
        jobs: Array.from({ length: count }, (_, index) => ({
          kind: "entity-embedding.refresh" as const,
          dedupeKey: `test:stranded:${tag}:${index}`,
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        })),
      });

    it("redispatches lost wakeups and leaves in-flight ones alone", async () => {
      const { batchId, jobIds } = await makeJobs(2, "mixed");
      const [stranded, inFlight] = jobIds;
      if (!stranded || !inFlight) throw new Error("expected two jobs");
      // Only the first is old enough to conclude its message is gone; the
      // second is indistinguishable from a message still being delivered.
      await ageJob(stranded, STRANDED_JOB_MIN_AGE_MS * 2);

      const sent = stubQueue();
      const result = await sweepStrandedBackgroundJobs(ctx.db);

      expect(result).toEqual({ redispatched: 1, batches: 1 });
      expect(sent.flat().map((message) => message.body.jobId)).toEqual([
        stranded,
      ]);
      expect(sent.flat()[0]?.body.batchId).toBe(batchId);
    });

    it("leaves abandoned jobs for an explicit decision", async () => {
      const { jobIds } = await makeJobs(1, "abandoned");
      const [jobId] = jobIds;
      if (!jobId) throw new Error("expected a job");
      await ageJob(jobId, STRANDED_JOB_MAX_AGE_MS * 2);

      const sent = stubQueue();
      // Redispatching these would pay a provider call each to rediscover that
      // nothing changed, which is the whole reason for the upper bound.
      expect(await sweepStrandedBackgroundJobs(ctx.db)).toEqual({
        redispatched: 0,
        batches: 0,
      });
      expect(sent).toEqual([]);
      expect(await countAbandonedStrandedJobs(ctx.db)).toBe(1);
    });

    it("reclaims a lease a dead worker left open", async () => {
      const { jobIds } = await makeJobs(1, "lease");
      const [jobId] = jobIds;
      if (!jobId) throw new Error("expected a job");
      await markBackgroundJobRunning(ctx.db, jobId);
      await getDb(ctx.db)
        .update(backgroundJob)
        .set({ startedAt: new Date(Date.now() - BACKGROUND_JOB_LEASE_MS * 2) })
        .where(eq(backgroundJob.id, jobId));

      const sent = stubQueue();
      const result = await sweepStrandedBackgroundJobs(ctx.db);

      expect(result.redispatched).toBe(1);
      expect(sent.flat().map((message) => message.body.jobId)).toEqual([jobId]);
    });

    it("cancelling abandoned jobs settles their parent batch", async () => {
      const { batchId, jobIds } = await makeJobs(3, "settle");
      for (const jobId of jobIds) {
        await ageJob(jobId, STRANDED_JOB_MAX_AGE_MS * 2);
      }

      expect(await cancelAbandonedStrandedJobs(ctx.db, 100)).toEqual({
        cancelled: 3,
        batchesSettled: 1,
      });
      expect(await countAbandonedStrandedJobs(ctx.db)).toBe(0);
      // Without the recalculation these rows keep counting as queued and the
      // batch stays open forever, which is how the UI reported live work that
      // no longer existed.
      const summary = await getBackgroundBatchSummary(ctx.db, batchId);
      expect(summary?.status).toBe("cancelled");
      expect(summary?.queuedJobs).toBe(0);
    });
  });
});
