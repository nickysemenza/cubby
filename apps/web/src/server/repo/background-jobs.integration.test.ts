import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import {
  createBackgroundBatchWithJobs,
  failOrRetryBackgroundJob,
  finishBackgroundJob,
  getBackgroundBatchDetail,
  markBackgroundJobRunning,
} from "~/server/repo/background-jobs";
import { createLocation } from "~/server/repo/location";
import { makeLocationInput } from "~/server/repo/repo.fixtures";

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

  it("treats location AI refresh with no images as skipped work", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Empty bin" }),
      ctx.actor,
    );

    const { batchId } = await dispatchBackgroundJobs(ctx.db, {
      kind: "location-ai.inventory.refresh",
      source: "mutation",
      jobs: [
        {
          kind: "location-ai.inventory.refresh",
          dedupeKey: `test:location-ai:inventory:${location.id}`,
          payload: { locationId: location.id },
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
