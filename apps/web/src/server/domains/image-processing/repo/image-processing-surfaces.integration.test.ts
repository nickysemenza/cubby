import {
  type ImageJobId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { device, image, imageProcessingJob } from "~/server/db/schema";
import { readDeviceById } from "~/server/domains/device/repo/device";
import { upsertDeviceFromHello } from "~/server/domains/device/repo/device-participation";
import { imageJobRepository } from "~/server/domains/image-job/repo";
import { updateImageExecution } from "~/server/domains/image-processing/repo/image-execution.fixtures";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";

import {
  claimImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";

// Leased image rows whose lease expired rendered as healthy "Processing";
// device rows did not say whether an install could take image work.
describe("image work on every surface", () => {
  const ctx = withTestDb();
  const installationId = crypto.randomUUID();

  async function deviceJob() {
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
    return created;
  }

  async function leaseToDevice() {
    const id = await deviceJob();
    const lease = await claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION],
      deviceId: installationId,
    });
    if (lease?.id !== id) throw new Error("Expected the device lease");
    await assignImageProcessingExecutor(ctx.db, {
      jobId: lease.id,
      attemptId: lease.attemptId,
      userId: "synthetic-surface-user",
      executor: {
        kind: "device",
        deviceId: installationId,
        name: "Fixture iPad",
        platform: "ios",
        appVersion: "9.0.0",
        osVersion: "26",
      },
    });
    return id;
  }

  const readImageJob = async (id: ImageJobId) => {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: imageProcessingJob.shortcode })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, id));
    return imageJobRepository.repository.get(
      kernelCtx(ctx),
      parseShortcodeFor("imageJob", row!.shortcode),
    );
  };

  it("names the leasing device and flags its lease once expired", async () => {
    await upsertDeviceFromHello(ctx.db, {
      installationId,
      name: "Fixture iPad",
      platform: "ios",
      appVersion: "9.0.0",
      osVersion: "26",
      automaticWork: true,
      appleIntelligenceAvailable: true,
    });
    const id = await leaseToDevice();
    const [saved] = await getDb(ctx.db)
      .select({ id: device.id })
      .from(device)
      .where(eq(device.installationId, installationId));

    expect(await readDeviceById(ctx.db, saved!.id)).toMatchObject({
      updateRequired: false,
      inactive: false,
      appleIntelligenceAvailable: true,
    });
    expect(await readImageJob(id)).toMatchObject({
      state: "leased",
      waitingOn: "In progress on Fixture iPad",
    });

    await updateImageExecution(ctx.db, id, {
      leaseUntil: new Date(Date.now() - 1_000),
    });

    const stale = await readImageJob(id);
    expect(stale?.state).not.toBe("leased");
    expect(stale?.waitingOn).toBe(
      "Lease on Fixture iPad expired; waiting to be reclaimed",
    );
  });

  it("derives update required and inactivity from the device row", async () => {
    const outdated = crypto.randomUUID();
    await upsertDeviceFromHello(ctx.db, {
      installationId: outdated,
      name: "Fixture old Mac",
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: null,
      automaticWork: true,
    });
    await getDb(ctx.db)
      .update(device)
      .set({ lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where(eq(device.installationId, outdated));
    const [saved] = await getDb(ctx.db)
      .select({ id: device.id })
      .from(device)
      .where(eq(device.installationId, outdated));

    expect(await readDeviceById(ctx.db, saved!.id)).toMatchObject({
      updateRequired: true,
      inactive: true,
      // A hello that never reported capabilities leaves it unknown.
      appleIntelligenceAvailable: null,
    });
  });
});
