import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  dispatchBackgroundJobs,
  dispatchQueuedBackgroundJobs,
  sweepStrandedBackgroundJobs,
} from "~/server/background-dispatch";
import {
  processBackgroundJob,
  processBackgroundQueueMessage,
} from "~/server/background-queue";
import { BACKGROUND_MESSAGE_VERSION } from "~/server/background-queue-types";
import type { BackgroundQueueProducer } from "~/server/background-queue-types";
import { setCfEnv } from "~/server/cf-env";
import { backgroundJob } from "~/server/db/schema";
import {
  appendBackgroundJobsToWorkflow,
  BACKGROUND_JOB_LEASE_MS,
  cancelAbandonedStrandedJobs,
  countAbandonedStrandedJobs,
  createBackgroundBatchWithJobs,
  failOrRetryBackgroundJob,
  finishBackgroundJob,
  getBackgroundBatchDetail,
  getBackgroundBatchSummary,
  getQueuedBackgroundBatchDispatch,
  listBackgroundBatchJobs,
  markBackgroundJobRunning,
  promotePendingBackgroundWorkflowContinuation,
  STRANDED_JOB_MAX_AGE_MS,
  STRANDED_JOB_MIN_AGE_MS,
  startOrReuseBackgroundWorkflow,
} from "~/server/repo/background-jobs";
import { getDb } from "~/server/repo/database-helpers";
import { createLocation } from "~/server/repo/location";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

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
        messageVersion: BACKGROUND_MESSAGE_VERSION,
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

  it("reads a batch summary without loading jobs", async () => {
    const { batchId } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: "test:summary-only",
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        },
      ],
    });

    const { result, queryCount } = await countTestDbQueries(() =>
      getBackgroundBatchSummary(ctx.db, batchId),
    );

    expect(queryCount).toBe(1);
    expect(result).toMatchObject({ id: batchId, totalJobs: 1 });
    expect(result).not.toHaveProperty("jobs");
  });

  it("reads only queued ids when redispatching a batch", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: Array.from({ length: 3 }, (_, index) => ({
        kind: "entity-embedding.refresh" as const,
        dedupeKey: `test:queued-dispatch:${index}`,
        payload: { entityType: "product", entityId: crypto.randomUUID() },
      })),
    });
    await markBackgroundJobRunning(ctx.db, jobIds[0]!);
    await markBackgroundJobRunning(ctx.db, jobIds[1]!);
    await finishBackgroundJob(ctx.db, jobIds[1]!, "succeeded");

    const dispatch = await getQueuedBackgroundBatchDispatch(ctx.db, batchId);

    expect(dispatch).toEqual({
      kind: "entity-embedding.refresh",
      jobIds: [jobIds[2]!],
    });
  });

  it("holds a workflow continuation pending until its page is terminal", async () => {
    const dedupeKey = `test:workflow-reuse:${crypto.randomUUID()}`;
    const started = await startOrReuseBackgroundWorkflow(ctx.db, {
      kind: "entity-embedding.backfill.coordinator",
      source: "maintenance",
      dedupeKey,
      metadata: { cursor: null },
    });
    const duplicate = await startOrReuseBackgroundWorkflow(ctx.db, {
      kind: "entity-embedding.backfill.coordinator",
      source: "maintenance",
      dedupeKey,
      metadata: { cursor: null },
    });
    expect(duplicate).toMatchObject({ batch: started.batch, reused: true });

    const page = {
      batchId: started.batch.id,
      children: [
        {
          kind: "entity-embedding.refresh" as const,
          dedupeKey: "test:workflow-child",
          payload: { entityType: "product", entityId: crypto.randomUUID() },
        },
      ],
      continuation: {
        kind: "entity-embedding.backfill.coordinator" as const,
        dedupeKey: "test:workflow-next-page",
        payload: {},
      },
      metadata: { cursor: { page: 1 } },
    };
    const { childJobIds, continuationJobId } =
      await appendBackgroundJobsToWorkflow(ctx.db, page);
    const childId = childJobIds[0];
    expect(childId).toBeDefined();
    expect(continuationJobId).toBeDefined();
    await expect(appendBackgroundJobsToWorkflow(ctx.db, page)).resolves.toEqual(
      {
        childJobIds,
        continuationJobId,
      },
    );
    await markBackgroundJobRunning(ctx.db, childId!);

    await expect(
      promotePendingBackgroundWorkflowContinuation(ctx.db, started.batch.id),
    ).resolves.toBeNull();

    await finishBackgroundJob(ctx.db, childId!, "succeeded");
    const promoted = await promotePendingBackgroundWorkflowContinuation(
      ctx.db,
      started.batch.id,
    );

    expect(promoted).toMatchObject({
      kind: "entity-embedding.backfill.coordinator",
    });
    const detail = await getBackgroundBatchDetail(ctx.db, started.batch.id);
    expect(detail?.jobs.find((job) => job.id === promoted?.jobId)?.status).toBe(
      "queued",
    );
    expect(detail?.metadata).toEqual({
      cursor: { page: 1 },
      reused: true,
    });
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
    // SAFETY: this fixture supplies the only Worker binding consumed by this
    // dispatch path; all other Env properties are intentionally absent.
    setCfEnv({ BACKGROUND_QUEUE: queueFor(sent) } as Env);
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

  it("bounds large batch reads to 100 jobs and returns a stable next page", async () => {
    const totalJobs = 8_001;
    const { batchId } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "entity-embedding.refresh",
      source: "backfill",
      jobs: Array.from({ length: totalJobs }, (_, index) => ({
        kind: "entity-embedding.refresh" as const,
        dedupeKey: `test:large-page:${index}`,
        payload: { entityType: "product", entityId: crypto.randomUUID() },
      })),
    });

    const { result: firstPage, queryCount } = await countTestDbQueries(() =>
      listBackgroundBatchJobs(ctx.db, {
        batchId,
        pageIndex: 0,
        pageSize: 100,
        failedOnly: false,
      }),
    );
    const secondPage = await listBackgroundBatchJobs(ctx.db, {
      batchId,
      pageIndex: 1,
      pageSize: 100,
      failedOnly: false,
    });

    expect(queryCount).toBe(2);
    expect(firstPage).toMatchObject({
      totalCount: totalJobs,
      pageIndex: 0,
      pageSize: 100,
    });
    expect(firstPage.jobs).toHaveLength(100);
    expect(secondPage.jobs).toHaveLength(100);
    expect(secondPage.jobs[0]?.id).not.toBe(firstPage.jobs.at(-1)?.id);
    const ordered = [...firstPage.jobs, ...secondPage.jobs].sort((a, b) => {
      const created = a.createdAt.getTime() - b.createdAt.getTime();
      return created === 0 ? a.id.localeCompare(b.id) : created;
    });
    expect([...firstPage.jobs, ...secondPage.jobs]).toEqual(ordered);

    const [summary, previousDetail] = await Promise.all([
      getBackgroundBatchSummary(ctx.db, batchId),
      getBackgroundBatchDetail(ctx.db, batchId),
    ]);
    const boundedPayloadBytes = Buffer.byteLength(
      JSON.stringify({ summary, jobPage: firstPage }),
    );
    const previousPayloadBytes = Buffer.byteLength(
      JSON.stringify(previousDetail),
    );
    expect(boundedPayloadBytes).toBeLessThan(previousPayloadBytes * 0.1);
  });

  it("filters failed jobs before counting and paginating", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "location-ai.description.refresh",
      source: "backfill",
      jobs: Array.from({ length: 3 }, (_, index) => ({
        kind: "location-ai.description.refresh" as const,
        dedupeKey: `test:failed-page:${index}`,
        payload: { locationId: crypto.randomUUID() },
        maxAttempts: 1,
      })),
    });
    for (const jobId of [jobIds[0]!, jobIds[2]!]) {
      await markBackgroundJobRunning(ctx.db, jobId);
      await failOrRetryBackgroundJob(ctx.db, jobId, new Error("failed"));
    }

    const page = await listBackgroundBatchJobs(ctx.db, {
      batchId,
      pageIndex: 0,
      pageSize: 100,
      failedOnly: true,
    });

    expect(page.totalCount).toBe(2);
    expect(page.jobs).toHaveLength(2);
    expect(page.jobs.every((job) => job.status === "failed")).toBe(true);
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

  it("persists a retryable problem-count refresh in the same queue lifecycle", async () => {
    const { batchId, jobIds } = await createBackgroundBatchWithJobs(ctx.db, {
      kind: "problems.counts.refresh",
      source: "mutation",
      jobs: [
        {
          kind: "problems.counts.refresh",
          dedupeKey: `test:problem-counts:${crypto.randomUUID()}`,
          payload: { requestedAt: "2026-08-20T18:00:00.000Z" },
          maxAttempts: 2,
        },
      ],
    });
    const jobId = jobIds[0]!;

    await markBackgroundJobRunning(ctx.db, jobId);
    await expect(
      failOrRetryBackgroundJob(ctx.db, jobId, new Error("KV unavailable")),
    ).resolves.toBe("retry");
    const detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.status).toBe("queued");
    expect(detail?.jobs[0]).toMatchObject({
      kind: "problems.counts.refresh",
      status: "queued",
      attempts: 1,
      lastError: "KV unavailable",
    });
  });

  it("treats location AI refresh with no images as skipped work", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Empty bin" }),
      ctx.actor,
    );
    const locationEntityId = await resolveLiveShortcode(
      ctx.db,
      location.id,
      "location",
    );
    expect(locationEntityId).not.toBeNull();

    const { batchId } = await dispatchBackgroundJobs(ctx.db, {
      kind: "location-ai.inventory.refresh",
      source: "mutation",
      jobs: [
        {
          kind: "location-ai.inventory.refresh",
          dedupeKey: `test:location-ai:inventory:${locationEntityId}`,
          payload: { locationId: locationEntityId! },
        },
      ],
    });

    const detail = await getBackgroundBatchDetail(ctx.db, batchId);
    expect(detail?.status).toBe("succeeded");
    expect(detail?.skippedJobs).toBe(1);
    expect(detail?.failedJobs).toBe(0);
    expect(detail?.jobs[0]?.status).toBe("skipped");
    expect(detail?.jobs[0]?.lastError).toBeNull();
  });

  // A dispatch whose invocation dies mid-sendBatch leaves the durable row at
  // queued/attempts=0 with no wakeup and nothing thrown. These pin the
  // reconciliation that repairs it, and the age split that stops it from
  // re-driving an old backlog nobody wants paid for.
  describe("stranded job reconciliation", () => {
    const stubQueue = () => {
      const sent: QueueMessage[][] = [];
      // SAFETY: this fixture supplies the only Worker binding consumed by this
      // dispatch path; all other Env properties are intentionally absent.
      setCfEnv({ BACKGROUND_QUEUE: queueFor(sent) } as Env);
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
