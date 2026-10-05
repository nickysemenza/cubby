import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateShortcode } from "@cubby/shared";
import {
  parseEntityId,
  parseShortcodeFor,
  type ImageShortcode,
} from "@cubby/schemas/identifiers";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { PhotoGroupProposalGroup } from "@cubby/schemas/photo-import-run";
import * as schema from "~/server/db/schema";
import {
  attachExistingImageToEntity,
  createUploadedImageRecord,
} from "~/server/repo/image";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import {
  seedProductCategoryPrerequisite,
  seedLocationPrerequisite,
} from "./fixtures-catalog";
import {
  getFixtureDb,
  fixtureUserId,
  ensureMemberParty,
} from "./fixtures-core";

export async function seedPhotoReviewProcessingFailure(
  imageCode: ImageShortcode,
  kind: "subject_lift" | "describe_image",
  reason: string,
) {
  const db = getFixtureDb();
  const [row] = await getDb(db)
    .select({ id: schema.image.id, sha256: schema.image.sha256 })
    .from(schema.image)
    .where(eq(schema.image.shortcode, imageCode));
  if (!row?.sha256) throw new Error("Synthetic photo needs a content hash");
  await getDb(db)
    .insert(schema.imageProcessingJob)
    .values({
      imageId: parseEntityId("image", row.id),
      kind,
      state: "failed",
      sourceContentHash: row.sha256,
      processorRevision: 1,
      lastError: reason,
    });
}

export async function seedPhotoReviewLabelText(
  imageCode: ImageShortcode,
  text: string,
) {
  const db = getFixtureDb();
  const [row] = await getDb(db)
    .select({ id: schema.image.id })
    .from(schema.image)
    .where(eq(schema.image.shortcode, imageCode));
  if (!row) throw new Error("Synthetic label photo not found");
  await getDb(db)
    .insert(schema.aiAnalysis)
    .values({
      entityKind: "image",
      entityId: row.id,
      feature: "photo-local-analysis",
      model: "synthetic",
      promptVersion: "v1",
      inputFingerprint: crypto.randomUUID(),
      result: {
        classifications: [],
        recognizedText: [{ text, confidence: 1 }],
      },
    });
}

export const seedImagePrerequisite = async (name: string) => {
  const created = await createUploadedImageRecord(getFixtureDb(), {
    key: `e2e-${name}`,
    filename: `${name}.png`,
    contentType: "image/png",
    size: 100,
  });
  return { id: parseShortcodeFor("image", created.shortcode) };
};

/** Attach a synthetic uploaded image through the same existing-image workflow. */
export const attachProductImagePrerequisite = async (
  page: Page,
  imageId: ImageShortcode,
  productId: string,
  purpose: "item" | "label",
) =>
  attachExistingImageToEntity(
    getFixtureDb(),
    { imageId, targetId: productId, purpose },
    requireActor(
      createTestRequestContext(getFixtureDb(), {
        auth: { userId: await fixtureUserId(page) },
      }),
    ).actorContext,
  );

