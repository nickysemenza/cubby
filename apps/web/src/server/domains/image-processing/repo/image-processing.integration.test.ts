import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
  IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  imageProcessingJobState,
} from "@cubby/schemas/image-processing";
import { JOB_NEEDS_ATTENTION_ATTEMPTS } from "@cubby/schemas/job";
import { providerFor } from "@cubby/shared/ai/models";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseChanges } from "~/lib/doorbell";
import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/policy/features";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  appSettings,
  aiAnalysis,
  image,
  imageDerivative,
  imageProcessingAttempt,
  imageProcessingJob,
  imageProcessingOrphan,
  searchDocument,
} from "~/server/db/schema";
import { imageDescriptionInputFingerprint } from "~/server/domains/image-processing/repo/description-policy";
import {
  createUploadedImageRecord,
  deleteImages,
  imageScaffold,
} from "~/server/domains/image/repo/image";
import {
  loadImageAnalysisEvidence,
  loadImageAnalysisSummaries,
} from "~/server/domains/image/repo/image-analysis-summary";
import { loadSelectedDescriptionEvidence } from "~/server/domains/image/repo/image-description-selection";
import { hydrateImageReadProjection } from "~/server/domains/image/repo/image-read-projection";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";

import { imageProcessingJobHandler } from "../service/dispatch";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createTransparentDerivativeAndJob,
  loadImageRepresentations,
  getImageProcessingReadProjection,
  saveImageDescriptionAnalysis,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  retireObsoleteImageProcessingJobs,
  repairImageProcessingExecution,
  retryImageProcessingNow,
} from "./image-processing";
import { loadImageProcessingIssues } from "./image-processing-issues";
import { persistImageProcessingSubmission } from "./image-processing-submission";

