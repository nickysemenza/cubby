import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { image, imageProcessingJob } from "~/server/db/schema";
import {
  createImageProcessingJob,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
} from "~/server/domains/image-processing/repo/image-processing";
import { updateImageProcessingSettings } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/service/ensure-run";
import type { BackgroundQueueProducer } from "~/server/workflows/background-queue-types";
import { handleBackgroundQueueBatch } from "~/server/workflows/background-tasks/consume";
import {
  handleBackgroundTask,
  productionBackgroundTaskPorts,
} from "~/server/workflows/background-tasks/handle";

import { handleCloudImageTask } from "./cloud-queue";

const ctx = withTestDb();
let batchRunId: RunId;
beforeEach(async () => {
  await updateImageProcessingSettings(ctx.db, {
    enabled: false,
    paused: false,
  });
  // withTestDb has a test actor, not the production system user. Every photo
  // inherits this one batch Run rather than opening an unattributed system Run.
  batchRunId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
});
afterEach(() => setCfEnv());

async function source() {
  const row = await createUploadedImageRecord(ctx.db, {
    key: `tests/${crypto.randomUUID()}.jpg`,
    filename: "synthetic-object.jpg",
    contentType: "image/jpeg",
    size: 512,
  });
  const hash = "a".repeat(64);
  await getDb(ctx.db)
    .update(image)
    .set({ sha256: hash })
    .where(eq(image.id, row.id));
  const jobId = await createImageProcessingJob(ctx.db, {
    imageId: parseEntityId("image", row.id),
    kind: "describe_image",
    sourceContentHash: hash,
    processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    runId: batchRunId,
  });
  if (!jobId) throw new Error("Expected synthetic image job");
  return { imageId: row.id, jobId };
}

const message = (jobId: string) => ({
  body: {
    version: 2 as const,
    queueType: "background" as const,
    task: {
      kind: "image-processing.wakeup" as const,
      jobId,
      requestedAt: "2026-10-01T00:00:00.000Z",
    },
  },
  ack() {},
  retry() {
    throw new Error("Unexpected queue retry");
  },
  timestamp: new Date(),
});

