import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import {
  createBackgroundBatchWithJobs,
  failOrRetryBackgroundJob,
  finishBackgroundJob,
  getBackgroundBatchDetail,
  getBackgroundBatchSummary,
  listBackgroundBatchJobs,
  markBackgroundJobRunning,
} from "~/server/repo/background-jobs";
import { createLocation } from "~/server/repo/location";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

describe("background job persistence", () => {
  const ctx = withTestDb();

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
});
