import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { prepareCompanionImageCommand } from "~/server/domains/image-processing/service/dispatch";
import { updateImageProcessingSettings } from "~/server/domains/image-processing/service/image-processing-maintenance";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

import {
  claimImageProcessingJob,
  createImageProcessingJob,
  createTransparentDerivativeAndJob,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
} from "./image-processing";

// Subject lift must reach Apple even without a cloud description or when cloud eligibility is
// uncertain/negative. Apple, rather than a cloud classifier, decides whether a subject exists.
describe("independent Apple subject lift", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });
  it.each([null, "review", "ineligible"] as const)(
    "prepares a subject-lift command when cloud eligibility is %s",
    async (eligibility) => {
      const record = await createUploadedImageRecord(ctx.db, {
        key: `tests/${crypto.randomUUID()}.jpg`,
        filename: "synthetic-object.jpg",
        contentType: "image/jpeg",
        size: 512,
      });
      const imageId = parseEntityId("image", record.id);
      const sourceContentHash = "d".repeat(64);
      await getDb(ctx.db)
        .update(image)
        .set({ sha256: sourceContentHash })
        .where(eq(image.id, record.id));
      const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
        imageId,
        sourceContentHash,
        key: `pending/${crypto.randomUUID()}.png`,
      });
      if (!scheduled) throw new Error("Expected persisted subject-lift job");
      if (eligibility) {
        const description = await createImageProcessingJob(ctx.db, {
          imageId,
          sourceContentHash,
          kind: "describe_image",
          processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
        });
        if (!description) throw new Error("Expected description job");
        await getDb(ctx.db)
          .update(imageProcessingJob)
          .set({
            state: "ready",
            result: {
              kind: "describe_image",
              status: "completed",
              description: {
                description: "Synthetic object photo",
                cutoutEligibility: eligibility,
                claims: [],
              },
            },
          })
          .where(eq(imageProcessingJob.id, description));
      }
      const claimed = await claimImageProcessingJob(ctx.db, {
        jobId: scheduled.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60_000,
      });
      if (!claimed) throw new Error("Expected subject-lift lease");
      expect(await prepareCompanionImageCommand(ctx.db, claimed)).toMatchObject(
        {
          kind: "subject_lift",
          jobId: scheduled.jobId,
        },
      );
    },
  );
});