// Failure modes: cloud calls occupy both shared consumer slots; a handoff
// failure is acknowledged; waiting starts a lease; duplicate/replaced-source
// deliveries pay for another execution or adopt an obsolete result.
it("hands off 25 photos before claim and completes independent background work while four cloud calls wait", async () => {
  const queued: ReturnType<typeof message>["body"][] = [];
  const acceptedAt = new Map<string, Date>();
  setCfEnv(
    fromPartial<Env>({
      IMAGE_CLOUD_QUEUE: {
        async sendBatch(
          batch: Parameters<BackgroundQueueProducer["sendBatch"]>[0],
        ) {
          for (const item of batch) {
            const parsed = backgroundTaskMessageSchema.parse(item.body);
            if (parsed.task.kind !== "image-processing.wakeup")
              throw new Error("Expected image wakeup");
            acceptedAt.set(parsed.task.jobId, new Date());
            queued.push({
              version: 2,
              queueType: "background",
              task: parsed.task,
            });
          }
        },
      },
    }),
  );
  const rows: Awaited<ReturnType<typeof source>>[] = [];
  for (let index = 0; index < 25; index++) rows.push(await source());
  for (const row of rows)
    await handleBackgroundQueueBatch(
      ctx.db,
      {
        queue: "cubby-background",
        messages: [message(row.jobId)],
      },
      {
        captureException(error) {
          throw error;
        },
      },
    );
  expect(queued).toHaveLength(25);
  const pending = await getDb(ctx.db).select().from(imageProcessingJob);
  expect(queued[0]!.task.requestedAt).toBe(
    pending.find((job) => job.id === rows[0]!.jobId)!.createdAt.toISOString(),
  );
  expect(
    pending.filter((row) => rows.some((source) => source.jobId === row.id)),
  ).toEqual(
    expect.arrayContaining(
      rows.map((row) =>
        expect.objectContaining({
          id: row.jobId,
          state: "pending",
          attemptId: null,
          attempts: 0,
          runId: batchRunId,
        }),
      ),
    ),
  );

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maximum = 0;
  let starts = 0;
  let ready!: () => void;
  const fourStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const describe = async () => {
    const invocation = ++starts;
    active++;
    maximum = Math.max(maximum, active);
    if (active === 4) ready();
    await held;
    // A deterministic external latency seam; database and queue paths stay real.
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return {
      cached: false,
      result: {
        description: "A synthetic woven object",
        claims: [],
        cutoutEligibility: "eligible" as const,
      },
      fingerprint: `synthetic:${invocation}`,
    };
  };
  const consume = (body: ReturnType<typeof message>["body"]) =>
    handleBackgroundQueueBatch(
      ctx.db,
      {
        queue: "cubby-image-cloud",
        messages: [
          {
            ...message(body.task.jobId),
            body,
            timestamp: acceptedAt.get(body.task.jobId),
          },
        ],
      },
      {
        captureException(error) {
          throw error;
        },
        handleTask: (db, task) => handleCloudImageTask(db, task, { describe }),
      },
    );
  const firstWave = Promise.all(queued.slice(0, 4).map(consume));
  let startupComplete = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const stoppedBeforeProvider = async () => {
    const jobs = await getDb(ctx.db)
      .select({
        state: imageProcessingJob.state,
        error: imageProcessingJob.lastError,
      })
      .from(imageProcessingJob);
    throw new Error(
      `Expected four held cloud calls; provider starts=${starts}; job diagnostics=${JSON.stringify(jobs)}`,
    );
  };
  try {
    await Promise.race([
      fourStarted,
      firstWave.then(() =>
        startupComplete ? undefined : stoppedBeforeProvider(),
      ),
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => {
          stoppedBeforeProvider().catch(reject);
        }, 3_000);
      }),
    ]);
    startupComplete = true;
  } catch (error) {
    release();
    await Promise.allSettled([firstWave]);
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  let dirty = false;
  expect(
    await handleBackgroundTask(
      ctx.db,
      {
        kind: "calendar-feed.mark-dirty",
        requestedAt: "2026-10-01T00:00:00.000Z",
        origin: "https://cubby.example",
        reason: "api.product.update",
      },
      {
        ...productionBackgroundTaskPorts,
        async markCalendarFeedDirty() {
          dirty = true;
        },
      },
    ),
  ).toBe("succeeded");
  expect(dirty).toBe(true);
  expect(active).toBe(4);
  // Redelivery while leased is a no-op before the provider seam.
  await consume(queued[0]!);
  expect(starts).toBe(4);
  release();
  const batchStarted = performance.now();
  await firstWave;
  for (let index = 4; index < queued.length; index += 4)
    await Promise.all(queued.slice(index, index + 4).map(consume));
  expect(starts).toBe(25);
  expect(maximum).toBe(4);
  console.info(
    `synthetic_photo_batch photos=25 peak_cloud_calls=${maximum} execution_ms=${Math.round(performance.now() - batchStarted)}`,
  );
  const finished = await getDb(ctx.db).select().from(imageProcessingJob);
  const batchJobs = finished.filter((job) =>
    rows.some((row) => row.jobId === job.id),
  );
  expect(batchJobs).toHaveLength(25);
  expect(batchJobs).toEqual(
    expect.arrayContaining(
      rows.map((row) =>
        expect.objectContaining({
          id: row.jobId,
          state: "ready",
          attemptId: null,
          leaseExpiresAt: null,
          lastError: null,
          completedAt: expect.any(Date),
          attempts: 1,
        }),
      ),
    ),
  );
  await consume(queued[0]!);
  expect(starts).toBe(25);
  expect(queued).toHaveLength(25);
});

it("retries rejected cloud publication without claiming and ignores a replaced source before model work", async () => {
  const row = await source();
  setCfEnv(
    fromPartial<Env>({
      IMAGE_CLOUD_QUEUE: {
        async sendBatch() {
          throw new Error("Synthetic queue unavailable");
        },
      },
    }),
  );
  await expect(
    handleBackgroundTask(ctx.db, message(row.jobId).body.task),
  ).rejects.toThrow("Synthetic queue unavailable");
  const pending = await getDb(ctx.db).query.imageProcessingJob.findFirst({
    where: eq(imageProcessingJob.id, row.jobId),
  });
  expect(pending).toMatchObject({
    state: "pending",
    attemptId: null,
    attempts: 0,
  });
  await getDb(ctx.db)
    .update(image)
    .set({ sha256: "b".repeat(64) })
    .where(eq(image.id, row.imageId));
  expect(
    await handleCloudImageTask(ctx.db, message(row.jobId).body.task, {
      async describe() {
        throw new Error("Obsolete source reached provider");
      },
    }),
  ).toBe("skipped");
});