/** Durable failed history only; this fixture never dispatches or calls AI. */
export async function seedActivityHistory(page: Page, name: string) {
  const db = getFixtureDb();
  const actorUserId = await fixtureUserId(page);
  const source = await createUploadedImageRecord(db, {
    key: `tests/${crypto.randomUUID()}.png`,
    filename: `${name}.png`,
    contentType: "image/png",
    size: 100,
  });
  const database = getDb(db);
  const [parent] = await database
    .insert(schema.run)
    .values({
      shortcode: generateShortcode("run"),
      actorUserId,
      actorName: "Synthetic member",
      actorEmail: "synthetic@example.test",
      purpose: "background",
      trigger: "manual",
      status: "completed",
      startedAt: new Date(),
      endedAt: new Date(),
    })
    .returning();
  if (!parent) throw new Error("Activity fixture parent not created");
  const [job] = await database
    .insert(schema.imageProcessingJob)
    .values({
      imageId: parseEntityId("image", source.id),
      kind: "describe_image",
      sourceContentHash: "a".repeat(64),
      processorRevision: 1,
      state: "failed",
      attempts: 1,
      lastError: "Synthetic provider failure",
      runId: parent.id,
    })
    .returning();
  if (!job) throw new Error("Activity fixture job not created");
  const [standalone] = await database
    .insert(schema.imageProcessingJob)
    .values({
      imageId: parseEntityId("image", source.id),
      kind: "subject_lift",
      sourceContentHash: "a".repeat(64),
      processorRevision: 1,
      state: "failed",
      attempts: 0,
      lastError: "Synthetic standalone failure",
    })
    .returning();
  if (!standalone)
    throw new Error("Activity fixture standalone job not created");
  await database.insert(schema.imageProcessingAttempt).values({
    id: crypto.randomUUID(),
    jobId: job.id,
    number: 1,
    state: "failed",
    executor: {
      kind: "cloud",
      deviceId: null,
      name: "Test provider",
      platform: "cloud",
      appVersion: null,
      osVersion: null,
    },
    diagnostics: {
      provider: "test",
      model: "synthetic-vision",
      inputAvailability: "historical input unavailable",
    },
    result: { status: "failed", reason: "Synthetic provider failure" },
    completedAt: new Date(),
  });
  await database.insert(schema.imageProcessingEvent).values({
    jobId: job.id,
    eventKey: "test-completed",
    event: "attempt.completed",
    details: { status: "failed" },
  });
  return {
    imageId: source.shortcode,
    runId: parent.shortcode,
    jobId: job.publicId,
    standaloneJobId: standalone.publicId,
    filename: source.filename,
  };
}

/**
 * More image jobs, attempts, and events than one cursor page (20) holds, all
 * in one synthetic submission so `/runs?submissionId=` lists only them. Job
 * `NN` is `NN` minutes old: newest-first lists `01` first and leaves the
 * oldest on the second page. The newest job also carries `count` attempts
 * and `count` events for the detail's own cursors.
 */
export async function seedPagedActivityHistory(name: string, count: number) {
  const db = getFixtureDb();
  const database = getDb(db);
  const [submission] = await database
    .insert(schema.imageProcessingSubmission)
    .values({})
    .returning();
  if (!submission) throw new Error("Paged activity submission not created");
  const label = (index: number) => String(index + 1).padStart(2, "0");
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const image = await createUploadedImageRecord(db, {
      key: `tests/${crypto.randomUUID()}.png`,
      filename: `${name} ${label(index)}.png`,
      contentType: "image/png",
      size: 100,
    });
    const [job] = await database
      .insert(schema.imageProcessingJob)
      .values({
        imageId: parseEntityId("image", image.id),
        kind: "describe_image",
        sourceContentHash: "b".repeat(64),
        processorRevision: 1,
        state: "failed",
        attempts: index === 0 ? count : 0,
        lastError: "Synthetic paged failure",
        submissionId: submission.id,
        createdAt: minutesAgo(index + 1),
      })
      .returning();
    if (!job) throw new Error("Paged activity job not created");
    jobs.push(job);
  }
  await database.insert(schema.imageProcessingSubmissionJob).values(
    jobs.map((job) => ({
      submissionId: submission.id,
      jobId: job.id,
      disposition: "new",
      baselineAttempts: 0,
    })),
  );
  const newest = jobs[0];
  if (!newest) throw new Error("Paged activity needs at least one job");
  await database.insert(schema.imageProcessingAttempt).values(
    Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(),
      jobId: newest.id,
      number: index + 1,
      state: "failed",
      startedAt: minutesAgo(count - index),
      completedAt: minutesAgo(count - index),
    })),
  );
  await database.insert(schema.imageProcessingEvent).values(
    Array.from({ length: count }, (_, index) => ({
      jobId: newest.id,
      eventKey: `paged-${label(index)}`,
      event: `synthetic.step.${label(index)}`,
      occurredAt: minutesAgo(count - index),
    })),
  );
  return {
    submissionId: submission.publicId,
    newestJobId: newest.publicId,
  };
}

