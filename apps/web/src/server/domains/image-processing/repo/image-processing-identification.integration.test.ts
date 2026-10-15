import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  imageIdentificationResult,
} from "@cubby/schemas/image-identification";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiAnalysis,
  image,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";
import { dispatchImageProcessingWakeup } from "~/server/domains/image-processing/dispatch";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { getVerifiedImageRenditionKey } from "~/server/domains/image/repo/image-identification";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  markImageProcessingWaitingForDevice,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";
import { updateImageProcessingSettings } from "./image-processing-maintenance";
import { persistImageProcessingSubmission } from "./image-processing-submission";

// Device absence, unavailable descriptions, stale sources/leases, and failed
// analysis insertion must not block Clef or adopt unaccepted observations.
describe("independent durable image identification", () => {
  const ctx = withTestDb();
  const hash = "a".repeat(64);
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });

  async function setup() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "sample.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    await persistImageProcessingSubmission(ctx.db, {
      id: row.shortcode,
      kinds: ["describe_image", "identify_image"],
    });
    const jobs = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, parseEntityId("image", row.id)));
    const identification = jobs.find((job) => job.kind === "identify_image");
    const apple = jobs.find(
      (job) =>
        job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    );
    const cloud = jobs.find(
      (job) => job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    );
    if (!identification || !apple || !cloud)
      throw new Error("Missing independent baseline jobs");
    return { row, identification, apple, cloud };
  }

  async function lease(jobId: string) {
    const claimed = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["identify_image"],
      leaseMs: 60_000,
    });
    if (!claimed) throw new Error("Missing identification lease");
    await assignImageProcessingExecutor(ctx.db, {
      jobId,
      attemptId: claimed.attemptId,
      executor: {
        kind: "cloud",
        deviceId: null,
        name: "cloudflare",
        platform: "cloud",
        appVersion: null,
        osVersion: null,
      },
    });
    return claimed;
  }

  function completion(jobId: string, attemptId: string) {
    return {
      result: {
        jobId,
        attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "identify_image" as const,
          status: "completed" as const,
          identification: imageIdentificationResult.parse({
            subject: "single_object",
            category: null,
            outcome: "no_candidates",
            candidates: [],
            considered: 0,
            truncated: false,
          }),
        },
      },
      identificationAnalysis: {
        provider: "cloudflare",
        model: IMAGE_IDENTIFICATION_MODEL,
        promptRevision: IMAGE_IDENTIFICATION_PROMPT_REVISION,
        resultSchemaRevision: IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
        inputFingerprint: JSON.stringify({ sourceContentHash: hash }),
      },
      runtime: {
        provider: "cloudflare",
        model: IMAGE_IDENTIFICATION_MODEL,
        feature: "image-identification",
      },
    };
  }

  it("claims Clef without descriptions while repeated Apple waiting consumes no attempts", async () => {
    const { identification, apple, cloud } = await setup();
    expect(identification.processorRevision).toBe(
      IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
    );
    for (let index = 0; index < 2; index++) {
      const claimed = await claimImageProcessingJob(ctx.db, {
        jobId: apple.id,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      });
      if (!claimed) throw new Error("Missing Apple lease");
      await markImageProcessingWaitingForDevice(ctx.db, {
        jobId: apple.id,
        attemptId: claimed.attemptId,
      });
      await getDb(ctx.db)
        .update(imageProcessingJob)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(imageProcessingJob.id, apple.id));
    }
    const claimed = await lease(identification.id);
    expect(
      (
        await completeImageProcessingJob(
          ctx.db,
          completion(identification.id, claimed.attemptId),
        )
      ).adopted,
    ).toBe(true);
    const rows = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.imageId, identification.imageId),
          eq(imageProcessingJob.kind, "describe_image"),
        ),
      );
    expect(rows.find((job) => job.id === apple.id)).toMatchObject({
      state: "waiting_for_device",
      attempts: 0,
    });
    expect(rows.find((job) => job.id === cloud.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
  });

  it("waits for verified AVIF normalization without spending attempts or fetching unsupported bytes", async () => {
    const { row, identification } = await setup();
    await getDb(ctx.db)
      .update(image)
      .set({ contentType: "image/avif" })
      .where(eq(image.id, row.id));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unsupported AVIF fetch must not run"));
    try {
      expect(
        await dispatchImageProcessingWakeup(ctx.db, identification.id),
      ).toBe("waiting");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, identification.id));
    expect(job).toMatchObject({ state: "waiting_for_device", attempts: 0 });
  });

  it("reuses only a verified snapshot for the current source, never staging or old source bytes", async () => {
    const { row, cloud } = await setup();
    const imageId = parseEntityId("image", row.id);
    const inputKey = `tests/${crypto.randomUUID()}.jpg`;
    const [attempt] = await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values({
        id: crypto.randomUUID(),
        jobId: cloud.id,
        number: 1,
        state: "ready",
        inputKey,
        diagnostics: {
          sourceHash: hash,
          normalizationRevision: 1,
          renditionKey: "staging-key",
          renditionHash: "b".repeat(64),
        },
      })
      .returning();
    expect(await getVerifiedImageRenditionKey(ctx.db, imageId)).toBeNull();
    await getDb(ctx.db)
      .update(imageProcessingAttempt)
      .set({
        diagnostics: {
          sourceHash: hash,
          normalizationRevision: 1,
          renditionKey: inputKey,
          renditionHash: "b".repeat(64),
        },
      })
      .where(eq(imageProcessingAttempt.id, attempt!.id));
    expect(await getVerifiedImageRenditionKey(ctx.db, imageId)).toBe(inputKey);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "c".repeat(64) })
      .where(eq(image.id, imageId));
    expect(await getVerifiedImageRenditionKey(ctx.db, imageId)).toBeNull();
  });

  it("rolls back failed analysis persistence and retains existing observations after replay", async () => {
    const { row, identification } = await setup();
    const imageId = parseEntityId("image", row.id);
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values({
        entityKind: "image",
        entityId: imageId,
        feature: "image-description",
        provider: "apple",
        model: "synthetic-apple",
        promptVersion: "1",
        resultSchemaRevision: 1,
        inputFingerprint: "existing-observation",
        result: {
          description: "Synthetic retained observation",
          claims: [],
          cutoutEligibility: "review",
        },
      });
    const claimed = await lease(identification.id);
    const input = completion(identification.id, claimed.attemptId);
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "AiAnalysis" ADD CONSTRAINT test_identification_adoption CHECK (feature <> 'image-identification')`,
    );
    await expect(completeImageProcessingJob(ctx.db, input)).rejects.toThrow(
      /check constraint|Failed query/,
    );
    const [unadopted] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, identification.id));
    expect(unadopted).toMatchObject({
      state: "leased",
      attemptId: claimed.attemptId,
    });
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "AiAnalysis" DROP CONSTRAINT test_identification_adoption`,
    );
    expect((await completeImageProcessingJob(ctx.db, input)).adopted).toBe(
      true,
    );
    expect((await completeImageProcessingJob(ctx.db, input)).adopted).toBe(
      false,
    );
    const analyses = await getDb(ctx.db)
      .select()
      .from(aiAnalysis)
      .where(eq(aiAnalysis.entityId, imageId));
    expect(analyses).toHaveLength(2);
    expect(
      analyses.find((analysis) => analysis.feature === "image-description")
        ?.inputFingerprint,
    ).toBe("existing-observation");
    expect(
      analyses.find((analysis) => analysis.feature === "image-identification"),
    ).toMatchObject({
      result: input.result.outcome.identification,
      runtime: input.runtime,
    });
  });

  it.each(["source", "lease", "revision", "upload-status"] as const)(
    "rejects a stale %s without storing an observation",
    async (stale) => {
      const { row, identification } = await setup();
      const claimed = await lease(identification.id);
      if (stale === "upload-status")
        await getDb(ctx.db)
          .update(image)
          .set({ status: "FAILED" })
          .where(eq(image.id, row.id));
      if (stale === "source")
        await getDb(ctx.db)
          .update(image)
          .set({ sha256: "b".repeat(64) })
          .where(eq(image.id, row.id));
      if (stale === "lease")
        await getDb(ctx.db)
          .update(imageProcessingJob)
          .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
          .where(eq(imageProcessingJob.id, identification.id));
      if (stale === "revision")
        await getDb(ctx.db)
          .update(imageProcessingJob)
          .set({
            processorRevision: IMAGE_IDENTIFICATION_PROCESSOR_REVISION + 1,
          })
          .where(eq(imageProcessingJob.id, identification.id));
      expect(
        (
          await completeImageProcessingJob(
            ctx.db,
            completion(identification.id, claimed.attemptId),
          )
        ).adopted,
      ).toBe(false);
      expect(
        await getDb(ctx.db)
          .select()
          .from(aiAnalysis)
          .where(eq(aiAnalysis.entityId, row.id)),
      ).toHaveLength(0);
    },
  );
});
