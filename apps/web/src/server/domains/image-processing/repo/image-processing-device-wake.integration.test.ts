import { parseEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { job as durableJob } from "~/server/db/retained-tables";
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
  beforeEach(() => {
    rings = 0;
    setCfEnv(
      fromPartial<Env>({
        IMAGE_PROCESSING: {
          getByName: () => ({
            ring: async () => {
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