/**
 * A running photo-inventory Run with three synthetic photos, seeded
 * two suggested groups (a two-photo item/label pair and a single-photo item),
 * and the Location the item group's inventory targets. There is no browser
 * flow to create a photo-inventory run with real uploaded photos, so this
 * mirrors `proposals.integration.test.ts`'s `seedRun`: an RunTarget row
 * is inserted directly per image rather than through the byte-verifying
 * `finalizePhotoRun` upload path. The browser test submits proposals
 * through the same authenticated review route an agent can use.
 */
export async function seedPhotoGroupReviewRun(
  page: Page,
  name: string,
  objectStorageUrl: string,
) {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);

  await ensureMemberParty(page, name);

  const location = await seedLocationPrerequisite(page, `${name} location`);
  const category = await seedProductCategoryPrerequisite(page, {
    name: `${name} apparel`,
  });

  const seedRunImage = async (label: "shirt" | "label" | "boots") => {
    const bytes = readFileSync(
      new URL(`./fixtures/synthetic-wardrobe-${label}.png`, import.meta.url),
    );
    const key = `e2e/photos/${name}-${label}-${crypto.randomUUID()}`;
    const upload = await fetch(
      `${objectStorageUrl}/e2e-bucket/${encodeURIComponent(key)}`,
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes },
    );
    if (!upload.ok)
      throw new Error(`Synthetic photo upload failed: ${upload.status}`);
    const row = await createUploadedImageRecord(db, {
      key,
      filename: `4K7M-${label}.png`,
      contentType: "image/png",
      size: bytes.length,
      width: 640,
      height: 640,
      detectedContentType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    });
    return {
      uuid: parseEntityId("image", row.id),
      shortcode: parseShortcodeFor("image", row.shortcode),
    };
  };
  const itemImage = await seedRunImage("shirt");
  const labelImage = await seedRunImage("label");
  const soloImage = await seedRunImage("boots");

  const run = await startPhotoInventoryRun(db, { actorUserId: userId });

  await getDb(db)
    .insert(schema.runTarget)
    .values(
      [itemImage, labelImage, soloImage].map((image, index) => ({
        runId: run.id,
        entityKind: "image" as const,
        entityId: image.uuid,
        position: index,
        state: "pending" as const,
        targetFingerprint: `e2e-${name}-${index}`,
      })),
    );

  const groups: PhotoGroupProposalGroup[] = [
    {
      groupKey: "g1",
      images: [{ id: itemImage.shortcode, purpose: "item" }],
      skip: [{ id: labelImage.shortcode, reason: "Tag photo needs review" }],
      product: { kind: "create", create: { name: "Gray crew t-shirt — M" } },
      inventory: {
        locationId: parseShortcodeFor("location", location.id),
        quantity: 2,
      },
    },
    {
      groupKey: "g2",
      images: [{ id: soloImage.shortcode, purpose: "item" }],
      product: { kind: "create", create: { name: `${name} solo find` } },
    },
  ];

  return {
    runId: run.publicId,
    groups,
    location,
    category,
    itemImage,
    labelImage,
    soloImage,
  };
}

/**
 * One member-started Run and one ephemeral AI-grouping Run, each naming its own
 * vendor so the history table can tell them apart.
 */
export async function seedRunHistoryDefaults(page: Page, name: string) {
  const db = getFixtureDb();
  const actorUserId = await fixtureUserId(page);
  const database = getDb(db);
  const insertRun = async (
    label: string,
    purpose: "file_import" | "ai_suggest",
    trigger: "manual" | "ephemeral",
  ) => {
    const vendor = await insertWithShortcode(db, "vendor", {
      name: label,
      website: "https://example.test",
    });
    await database.insert(schema.run).values({
      shortcode: generateShortcode("run"),
      actorUserId,
      actorName: "Synthetic member",
      actorEmail: "synthetic@example.test",
      purpose,
      trigger,
      vendorId: vendor.id,
      status: "completed",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    return label;
  };
  return {
    visibleName: await insertRun(`${name} manual`, "file_import", "manual"),
    hiddenName: await insertRun(`${name} ephemeral`, "ai_suggest", "ephemeral"),
  };
}