describe("durable image representations", () => {
  const ctx = withTestDb();
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

  // Concurrent schedulers must converge on the one job per natural key; its
  // shortcode is minted once, never swallowed as a duplicate of the key.
  it("schedules the same image job concurrently as one row with one shortcode", async () => {
    const row = await source();
    const identity = {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image" as const,
      sourceContentHash: hash,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    };
    const ids = await Promise.all(
      Array.from({ length: 4 }, () =>
        createImageProcessingJob(ctx.db, identity),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await getDb(ctx.db)
      .select({ shortcode: imageProcessingJob.shortcode })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, identity.imageId));
    const descriptions = rows.filter((job) => job.shortcode.startsWith("IPR-"));
    expect(descriptions.length).toBe(2); // the subject lift from source() and this description
    expect(new Set(descriptions.map((job) => job.shortcode)).size).toBe(2);
  });

  // Retiring a source must settle its old intent without producing a remote
  // capability or leaving the processing payload permanently pending.
  it("settles an obsolete image source as skipped under its Job fence", async () => {
    const row = await source();
    const cloudJobId = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!cloudJobId) throw new Error("Missing cloud job");
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, row.id));
    const execution = async (jobId: ImageJobId) =>
      (await readJobs(ctx.db, { key: `image-processing:${jobId}` }))[0]!;
    const payload = async (jobId: ImageJobId) =>
      (
        await getDb(ctx.db)
          .select()
          .from(imageProcessingJob)
          .where(eq(imageProcessingJob.id, jobId))
      )[0]!;
    // Cloud work is settled by its own drain claim.
    await advanceJob(ctx.db, (await execution(cloudJobId)).id, {
      "image.cloud": imageProcessingJobHandler,
    });
    expect((await payload(cloudJobId)).state).toBe("skipped");
    expect((await execution(cloudJobId)).state).toBe("completed");
    // Parked device work no device would claim is settled by the watchdog.
    expect(await retireObsoleteImageProcessingJobs(ctx.db, { limit: 10 })).toBe(
      1,
    );
    expect(await payload(row.jobId)).toMatchObject({
      state: "skipped",
      attemptId: null,
    });
    expect((await execution(row.jobId)).state).toBe("completed");
  });

  // Regression: a GIF's device command failed validation on every pull
  // (HTTP 500), so its parked device work could never settle.
  it("settles device work on a type no device command carries, and keeps its cloud work", async () => {
    const row = await source();
    const cloudJobId = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!cloudJobId) throw new Error("Missing cloud job");
    await getDb(ctx.db)
      .update(image)
      .set({ contentType: "image/gif" })
      .where(eq(image.id, row.id));
    expect(await retireObsoleteImageProcessingJobs(ctx.db, { limit: 10 })).toBe(
      1,
    );
    const states = await getDb(ctx.db)
      .select({ id: imageProcessingJob.id, state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(inArray(imageProcessingJob.id, [row.jobId, cloudJobId]));
    expect(
      Object.fromEntries(states.map((entry) => [entry.id, entry.state])),
    ).toEqual({
      [row.jobId]: "skipped",
      [cloudJobId]: "pending",
    });
  });

  it("does not keep a completed cutout in eligibility review because an earlier device description requested review", async () => {
    const row = await source();
    const jobId = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!jobId) throw new Error("Expected description job");
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({
        state: "ready",
        result: { description: { cutoutEligibility: "review" } },
      })
      .where(eq(imageProcessingJob.id, jobId));
    expect(
      (await loadImageProcessingIssues(ctx.db, [row.shortcode])).get(
        row.shortcode,
      ),
    ).toBe("review_needed");
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId: row.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60000,
    });
    if (!lease) throw new Error("Expected cutout lease");
    const outcome = {
      kind: "subject_lift" as const,
      status: "completed" as const,
      sha256: "b".repeat(64),
      width: 10,
      height: 10,
      contentType: "image/png" as const,
    };
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: row.jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome,
      },
      verifiedDerivative: outcome,
    });
    expect(
      (await loadImageProcessingIssues(ctx.db, [row.shortcode])).get(
        row.shortcode,
      ),
    ).toBeNull();
  });

  // Image selection and its shared Job claim must agree about due time even
  // when the application and PostgreSQL clocks differ.
  it("claims freshly due image work using the same clock as its Job", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 30_000));
    try {
      const row = await source();
      const messages: DatabaseChanges[] = [];
      setCfEnv(
        fromPartial<Env>({
          DB_FRESHNESS: {
            getByName: () => ({
              publishChanges: async (changes: DatabaseChanges) => {
                messages.push(changes);
              },
            }),
          },
        }),
      );
      const claimed = await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60_000,
      });
      expect(claimed).toMatchObject({ id: row.jobId, kind: "subject_lift" });
      const [jobIdentity] = await getDb(ctx.db)
        .select({ shortcode: imageProcessingJob.shortcode })
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, row.jobId));
      expect(messages).toContainEqual({
        imageJob: [jobIdentity?.shortcode],
        image: [row.shortcode],
      });
    } finally {
      setCfEnv(undefined);
      vi.useRealTimers();
    }
  });

  it.each(["expired", "cutover"])(
    "rotates %s attempt output keys and rejects stale completion without orphaning the current result",
    async (transition) => {
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
      await updateJobs(
        ctx.db,
        { key: `image-processing:${row.jobId}` },
        transition === "expired"
          ? { leaseExpiresAt: new Date(0) }
          : {
              state: "queued",
              leaseToken: null,
              leaseExpiresAt: null,
              attempts: 0,
              availableAt: new Date(0),
            },
      );
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(imageProcessingJob)
            .where(eq(imageProcessingJob.id, row.jobId))
        )[0],
      ).toMatchObject({ state: "pending", attemptId: first.attemptId });
      const second = await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      });
      if (!second) throw new Error("Expected second lease");
      expect(second.attemptId).not.toBe(first.attemptId);
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
    },
  );

  it("claims device work even with legacy disabled and paused settings", async () => {
    const row = await source();
    await getDb(ctx.db)
      .insert(appSettings)
      .values({
        id: "00000000-0000-4000-8000-000000000071",
        metadata: { enabled: false, paused: true },
      });
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      }),
    ).not.toBeNull();
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, row.jobId));
    expect(job?.state).toBe("pending");
    expect(job?.attemptId).toEqual(expect.any(String));
  });

  it("retains a successful earlier cutout when the new policy job fails", async () => {
    const row = await source();
    await getDb(ctx.db)
      .update(imageDerivative)
      .set({
        processorRevision: 1,
        status: "ready",
        key: "synthetic/retained-cutout.png",
        sha256: "e".repeat(64),
        width: 10,
        height: 10,
        contentType: "image/png",
      })
      .where(eq(imageDerivative.id, row.derivativeId));
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "failed", lastError: "Synthetic retry failure" })
      .where(eq(imageProcessingJob.id, row.jobId));
    expect(
      (await loadImageRepresentations(ctx.db, [row.shortcode])).get(
        row.shortcode,
      )?.transparent,
    ).toContain("synthetic/retained-cutout.png");
    expect(
      (
        await getImageProcessingReadProjection(
          ctx.db,
          parseEntityId("image", row.id),
        )
      ).status.cutout,
    ).toBe("ready");
  });

  it("attempts subject lift for label-only and shared item images", async () => {
    const labelOnly = await source();
    const labelOwner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Label-only image owner" }),
      ctx.actor,
    );
    await insertEntityAttachments(ctx.db, {
      entityId: labelOwner.entityId,
      imageId: parseEntityId("image", labelOnly.id),
      sortOrder: 0,
      purpose: "label",
    });

    expect(
      (
        await persistImageProcessingSubmission(ctx.db, {
          id: labelOnly.shortcode,
          kinds: ["subject_lift"],
        })
      ).jobIds,
    ).toContain(labelOnly.jobId);
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: labelOnly.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      }),
    ).toMatchObject({ id: labelOnly.jobId, kind: "subject_lift" });
    const shared = await source();
    const itemOwner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Item image owner" }),
      ctx.actor,
    );
    await insertEntityAttachments(ctx.db, [
      {
        entityId: labelOwner.entityId,
        imageId: parseEntityId("image", shared.id),
        sortOrder: 1,
        purpose: "label",
      },
      {
        entityId: itemOwner.entityId,
        imageId: parseEntityId("image", shared.id),
        sortOrder: 0,
        purpose: "item",
      },
    ]);
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: shared.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60000,
      }),
    ).toMatchObject({ id: shared.jobId, kind: "subject_lift" });
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
      promptRevision: IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
      inputFingerprint,
      result: {
        description: "A dark woven garment",
        claims: [
          { text: "Dark woven fabric", evidenceKind: "visual" as const },
        ],
        cutoutEligibility: "eligible" as const,
      },
    };
    await saveImageDescriptionAnalysis(ctx.db, analysis);
    await saveImageDescriptionAnalysis(ctx.db, {
      ...analysis,
      provider: "apple",
      model: "SystemLanguageModel.default",
      inputFingerprint: imageDescriptionInputFingerprint({
        sourceContentHash: hash,
        contentType: "image/jpeg",
        provider: "apple",
        model: "SystemLanguageModel.default",
      }),
      result: { ...analysis.result, description: "Short device description" },
    });
    expect(
      (await loadImageAnalysisSummaries(ctx.db, [row.shortcode])).get(
        row.shortcode,
      )?.description,
    ).toBe(analysis.result.description);
    // Combined consumers must select the same source-fenced description for
    // summaries and rich provenance, including fresh member corrections.
    const initialEvidence = await loadImageAnalysisEvidence(ctx.db, [
      row.shortcode,
    ]);
    expect(initialEvidence.summaries.get(row.shortcode)?.description).toBe(
      analysis.result.description,
    );
    expect(
      initialEvidence.descriptionEvidence.get(row.shortcode),
    ).toMatchObject({
      authority: "model",
      description: analysis.result.description,
      claims: analysis.result.claims,
    });
    expect(
      (await loadSelectedDescriptionEvidence(ctx.db, [row.shortcode])).get(
        row.shortcode,
      ),
    ).toMatchObject({
      authority: "model",
      description: analysis.result.description,
      claims: analysis.result.claims,
      analysis: { provider, model: IMAGE_DESCRIPTION_FEATURE.model },
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, imageId));
    expect(
      (await loadImageAnalysisSummaries(ctx.db, [row.shortcode])).get(
        row.shortcode,
      ),
    ).toBeUndefined();
    const staleEvidence = await loadImageAnalysisEvidence(ctx.db, [
      row.shortcode,
    ]);
    expect(staleEvidence.summaries.get(row.shortcode)).toBeUndefined();
    expect(
      staleEvidence.descriptionEvidence.get(row.shortcode)?.description,
    ).toBeNull();
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, imageId));
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      standalone: { kind: "image_description", id: row.shortcode },
      operationId: crypto.randomUUID(),
      verdict: "correct",
      correction: { present: true, value: "Confirmed navy cotton shirt" },
      intent: "apply",
    });
    expect(
      (await loadImageAnalysisSummaries(ctx.db, [row.shortcode])).get(
        row.shortcode,
      )?.description,
    ).toBe("Confirmed navy cotton shirt");
    const correctedEvidence = await loadImageAnalysisEvidence(ctx.db, [
      row.shortcode,
    ]);
    expect(correctedEvidence.summaries.get(row.shortcode)?.description).toBe(
      "Confirmed navy cotton shirt",
    );
    expect(
      correctedEvidence.descriptionEvidence.get(row.shortcode),
    ).toMatchObject({
      authority: "member",
      description: "Confirmed navy cotton shirt",
      claims: [],
      analysis: null,
    });
    expect(
      (await loadSelectedDescriptionEvidence(ctx.db, [row.shortcode])).get(
        row.shortcode,
      ),
    ).toMatchObject({ authority: "member", claims: [], analysis: null });
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
    expect(projection.analyses).toHaveLength(3);
    expect(
      projection.analyses.find((entry) => entry.preferred)?.result.description,
    ).toBe(analysis.result.description);
    expect(projection.correction?.description).toBe(
      "Confirmed navy cotton shirt",
    );
    expect(projection.status.cutout).toBe("pending");
    await drainDerivedRefreshFrontier(ctx.db);
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
          entityKind: "image" as const,
          entityId: imageId,
          feature: IMAGE_DESCRIPTION_FEATURE.feature,
          provider: "evaluation",
          model: `evaluation-${index}`,
          promptVersion: String(IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION),
          resultSchemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
          inputFingerprint: `evaluation-${index}`,
          createdAt: new Date(Date.now() + (index + 1) * 1000),
          result: { ...analysis.result, description: `Evaluation ${index}` },
        })),
      );
    const bounded = await getImageProcessingReadProjection(ctx.db, imageId);
    expect(bounded.analyses.length).toBeLessThanOrEqual(20);
    expect(
      bounded.analyses.find((entry) => entry.preferred)?.result.description,
    ).toBe(analysis.result.description);
    // Invalid rows consume raw history slots; older evaluation rows must not
    // refill them, while the preferred current-source result stays visible.
    await getDb(ctx.db)
      .update(aiAnalysis)
      .set({ result: {} })
      .where(inArray(aiAnalysis.model, ["evaluation-20", "evaluation-21"]));
    const malformed = await getImageProcessingReadProjection(ctx.db, imageId);
    expect(malformed.analyses).toHaveLength(19);
    expect(
      malformed.analyses.find((entry) => entry.preferred)?.result.description,
    ).toBe(analysis.result.description);
    const descriptions = malformed.analyses.map(
      (entry) => entry.result.description,
    );
    expect(descriptions).not.toContain("Evaluation 0");
    expect(descriptions).not.toContain("Evaluation 1");
  });

  it("retires image search and removes its description from an attached owner on delete", async () => {
    const row = await source();
    const imageId = parseEntityId("image", row.id);
    const owner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Search owner" }),
      ctx.actor,
    );
    await insertEntityAttachments(ctx.db, {
      entityId: owner.entityId,
      imageId,
      sortOrder: 0,
    });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      standalone: { kind: "image_description", id: row.shortcode },
      operationId: crypto.randomUUID(),
      verdict: "correct",
      correction: {
        present: true,
        value: "Confirmed searchable cobalt textile",
      },
      intent: "apply",
    });

    await drainDerivedRefreshFrontier(ctx.db);
    const before = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, owner.entityId));
    expect(before[0]?.body).toContain("Confirmed searchable cobalt textile");

    await deleteImages(ctx.db, [imageId]);
    await drainDerivedRefreshFrontier(ctx.db);

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
    expect(pending?.state).toBe("pending");
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

  it("settles retained negative cutouts in bounded repair without changing attempts or live and failed work", async () => {
    const legacy = async (reason: string) => {
      const row = await source();
      const lease = await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60_000,
      });
      if (!lease) throw new Error("Expected synthetic legacy lease");
      // The previous server stored these executor skips as failures.
      await completeImageProcessingJob(ctx.db, {
        result: {
          jobId: row.jobId,
          attemptId: lease.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "subject_lift",
            status: "failed",
            retryable: true,
            reason,
          },
        },
      });
      return row;
    };
    const first = await legacy("no_subject");
    const second = await legacy("not_suitable");
    // Older persisted skips can also have been reopened as pending work.
    await getDb(ctx.db)
      .update(imageProcessingAttempt)
      .set({
        state: "skipped",
        result: {
          kind: "subject_lift",
          status: "skipped",
          reason: "not_suitable",
        },
      })
      .where(eq(imageProcessingAttempt.jobId, second.jobId));
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({
        result: {
          kind: "subject_lift",
          status: "skipped",
          reason: "not_suitable",
        },
      })
      .where(eq(imageProcessingJob.id, second.jobId));
    const failure = await legacy("context_size_exceeded");
    const unsupported = await legacy("unsupported_format");
    const active = await legacy("no_subject");
    await updateJobs(
      ctx.db,
      { key: `image-processing:${active.jobId}` },
      { availableAt: new Date(0) },
    );
    const activeLease = await claimImageProcessingJob(ctx.db, {
      jobId: active.jobId,
      kinds: ["subject_lift"],
      leaseMs: 60_000,
    });
    expect(activeLease).not.toBeNull();
    const descriptionId = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", first.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (!descriptionId) throw new Error("Expected Apple description job");
    const descriptionLease = await claimImageProcessingJob(ctx.db, {
      jobId: descriptionId,
      kinds: ["describe_image"],
      leaseMs: 60_000,
    });
    if (!descriptionLease) throw new Error("Expected Apple description lease");
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: descriptionId,
        attemptId: descriptionLease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "skipped",
          reason: "no_subject",
        },
      },
    });
    const ids = [
      first.jobId,
      second.jobId,
      failure.jobId,
      unsupported.jobId,
      active.jobId,
      descriptionId,
    ];
    const attempts = () =>
      getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt)
        .where(inArray(imageProcessingAttempt.jobId, ids))
        .orderBy(imageProcessingAttempt.id);
    const evidence = () =>
      getDb(ctx.db)
        .select({
          id: imageProcessingJob.id,
          result: imageProcessingJob.result,
          runtime: imageProcessingJob.runtime,
          sourceContentHash: imageProcessingJob.sourceContentHash,
          processorRevision: imageProcessingJob.processorRevision,
        })
        .from(imageProcessingJob)
        .where(inArray(imageProcessingJob.id, ids))
        .orderBy(imageProcessingJob.id);
    const beforeAttempts = await attempts();
    const beforeEvidence = await evidence();
    expect(await repairImageProcessingExecution(ctx.db, 1)).toMatchObject({
      negativesSettled: 1,
      more: true,
    });
    expect(
      (await repairImageProcessingExecution(ctx.db, 10)).negativesSettled,
    ).toBe(1);
    expect(
      (await repairImageProcessingExecution(ctx.db, 10)).negativesSettled,
    ).toBe(0);
    expect(await attempts()).toEqual(beforeAttempts);
    expect(await evidence()).toEqual(beforeEvidence);
    expect(
      (
        await getDb(ctx.db)
          .select({ state: imageProcessingJob.state })
          .from(imageProcessingJob)
          .where(inArray(imageProcessingJob.id, [first.jobId, second.jobId]))
      ).map((row) => row.state),
    ).toEqual([
      imageProcessingJobState.enum.skipped,
      imageProcessingJobState.enum.skipped,
    ]);
    for (const row of [first, second]) {
      expect(
        (await readJobs(ctx.db, { key: `image-processing:${row.jobId}` }))[0]
          ?.state,
      ).toBe("completed");
      expect(
        (
          await getDb(ctx.db)
            .select({ status: imageDerivative.status })
            .from(imageDerivative)
            .where(eq(imageDerivative.id, row.derivativeId))
        )[0]?.status,
      ).toBe("skipped");
    }
    for (const row of [failure, unsupported]) {
      expect(
        (await readJobs(ctx.db, { key: `image-processing:${row.jobId}` }))[0]
          ?.state,
      ).toBe("retry_wait");
    }
    expect(
      (await readJobs(ctx.db, { key: `image-processing:${descriptionId}` }))[0]
        ?.state,
    ).toBe("retry_wait");
    expect(
      (await readJobs(ctx.db, { key: `image-processing:${active.jobId}` }))[0]
        ?.state,
    ).toBe("running");
    expect(
      await retryImageProcessingNow(ctx.db, {
        imageId: parseEntityId("image", first.id),
        kinds: ["subject_lift"],
      }),
    ).toEqual([first.jobId]);
    expect(
      (await repairImageProcessingExecution(ctx.db, 10)).negativesSettled,
    ).toBe(0);
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: first.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60_000,
      }),
    ).not.toBeNull();
  });

  // Negative cutout evidence is final for these inputs; explicit retry and changed inputs
  // create new work without weakening real processing failures or discarding prior attempts.
  it.each(["no_subject", "not_suitable"] as const)(
    "settles %s cutouts without automatic retries while retaining explicit retry and real failures",
    async (reason) => {
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
            reason,
          },
        },
      });
      expect(
        (await loadImageRepresentations(ctx.db, [row.shortcode])).get(
          row.shortcode,
        )?.transparent,
      ).toBeNull();
      const [skipped] = await getDb(ctx.db)
        .select()
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, row.jobId));
      expect(skipped).toMatchObject({
        state: "skipped",
        lastError: null,
        result: { kind: "subject_lift", status: "skipped", reason },
      });
      const [execution] = await readJobs(ctx.db, {
        key: `image-processing:${row.jobId}`,
      });
      expect(execution).toMatchObject({ state: "completed", leaseToken: null });
      const [attempt] = await getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt)
        .where(eq(imageProcessingAttempt.id, lease.attemptId));
      expect(attempt).toMatchObject({ state: "skipped", error: reason });
      expect(
        (await repairImageProcessingExecution(ctx.db, 10)).negativesSettled,
      ).toBe(0);
      expect(
        (
          await createTransparentDerivativeAndJob(ctx.db, {
            imageId: parseEntityId("image", row.id),
            sourceContentHash: hash,
            key: "tests/unchanged-source.png",
          })
        )?.jobId,
      ).toBe(row.jobId);
      expect(
        await claimImageProcessingJob(ctx.db, {
          jobId: row.jobId,
          kinds: ["subject_lift"],
          leaseMs: 60_000,
        }),
      ).toBeNull();
      expect(
        await retryImageProcessingNow(ctx.db, {
          imageId: parseEntityId("image", row.id),
        }),
      ).toEqual([row.jobId]);
      expect(
        (await repairImageProcessingExecution(ctx.db, 10)).negativesSettled,
      ).toBe(0);
      const retried = await claimImageProcessingJob(ctx.db, {
        jobId: row.jobId,
        kinds: ["subject_lift"],
        leaseMs: 60_000,
      });
      expect(retried?.attemptId).not.toBe(lease.attemptId);
      expect(retried).not.toBeNull();
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(imageProcessingAttempt)
            .where(eq(imageProcessingAttempt.id, lease.attemptId))
        )[0],
      ).toEqual(attempt);
      const replacementHash = "b".repeat(64);
      await getDb(ctx.db)
        .update(image)
        .set({ sha256: replacementHash })
        .where(eq(image.id, row.id));
      const changed = await createTransparentDerivativeAndJob(ctx.db, {
        imageId: parseEntityId("image", row.id),
        sourceContentHash: replacementHash,
        key: "tests/replaced-source.png",
      });
      expect(changed?.jobId).not.toBe(row.jobId);
      expect(changed).not.toBeNull();
      const revised = await createImageProcessingJob(ctx.db, {
        imageId: parseEntityId("image", row.id),
        kind: "subject_lift",
        sourceContentHash: replacementHash,
        processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION + 1,
      });
      expect(revised).not.toBeNull();
      expect(revised).not.toBe(changed?.jobId);
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
      // One failure only backs off; repeated failures ask for attention.
      expect(
        (
          await imageScaffold.read(ctx.db, {
            filters: { processingIssue: "failed" },
            sorts: [],
            pagination: {
              pageIndex: 0,
              pageSize: 100,
            },
          })
        ).data,
      ).toEqual([]);
      await updateJobs(
        ctx.db,
        { key: `image-processing:${failed.jobId}` },
        { attempts: JOB_NEEDS_ATTENTION_ATTEMPTS },
      );
      const problems = await imageScaffold.read(ctx.db, {
        filters: { processingIssue: "failed" },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 100 },
      });
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
    },
  );
});
