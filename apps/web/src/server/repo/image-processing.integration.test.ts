import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import {
  image,
  imageDerivative,
  imageProcessingOrphan,
  imageProcessingJob,
  productImage,
  searchDocument,
  aiAnalysis,
} from "~/server/db/schema";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";

import { getDb } from "./database-helpers";
import { createUploadedImageRecord, deleteImages, imageList } from "./image";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createTransparentDerivativeAndJob,
  reclaimExpiredImageProcessingLeases,
  loadImageRepresentations,
  getImageProcessingReadProjection,
  saveImageDescriptionAnalysis,
  saveImageDescriptionCorrection,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
} from "./image-processing";
import { updateImageProcessingSettings } from "./image-processing-maintenance";
import { hydrateImageReadProjection } from "./image-read-projection";
import { createProductFixture, makeProductInput } from "./repo.fixtures";

describe("durable image representations", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });
  const hash = "a".repeat(64);
  async function source() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
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
    return { ...row, ...scheduled };
  }

  it("rotates attempt output keys and rejects stale completion without orphaning the current result", async () => {
    const row = await source();
    const first = await claimImageProcessingJob(ctx.db, {
      jobId: row.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!first) throw new Error("Expected first lease");
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      }),
    ).toBeNull();
    await reclaimExpiredImageProcessingLeases(
      ctx.db,
      new Date(Date.now() + 120000),
    );
    // Reclamation's supplied clock sets the next eligible time; return it to now.
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(imageProcessingJob.id, row.jobId));
    const second = await claimImageProcessingJob(ctx.db, {
      jobId: row.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!second) throw new Error("Expected second lease");
    expect(second.derivativeKey).not.toBe(first.derivativeKey);
    const stale = await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: row.jobId,
        attemptId: first.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "subject_lift",
          status: "skipped",
          reason: "no_subject",
        },
      },
    });
    expect(stale).toEqual({ adopted: false, orphanKey: null });
    const result = {
      jobId: row.jobId,
      attemptId: second.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "subject_lift" as const,
        status: "completed" as const,
        sha256: "b".repeat(64),
        width: 10,
        height: 10,
        contentType: "image/png" as const,
      },
    };
    expect(
      (
        await completeImageProcessingJob(ctx.db, {
          result,
          verifiedDerivative: result.outcome,
        })
      ).adopted,
    ).toBe(true);
    expect(
      await completeImageProcessingJob(ctx.db, {
        result,
        verifiedDerivative: result.outcome,
      }),
    ).toEqual({ adopted: false, orphanKey: null });
    const representations = (
      await loadImageRepresentations(ctx.db, [row.shortcode])
    ).get(row.shortcode);
    expect(representations?.preferredKind).toBe("transparent");
    expect(representations?.transparent).toContain(second.derivativeKey);
    const originalUrl = representations!.original;
    const date = new Date();
    const projected = await hydrateImageReadProjection(ctx.db, {
      updatedAt: date,
      related: [
        {
          image: {
            id: row.shortcode,
            url: originalUrl,
            representations: {
              original: originalUrl,
              transparent: null,
              preferred: originalUrl,
              preferredKind: "original" as const,
            },
          },
        },
      ],
    });
    expect(projected.updatedAt).toBe(date);
    expect(projected.related[0]?.image.url).toBe(originalUrl);
    expect(projected.related[0]?.image.representations?.preferred).toBe(
      representations?.transparent,
    );

    await getDb(ctx.db)
      .update(image)
      .set({ useOriginal: true })
      .where(eq(image.id, row.id));
    expect(
      (await loadImageRepresentations(ctx.db, [row.shortcode])).get(
        row.shortcode,
      )?.preferredKind,
    ).toBe("original");
    const orphanRows = await getDb(ctx.db)
      .select()
      .from(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, second.derivativeKey!));
    expect(orphanRows).toHaveLength(0);
  });

  it("does not claim new device work while processing is paused", async () => {
    const row = await source();
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: true,
    });
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      }),
    ).toBeNull();
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, row.jobId));
    expect(job?.state).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("keeps immutable analysis history and confirmed corrections while refreshing image search", async () => {
    const row = await source();
    const imageId = parseEntityId("image", row.id);
    const provider = providerFor(IMAGE_DESCRIPTION_FEATURE.model);
    const inputFingerprint = imageDescriptionInputFingerprint({
      sourceContentHash: hash,
      contentType: "image/jpeg",
      provider,
      model: IMAGE_DESCRIPTION_FEATURE.model,
    });
    const analysis = {
      imageId,
      provider,
      model: IMAGE_DESCRIPTION_FEATURE.model,
      promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
      inputFingerprint,
      result: {
        description: "A dark woven garment",
        claims: [],
        cutoutEligibility: "eligible" as const,
      },
    };
    await saveImageDescriptionAnalysis(ctx.db, analysis);
    await saveImageDescriptionCorrection(ctx.db, {
      imageId,
      description: "Confirmed navy cotton shirt",
    });
    await saveImageDescriptionAnalysis(ctx.db, {
      ...analysis,
      result: {
        ...analysis.result,
        description: "A duplicate result must not overwrite history",
      },
    });
    await saveImageDescriptionAnalysis(ctx.db, {
      ...analysis,
      model: "historical-vision-model",
      inputFingerprint: imageDescriptionInputFingerprint({
        sourceContentHash: hash,
        contentType: "image/jpeg",
        provider,
        model: "historical-vision-model",
      }),
      result: { ...analysis.result, description: "Historical output" },
    });
    const projection = await getImageProcessingReadProjection(ctx.db, imageId);
    expect(projection.analyses).toHaveLength(2);
    expect(
      projection.analyses.find((entry) => entry.preferred)?.result.description,
    ).toBe(analysis.result.description);
    expect(projection.correction?.description).toBe(
      "Confirmed navy cotton shirt",
    );
    expect(projection.status.cutout).toBe("pending");
    const documents = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, imageId));
    expect(documents).toHaveLength(1);
    expect(documents[0]?.body).toContain("Confirmed navy cotton shirt");
    expect(documents[0]?.body).not.toContain(analysis.result.description);
    expect(documents[0]?.body).not.toContain("Historical output");
    // Evaluation history must not evict the current cloud policy from a bounded read.
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values(
        Array.from({ length: 22 }, (_, index) => ({
          entityType: "image" as const,
          entityId: imageId,
          feature: IMAGE_DESCRIPTION_FEATURE.feature,
          provider: "evaluation",
          model: `evaluation-${index}`,
          promptVersion: String(IMAGE_DESCRIPTION_PROMPT_REVISION),
          resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
          inputFingerprint: `evaluation-${index}`,
          result: { ...analysis.result, description: `Evaluation ${index}` },
        })),
      );
    const bounded = await getImageProcessingReadProjection(ctx.db, imageId);
    expect(bounded.analyses.length).toBeLessThanOrEqual(20);
    expect(
      bounded.analyses.find((entry) => entry.preferred)?.result.description,
    ).toBe(analysis.result.description);
  });

  it("retires image search and removes its description from an attached owner on delete", async () => {
    const row = await source();
    const imageId = parseEntityId("image", row.id);
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Search owner" }),
      ctx.actor,
    );
    await getDb(ctx.db).insert(productImage).values({
      productId: owner.entityId,
      imageId,
      sortOrder: 0,
    });
    await saveImageDescriptionCorrection(ctx.db, {
      imageId,
      description: "Confirmed searchable cobalt textile",
    });

    const before = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, owner.entityId));
    expect(before[0]?.body).toContain("Confirmed searchable cobalt textile");

    await deleteImages(ctx.db, [imageId]);

    const ownerDocuments = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, owner.entityId));
    expect(ownerDocuments[0]?.body).not.toContain(
      "Confirmed searchable cobalt textile",
    );
    const imageDocuments = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, imageId));
    expect(imageDocuments[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("retains leased output cleanup after deleting the original and rejects a late result", async () => {
    const row = await source();
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId: row.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!lease?.derivativeKey) throw new Error("Expected output lease");
    const removed = await deleteImages(ctx.db, [
      parseEntityId("image", row.id),
    ]);
    expect(removed.deletedKeys).toContain(lease.derivativeKey);
    const orphans = await getDb(ctx.db)
      .select()
      .from(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, lease.derivativeKey));
    expect(orphans).toHaveLength(1);
    expect(
      await completeImageProcessingJob(ctx.db, {
        result: {
          jobId: row.jobId,
          attemptId: lease.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "subject_lift",
            status: "skipped",
            reason: "no_subject",
          },
        },
      }),
    ).toEqual({ adopted: false, orphanKey: null });
    expect(
      (await loadImageRepresentations(ctx.db, [row.shortcode])).has(
        row.shortcode,
      ),
    ).toBe(false);
  });

  it("commits Apple analysis with completion and can replay after an adoption rollback", async () => {
    const row = await source();
    const imageId = parseEntityId("image", row.id);
    const jobId = await createImageProcessingJob(ctx.db, {
      imageId,
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!jobId) throw new Error("Expected Apple job");
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["describe_image"],
      leaseMs: 60000,
    });
    if (!lease) throw new Error("Expected Apple lease");
    const result = {
      jobId,
      attemptId: lease.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image" as const,
        status: "completed" as const,
        description: {
          description: "An isolated test object",
          claims: [],
          cutoutEligibility: "eligible" as const,
        },
        runtime: { platform: "macos" as const, model: "test-apple" },
      },
    };
    const appleAnalysis = {
      provider: "apple",
      model: "test-apple",
      promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
      inputFingerprint: "apple-test-input",
    };
    // A storage failure after the job update must roll the entire adoption back.
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "AiAnalysis" ADD CONSTRAINT "test_apple_adoption" CHECK (model <> 'test-rejected-apple')`,
    );
    await expect(
      completeImageProcessingJob(ctx.db, {
        result,
        appleAnalysis: { ...appleAnalysis, model: "test-rejected-apple" },
      }),
    ).rejects.toThrow(/check constraint|Failed query/);
    const [pending] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(pending?.state).toBe("leased");
    expect(
      (await completeImageProcessingJob(ctx.db, { result, appleAnalysis }))
        .adopted,
    ).toBe(true);
    expect(
      (await completeImageProcessingJob(ctx.db, { result, appleAnalysis }))
        .adopted,
    ).toBe(false);
    const analyses = await getDb(ctx.db)
      .select()
      .from(aiAnalysis)
      .where(eq(aiAnalysis.entityId, imageId));
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.result).toEqual(result.outcome.description);
  });

  it("keeps no-subject terminal with no transparent URL and makes persisted failures queryable", async () => {
    const row = await source();
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId: row.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!lease) throw new Error("Expected lease");
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: row.jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "subject_lift",
          status: "skipped",
          reason: "no_subject",
        },
      },
    });
    expect(
      (await loadImageRepresentations(ctx.db, [row.shortcode])).get(
        row.shortcode,
      )?.transparent,
    ).toBeNull();
    const failed = await source();
    const failedLease = await claimImageProcessingJob(ctx.db, {
      jobId: failed.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!failedLease?.derivativeKey) throw new Error("Expected output lease");
    await completeImageProcessingJob(ctx.db, {
      orphanOutputKey: failedLease.derivativeKey,
      result: {
        jobId: failed.jobId,
        attemptId: failedLease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "subject_lift",
          status: "failed",
          reason: "Invalid output",
          retryable: false,
        },
      },
    });
    const retired = await getDb(ctx.db)
      .select()
      .from(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, failedLease.derivativeKey));
    expect(retired).toHaveLength(1);
    const problems = await imageList(
      ctx.db,
      { processingIssue: "failed" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(problems.data.map((item) => item.id)).toEqual([failed.shortcode]);
    expect(problems.data[0]?.processingIssue).toBe("failed");
    await expect(
      getDb(ctx.db)
        .update(imageDerivative)
        .set({
          status: "ready",
          contentType: null,
          width: 1,
          height: 1,
          sha256: hash,
        })
        .where(eq(imageDerivative.id, failed.derivativeId)),
    ).rejects.toThrow(/check constraint|Failed query/);
  });
});
