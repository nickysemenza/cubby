import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  imageIdentificationResult,
} from "@cubby/schemas/image-identification";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job as durableJob } from "~/server/db/retained-tables";
import {
  aiAnalysis,
  image,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";
import { dispatchImageProcessingWakeup } from "~/server/domains/image-processing/service/dispatch";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { getVerifiedImageRenditionKey } from "~/server/domains/image/repo/image-identification";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";
import { persistImageProcessingSubmission } from "./image-processing-submission";

// Device absence, unavailable descriptions, stale sources/leases, and failed
// analysis insertion must not block Clef or adopt unaccepted observations.
describe("independent durable image identification", () => {
  const ctx = withTestDb();
  const hash = "a".repeat(64);

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

  it("claims Clef without descriptions while the parked Apple description consumes no attempts", async () => {
    const { identification, apple, cloud } = await setup();
    expect(identification.processorRevision).toBe(
      IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
    );
    const lanes = await getDb(ctx.db)
      .select({ key: durableJob.key, kind: durableJob.kind })
      .from(durableJob)
      .where(
        sql`${durableJob.key} IN (${`image-processing:${apple.id}`}, ${`image-processing:${identification.id}`})`,
      );
    expect(Object.fromEntries(lanes.map((row) => [row.key, row.kind]))).toEqual(
      {
        [`image-processing:${apple.id}`]: "image.device",
        [`image-processing:${identification.id}`]: "image.cloud",
      },
    );
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
      state: "pending",
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
      ).toBe("deferred");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const [job] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, identification.id));
    expect(job).toMatchObject({ state: "pending", attempts: 0 });
    // A typed wait for the rendition, not a counted failure.
    const [execution] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${identification.id}`));
    expect(execution).toMatchObject({
      state: "queued",
      attempts: 0,
      waitReason: "device",
    });
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
      state: "pending",
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

  // Waiting for the Image row must not let an expired result become an accepted observation.
  it("rejects an identification receipt that expires while waiting for the Image", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let release = () => {};
    let holder: Promise<void> | undefined;
    try {
      const { row, identification } = await setup();
      const claimed = await lease(identification.id);
      let locked = () => {};
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const unlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      holder = withTransactionDatabase(ctx.db, async (tx) => {
        await getDb(tx)
          .select({ id: image.id })
          .from(image)
          .where(eq(image.id, row.id))
          .for("update");
        locked();
        await unlocked;
      });
      await ready;
      const receipt = completeImageProcessingJob(
        ctx.db,
        completion(identification.id, claimed.attemptId),
      );
      const settled = receipt.then(
        (result) => ({ result, error: null }),
        (error: Error) => ({ result: null, error }),
      );
      await expect
        .poll(async () => {
          const blocked = await getDb(ctx.db).execute<{ blocked: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%ImageProcessingJob%') AS blocked`,
          );
          return blocked.rows[0]?.blocked;
        })
        .toBe(true);
      vi.setSystemTime(Date.now() + 120_000);
      release();
      await holder;
      const outcome = await settled;
      expect(outcome.error !== null || outcome.result?.adopted === false).toBe(
        true,
      );
      expect(
        await getDb(ctx.db)
          .select()
          .from(aiAnalysis)
          .where(eq(aiAnalysis.entityId, row.id)),
      ).toEqual([]);
      const [attempt] = await getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt)
        .where(eq(imageProcessingAttempt.id, claimed.attemptId));
      expect(attempt?.completedAt).toBeNull();
      expect(attempt?.result).toBeNull();
    } finally {
      release();
      await holder;
      vi.useRealTimers();
    }
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
      // An expired lease alone is still adoptable; a newer claim is stale.
      if (stale === "lease") {
        await getDb(ctx.db)
          .update(durableJob)
          .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(durableJob.key, `image-processing:${identification.id}`));
        await lease(identification.id);
      }
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
