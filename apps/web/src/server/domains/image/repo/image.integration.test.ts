import { buildActorContext } from "@cubby/schemas/context";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  type ImageId,
  type ProjectId,
  parseEntityId,
  parseShortcodeFor,
  runEntityId,
  userId,
} from "@cubby/schemas/identifiers";
import { getImageByIdSchema } from "@cubby/schemas/image";
import { imageSourceEvidence } from "@cubby/schemas/image-capture-fields";
import { photoRunImageState } from "@cubby/schemas/photo-import-run";
import { testShortcode } from "@cubby/schemas/testing";
import { sha256Hex } from "@cubby/shared/sha256";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as s3 from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  associatePendingImages,
  getDb,
  galleryBinding,
  insertAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import {
  entityAttachment,
  image,
  imageProcessingJob,
  run as runTable,
  photoRunImage,
  ledgerParty,
  user,
} from "~/server/db/schema";
import {
  deleteCookbook,
  upsertCookbook,
} from "~/server/domains/cookbook/repo/cookbook";
import {
  imageUploadHandlers,
  markImageUploadedWorkflow,
} from "~/server/domains/image/operations/image.server";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { systemPrincipal } from "~/server/http/authenticate";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  makeCookbookExtraction,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";

import {
  createOrReuseAttachedImage,
  reapUnreferencedImages,
  attachExistingImageToEntity,
  createPendingImageRecord,
  createUploadedImageRecord,
  publishImageSourceClassifications,
  getImageCaptureState,
  setImageCaptureState,
  selectImagesForProvenanceClassification,
  countCullablePendingImages,
  cullPendingImages,
  detachImagesFromEntity,
  imageScaffold,
  getImageHashIndex,
  setImagePerceptualHashes,
  updateImage,
  readImageById,
} from "./image";

/** Integration tests reach no R2: the stored object is served from memory. */
const stored = (bytes: Uint8Array, contentType: string) => async () =>
  new Response(new Uint8Array(bytes), {
    headers: { "content-type": contentType },
  });
const unverified = stored(new Uint8Array([1, 2, 3]), "image/jpeg");
const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

let runFixtureSeq = 0;
const uniqRunLabel = (label: string) =>
  `${label}-${(runFixtureSeq++).toString(36)}`;

/** Minimal live `LedgerParty`, for fixtures that only need a valid owner id. */
const mkLedgerParty = (db: Database) =>
  insertWithShortcode(db, "ledgerParty", {
    name: uniqRunLabel("Ledger party"),
    kind: "member",
  });

const mkActorUser = (db: Database) =>
  insertAndReturn(db, user, {
    id: uniqRunLabel("user"),
    name: "Import run fixture actor",
    email: `${uniqRunLabel("actor")}@example.test`,
  });

const mkPhotoInventoryRun = async (db: Database) => {
  const party = await mkLedgerParty(db);
  const actor = await mkActorUser(db);
  await getDb(db)
    .update(ledgerParty)
    .set({ userId: userId.parse(actor.id) })
    .where(eq(ledgerParty.id, party.id));
  const id = await ensureRun(
    db,
    buildActorContext(userId.parse(actor.id), "web"),
    { purpose: "photo_inventory", trigger: "manual", execution: false },
  );
  const run = await getDb(db).query.run.findFirst({
    where: eq(runTable.id, id),
  });
  if (!run) throw new Error("Expected photo inventory Run");
  return run;
};

const mkRunTargetRow = (
  db: Database,
  values: {
    runId: string;
    imageId: ImageId;
    position?: number;
    state?: string;
    createdAt?: Date;
  },
) =>
  insertAndReturn(db, photoRunImage, {
    runId: runEntityId.parse(values.runId),
    imageId: parseEntityId("image", values.imageId),
    position: values.position,
    createdAt: values.createdAt,
    state: photoRunImageState.parse(values.state ?? "pending"),
    targetFingerprint: uniqRunLabel("target-fingerprint"),
  });

describe("image repository", () => {
  const ctx = withTestDb();
  let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    backgroundQueue = captureBackgroundQueue();
  });
  afterEach(() => {
    backgroundQueue.restore();
  });

  it("publishes source decisions only against the selected snapshot and preserves stronger evidence", async () => {
    const eligible = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "upload-2026-10-14.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const changed = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "stale-snapshot.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const protectedImage = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "manual-source.jpg",
      contentType: "image/jpeg",
      size: 512,
      source: "own",
    });
    const dbc = getDb(ctx.db);
    const protectedImageId = parseEntityId("image", protectedImage.id);
    const staleId = parseEntityId("image", changed.id);
    const protectedUpdatedAt = new Date(Date.now() + 2_000);
    await dbc
      .update(image)
      .set({
        provenanceEvidence: { basis: "manual" },
        updatedAt: protectedUpdatedAt,
      })
      .where(eq(image.id, protectedImageId));
    const [protectedSnapshot] = await dbc
      .select({ updatedAtToken: sql<string>`${image.updatedAt}::text` })
      .from(image)
      .where(eq(image.id, protectedImageId));
    if (!protectedSnapshot)
      throw new Error("Expected the protected image snapshot to exist.");

    const eligibleId = parseEntityId("image", eligible.id);
    const initial = await selectImagesForProvenanceClassification(ctx.db, 100);
    expect(initial.map(({ id }) => id)).toContain(eligibleId);
    expect(initial.map(({ id }) => id)).not.toContain(protectedImageId);
    const eligibleSnapshot = initial.find(({ id }) => id === eligibleId)!;
    const staleSnapshot = initial.find(({ id }) => id === staleId)!;
    await dbc
      .update(image)
      .set({
        filename: "updated-before-publish.jpg",
        updatedAt: new Date(staleSnapshot.updatedAt.getTime() + 1_000),
      })
      .where(eq(image.id, staleId));

    const evidence = imageSourceEvidence.parse({
      basis: "decision",
      feature: "image-provenance-classification",
      promptVersion: "2026-10-14.1",
      model: "synthetic-test-model",
      runId: testShortcode("run", "4K7M"),
      confidence: "high",
      probability: 0.98,
      evidenceFingerprint: "a".repeat(64),
      value: "catalog",
    });
    const result = await publishImageSourceClassifications(ctx.db, [
      {
        id: eligibleId,
        expectedUpdatedAt: eligibleSnapshot.updatedAtToken,
        source: "catalog",
        sourceEvidence: evidence,
      },
      {
        id: staleId,
        expectedUpdatedAt: staleSnapshot.updatedAtToken,
        source: "own",
        sourceEvidence: { ...evidence, value: "own" },
      },
      {
        id: protectedImageId,
        expectedUpdatedAt: protectedSnapshot.updatedAtToken,
        source: "screenshot",
        sourceEvidence: { ...evidence, value: "screenshot" },
      },
    ]);

    expect(result).toEqual({ classified: 1, capturedAtSeeded: 0 });
    const persisted = await dbc
      .select({ source: image.source, sourceEvidence: image.sourceEvidence })
      .from(image)
      .where(inArray(image.id, [eligibleId, staleId, protectedImageId]));
    expect(persisted).toEqual(
      expect.arrayContaining([
        { source: "catalog", sourceEvidence: evidence },
        { source: "unknown", sourceEvidence: null },
        { source: "own", sourceEvidence: null },
      ]),
    );
    expect(await readImageById(ctx.db, eligible.id)).toMatchObject({
      source: "catalog",
      sourceEvidence: evidence,
    });
    const captureState = await getImageCaptureState(ctx.db, eligibleId);
    if (!captureState) throw new Error("Expected capture state");
    await setImageCaptureState(ctx.db, eligibleId, captureState);
    expect(await readImageById(ctx.db, eligible.id)).toMatchObject({
      sourceEvidence: evidence,
    });
    await setImageCaptureState(ctx.db, eligibleId, {
      ...captureState,
      source: "own",
      provenanceEvidence: { basis: "sighting" },
    });
    expect(await readImageById(ctx.db, eligible.id)).toMatchObject({
      source: "own",
      sourceEvidence: null,
    });
    await updateImage(ctx.db, eligible.id, {
      filename: "manual-source-correction.jpg",
      source: "own",
    });
    const manuallyChanged = await dbc
      .select({ source: image.source, sourceEvidence: image.sourceEvidence })
      .from(image)
      .where(eq(image.id, eligibleId));
    expect(manuallyChanged).toEqual([{ source: "own", sourceEvidence: null }]);
    expect(await readImageById(ctx.db, eligible.id)).toMatchObject({
      source: "own",
      sourceEvidence: null,
    });
  });

  it("persists reviewed catalog provenance without replacing stored image bytes", async () => {
    const original = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "catalog-item.jpg",
      contentType: "image/jpeg",
      size: 512,
      source: "own",
    });
    const before = await readImageById(ctx.db, original.id);
    await updateImage(ctx.db, original.id, {
      filename: before.filename,
      source: "catalog",
      sourcePageUrl: "https://supplier.example.test/products/item",
      sourceAssetUrl: "https://supplier.example.test/images/item.jpg",
      sourceName: "Example supplier",
    });
    const persisted = await readImageById(ctx.db, original.id);
    expect(persisted).toMatchObject({
      source: "catalog",
      sourcePageUrl: "https://supplier.example.test/products/item",
      sourceAssetUrl: "https://supplier.example.test/images/item.jpg",
      sourceName: "Example supplier",
      key: before.key,
      url: before.url,
      size: before.size,
      contentType: before.contentType,
    });
    await updateImage(ctx.db, original.id, {
      filename: before.filename,
      sourceName: null,
    });
    expect(await readImageById(ctx.db, original.id)).toMatchObject({
      source: "catalog",
      sourcePageUrl: persisted.sourcePageUrl,
      sourceAssetUrl: persisted.sourceAssetUrl,
      sourceName: null,
    });
  });

  it("prioritizes recent uploads in the hash repair queue", async () => {
    const older = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "older.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const newer = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "newer.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(image.id, older.id));
    await getDb(ctx.db)
      .update(image)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(image.id, newer.id));
    const index = await getImageHashIndex(ctx.db);
    const ids = new Set([older.shortcode, newer.shortcode]);
    const repair = index.repair.find((row) => row.id === newer.shortcode);
    expect(repair?.originalUrl).toMatch(/\.jpg$/);
    expect(repair).not.toHaveProperty("url");
    expect(
      index.repair.filter(({ id }) => ids.has(id)).map(({ id }) => id),
    ).toEqual([newer.shortcode, older.shortcode]);
  });

  it("returns a canonical Image from markUploaded while retaining stored source evidence", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.png`,
      filename: "synthetic-upload.png",
      contentType: "image/png",
      size: ONE_PIXEL_PNG.byteLength,
      source: "catalog",
      sourcePageUrl: "https://supplier.example.test/products/synthetic-item",
    });
    const evidence = imageSourceEvidence.parse({
      basis: "decision",
      feature: "image-provenance-classification",
      promptVersion: "2026-10-14.1",
      model: "synthetic-test-model",
      runId: testShortcode("run", "4K7M"),
      confidence: "high",
      probability: 0.98,
      evidenceFingerprint: "a".repeat(64),
      value: "catalog",
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sourceEvidence: evidence })
      .where(eq(image.id, pending.id));
    const readStored = vi
      .spyOn(s3, "getS3Object")
      .mockImplementation(stored(ONE_PIXEL_PNG, "image/png"));
    try {
      const result = await imageUploadHandlers.operations.markUploaded({
        data: getImageByIdSchema.parse({ id: pending.shortcode }),
        request: {
          principal: systemPrincipal(
            buildKernelContext(ctx.db, ctx.actor.userId),
          ),
          headers: new Headers({ "cf-ray": "0123456789abcdef-SJC" }),
          signal: new AbortController().signal,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const row = result.data;
      const raw = await readImageById(ctx.db, pending.id);
      expect(row.status).toBe("UPLOADED");
      expect(row.source).toBe("catalog");
      expect(row.sourcePageUrl).toBe(
        "https://supplier.example.test/products/synthetic-item",
      );
      expect(row.sourceEvidence).toEqual(evidence);
      expect(fieldValueOf(row.fields.url)).toBe(raw.url);
      expect(fieldValueOf(row.fields.representations)).toEqual(
        raw.representations,
      );
      expect(fieldValueOf(row.fields.sightings)).toEqual(raw.sightings);
      expect(row.fields.dataQuality.current).toMatchObject({
        assignment: null,
        controls: { kind: "readonly", reason: "computed" },
      });
      for (const key of [
        "url",
        "representations",
        "sightings",
        "capturedByName",
        "provenanceEvidenceLabel",
        "dataQuality",
        "fieldResolutions",
        "derived",
      ])
        expect(row).not.toHaveProperty(key);
    } finally {
      readStored.mockRestore();
    }
  });

  // A standalone upload (a Mac browser screenshot) had no content hash, so
  // with automatic processing on, scheduling refused it and every screenshot
  // upload failed. The stored bytes' hash is recorded as the upload is marked.
  it("hashes a standalone upload before scheduling its automatic processing", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.png`,
      filename: "browser-view.png",
      contentType: "image/png",
      size: ONE_PIXEL_PNG.byteLength,
      // An EXIF-oriented size a client reports is never checked here.
      width: 3000,
      height: 4000,
    });
    await markImageUploadedWorkflow(
      ctx.db,
      getImageByIdSchema.parse({ id: pending.shortcode }),
      stored(ONE_PIXEL_PNG, "image/png"),
    );
    const [row] = await getDb(ctx.db)
      .select({
        status: image.status,
        sha256: image.sha256,
        renderStatus: image.renderStatus,
      })
      .from(image)
      .where(eq(image.id, pending.id));
    expect(row).toMatchObject({
      status: "UPLOADED",
      sha256: await sha256Hex(ONE_PIXEL_PNG),
    });
    expect(row?.renderStatus).not.toBe("failed");
    const jobs = await getDb(ctx.db)
      .select({ kind: imageProcessingJob.kind })
      .from(imageProcessingJob)
      .where(
        eq(imageProcessingJob.imageId, parseEntityId("image", pending.id)),
      );
    expect(jobs.map(({ kind }) => kind).sort()).toEqual([
      "describe_image",
      "describe_image",
      "identify_image",
      "subject_lift",
    ]);
  });

  it("leaves an upload pending, for the client to retry, when its object cannot be read", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "missing.jpg",
      contentType: "image/jpeg",
      size: 3,
    });
    await expect(
      markImageUploadedWorkflow(
        ctx.db,
        getImageByIdSchema.parse({ id: pending.shortcode }),
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow("is unavailable: 503");
    const [row] = await getDb(ctx.db)
      .select({ status: image.status })
      .from(image)
      .where(eq(image.id, pending.id));
    expect(row?.status).toBe("PENDING");
  });

  it("resolves public image identity before marking an upload complete", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "workflow-upload.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const input = getImageByIdSchema.parse({ id: pending.shortcode });
    expect(
      await markImageUploadedWorkflow(ctx.db, input, unverified),
    ).toMatchObject({ status: "UPLOADED" });
    await expect(
      markImageUploadedWorkflow(ctx.db, input, unverified),
    ).rejects.toThrow("Failed to update record");
    const [stored] = await getDb(ctx.db)
      .select({ status: image.status })
      .from(image)
      .where(eq(image.id, pending.id));
    expect(stored?.status).toBe("UPLOADED");
  });

  it("persists native metadata and fills hashes without overwriting canonical values", async () => {
    const first = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "native-first.jpg",
      contentType: "image/jpeg",
      size: 512,
      perceptualHash: "0123456789abcdef",
      sourceFingerprint: { hash: "fedcba9876543210", aspectRatio: 1.5 },
      width: 1200,
      height: 800,
    });
    const second = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "native-second.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const unavailable = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "not-uploaded.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await markImageUploadedWorkflow(
      ctx.db,
      getImageByIdSchema.parse({ id: first.shortcode }),
      unverified,
    );

    const result = await setImagePerceptualHashes(ctx.db, {
      algorithmRevision: 1,
      items: [
        {
          id: parseShortcodeFor("image", first.shortcode),
          perceptualHash: "aaaaaaaaaaaaaaaa",
        },
        {
          id: parseShortcodeFor("image", second.shortcode),
          perceptualHash: "bbbbbbbbbbbbbbbb",
        },
        {
          id: parseShortcodeFor("image", unavailable.shortcode),
          perceptualHash: "cccccccccccccccc",
        },
      ],
    });
    expect(result).toEqual({
      items: [
        {
          id: first.shortcode,
          perceptualHash: "0123456789abcdef",
        },
        { id: second.shortcode, perceptualHash: "bbbbbbbbbbbbbbbb" },
      ],
      unavailable: [unavailable.shortcode],
    });
    const index = await getImageHashIndex(ctx.db);
    expect(index.items).toContainEqual({
      id: first.shortcode,
      perceptualHash: "0123456789abcdef",
      sourceFingerprint: { hash: "fedcba9876543210", aspectRatio: 1.5 },
      width: 1200,
      height: 800,
      directOwnerShortcodes: [],
    });
    expect(index.repair.map(({ id }) => id)).not.toContain(first.shortcode);
    expect(index.items.map(({ id }) => id)).not.toContain(
      unavailable.shortcode,
    );
  });

  it("enforces canonical lowercase perceptual hashes at the database boundary", async () => {
    await expect(
      createPendingImageRecord(ctx.db, {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: "invalid-hash.jpg",
        contentType: "image/jpeg",
        size: 512,
        perceptualHash: "ABCDEF0123456789",
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "Image_perceptualHash_format_check" },
    });
  });

  it("deduplicates association retries while still finalizing pending uploads", async () => {
    const projectId = (
      await createRepoEntity(ctx, "project", {
        name: "Idempotent photo project",
      })
    ).entityId;
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "retry.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const imageId = parseEntityId("image", pending.id);
    const dbc = getDb(ctx.db);
    await associatePendingImages(dbc, galleryBinding("project"), projectId, [
      imageId,
      imageId,
    ]);
    await associatePendingImages(
      dbc,
      galleryBinding("project"),
      projectId,
      [imageId],
      1,
    );
    const appended = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "appended.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const appendedId = parseEntityId("image", appended.id);
    await associatePendingImages(dbc, galleryBinding("project"), projectId, [
      imageId,
      appendedId,
    ]);

    expect(
      (
        await dbc
          .select()
          .from(entityAttachment)
          .where(eq(entityAttachment.entityId, projectId))
          .orderBy(asc(entityAttachment.sortOrder))
      ).map(({ imageId: id, sortOrder }) => ({ id, sortOrder })),
    ).toEqual([
      { id: imageId, sortOrder: 0 },
      { id: appendedId, sortOrder: 1 },
    ]);
    const [stored] = await dbc
      .select({ status: image.status })
      .from(image)
      .where(eq(image.id, imageId));
    expect(stored?.status).toBe("UPLOADED");
  });

  it("rejects unavailable pending image associations before writing", async () => {
    const projectId = (
      await createRepoEntity(ctx, "project", {
        name: "Unavailable photo project",
      })
    ).entityId;
    const failed = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "failed.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const missing = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "missing.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const mismatched = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "mismatched.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const deleted = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "deleted.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const ids = [failed.id, missing.id, mismatched.id, deleted.id].map((id) =>
      parseEntityId("image", id),
    );
    const dbc = getDb(ctx.db);
    await dbc
      .update(image)
      .set({ status: "FAILED" })
      .where(eq(image.id, ids[0]!));
    await dbc
      .update(image)
      .set({ storageStatus: "missing" })
      .where(eq(image.id, ids[1]!));
    await dbc
      .update(image)
      .set({ storageStatus: "metadata_mismatch" })
      .where(eq(image.id, ids[2]!));
    await dbc
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, ids[3]!));

    await expect(
      associatePendingImages(dbc, galleryBinding("project"), projectId, ids),
    ).rejects.toMatchObject({ reason: "REFERENCED_RECORD_MISSING" });
    expect(
      await dbc
        .select()
        .from(entityAttachment)
        .where(inArray(entityAttachment.imageId, ids)),
    ).toHaveLength(0);
  });

  it("culls only expired unassociated pending images", async () => {
    const projectId = (
      await createRepoEntity(ctx, "project", {
        name: "Pending photo cleanup project",
      })
    ).entityId;
    const expired = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "expired-pending.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const protectedByAssociation = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "associated-pending.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const recent = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "recent-pending.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await getDb(ctx.db)
      .update(image)
      .set({ createdAt: expiredAt })
      .where(inArray(image.id, [expired.id, protectedByAssociation.id]));
    await associatePendingImages(
      getDb(ctx.db),
      galleryBinding("project"),
      projectId,
      [parseEntityId("image", protectedByAssociation.id)],
      0,
      { activate: false },
    );

    expect(await countCullablePendingImages(ctx.db, 24)).toBe(1);
    expect(await cullPendingImages(ctx.db, 24)).toEqual({
      count: 1,
      deletedIds: [expired.id],
      deletedKeys: [expired.key],
    });
    expect(
      await getDb(ctx.db)
        .select({ id: image.id, status: image.status })
        .from(image)
        .where(inArray(image.id, [protectedByAssociation.id, recent.id])),
    ).toEqual(
      expect.arrayContaining([
        { id: protectedByAssociation.id, status: "PENDING" },
        { id: recent.id, status: "PENDING" },
      ]),
    );
  });

  it("skips expired pending images locked by an in-flight commit", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "commit-locked-pending.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) })
      .where(eq(image.id, pending.id));

    await withTransaction(ctx.db, async (tx) => {
      await tx
        .select({ id: image.id })
        .from(image)
        .where(eq(image.id, pending.id))
        .for("update");
      expect(await cullPendingImages(ctx.db, 24)).toEqual({
        count: 0,
        deletedIds: [],
        deletedKeys: [],
      });
    });

    expect(await cullPendingImages(ctx.db, 24)).toMatchObject({
      count: 1,
      deletedIds: [pending.id],
    });
  });

  // findCullablePendingImages enumerates four join tables (product/location/
  // recipe/project image) PLUS cookbook.coverImageId, which is a direct FK, not
  // a join row. Missing it meant a cookbook cover with no other association was
  // exactly what the cull selected — and the cull is a HARD delete, so the R2
  // object would go too.
  //
  // upsertCookbook flips a cover to UPLOADED in the same transaction that writes
  // coverImageId, so a live cookbook can never normally point its coverImageId at
  // a still-PENDING image — this combination is currently unreachable through the
  // normal write path. We write it directly via the db to pin the guard against
  // that invariant ever slipping (a future write path that sets coverImageId
  // without flipping status would otherwise silently reintroduce the bug this
  // regression covers).

  // The non-obvious half of the guard above: deleteCookbook tombstones the
  // Cookbook row (deletedAt set) WITHOUT nulling coverImageId, so a soft-deleted
  // cookbook still holds a live FK to the image. findCullablePendingImages is
  // deliberately NOT filtered by notDeleted(cookbook) — filtering it would cull
  // exactly the images that then blow up the hard-delete on
  // Cookbook_coverImageId_fkey.
});

describe("image repository — import-run targets", () => {
  const ctx = withTestDb();

  const makeImage = (filename: string) =>
    createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename,
      contentType: "image/jpeg",
      size: 512,
    });

  it("filters images by runId and targetState", async () => {
    const run = await mkPhotoInventoryRun(ctx.db);
    const otherRun = await mkPhotoInventoryRun(ctx.db);
    const pendingImage = await makeImage("run-pending.jpg");
    const preparedImage = await makeImage("run-prepared.jpg");
    const otherRunImage = await makeImage("other-run.jpg");
    const untargetedImage = await makeImage("untargeted.jpg");

    await mkRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: pendingImage.id,
      position: 1,
      state: "pending",
    });
    await mkRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: preparedImage.id,
      position: 2,
      state: "prepared",
    });
    await mkRunTargetRow(ctx.db, {
      runId: otherRun.id,
      imageId: otherRunImage.id,
      position: 1,
      state: "pending",
    });

    const runCode = parseShortcodeFor("run", run.shortcode);
    const byRun = await imageScaffold.read(ctx.db, {
      filters: { runId: runCode },
      sorts: [],
      pagination: {
        pageIndex: 0,
        pageSize: 100,
      },
    });
    const byRunIds = byRun.data.map((row) => row.id);
    expect(byRunIds).toContain(pendingImage.shortcode);
    expect(byRunIds).toContain(preparedImage.shortcode);
    expect(byRunIds).not.toContain(otherRunImage.shortcode);
    expect(byRunIds).not.toContain(untargetedImage.shortcode);

    const byRunAndState = await imageScaffold.read(ctx.db, {
      filters: { runId: runCode, targetState: "pending" },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    const byRunAndStateIds = byRunAndState.data.map((row) => row.id);
    expect(byRunAndStateIds).toContain(pendingImage.shortcode);
    expect(byRunAndStateIds).not.toContain(preparedImage.shortcode);

    const byStateAlone = await imageScaffold.read(ctx.db, {
      filters: { targetState: ["pending"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    const byStateAloneIds = byStateAlone.data.map((row) => row.id);
    expect(byStateAloneIds).toContain(pendingImage.shortcode);
    expect(byStateAloneIds).toContain(otherRunImage.shortcode);
    expect(byStateAloneIds).not.toContain(preparedImage.shortcode);

    // Each listed image carries its own target's run/state/position back —
    // the agent workflow reads this instead of a second lookup per image.
    const preparedRow = byRun.data.find(
      (row) => row.id === preparedImage.shortcode,
    );
    expect(preparedRow?.importTarget).toMatchObject({
      runId: run.shortcode,
      state: "prepared",
      position: 2,
    });
  });
});

// `PurchaseImage` is a charge's documents — the emailed PDF invoice or a photo
// of the paper slip (see purchase.ts / the `Vendor -> Purchase -> Expense`
// split). It was added as a new incoming FK edge on `image`, but three of its
// consumers in image.ts were never updated to know about it: `deleteImages`
// (missing the join-row delete -> a raw `PurchaseImage_imageId_fkey`
// violation, a 500 on `/images`), `imageEntityRelations`/
// `imageAssociations` (missing the relation/branch -> a charge document
// reads as unattached), and `findCullablePendingImages` (missing the
// association check -> reachable only in theory today, but the same shape of
// bug). This block pins all three against regressing.
describe("image repository — purchase (charge) documents", () => {
  const ctx = withTestDb();

  const makePendingImage = async () =>
    createPendingImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "original.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

  // The live bug: on `main`, `deleteImages` never deletes `PurchaseImage`
  // rows before hard-deleting the image, so the DB rejects the delete with a
  // `PurchaseImage_imageId_fkey` violation instead of succeeding.

  // Mirrors the cookbook-cover cases above: reconstruct PENDING + a live
  // `PurchaseImage` row directly (the normal attach path always flips PENDING
  // -> UPLOADED in the same statement), to pin the guard against a future
  // write path reintroducing this combination.

  it("rechecks ownership after a concurrent attachment releases the image lock", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic concurrent image owner",
    });
    const photo = await createUploadedImageRecord(ctx.db, {
      key: "test/concurrent-share.jpg",
      filename: "concurrent-share.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    let reaping: Promise<unknown> | undefined;
    try {
      await withTransaction(ctx.db, async (holder) => {
        await holder
          .select({ id: image.id })
          .from(image)
          .where(eq(image.id, photo.id))
          .for("update");
        const holderPid = (
          await holder.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          )
        ).rows[0]!.pid;
        reaping = withTransaction(ctx.db, (tx) =>
          reapUnreferencedImages(tx, [photo.id]),
        ).catch((error: unknown) => error);
        await expect
          .poll(
            async () =>
              (
                await getDb(ctx.db).execute<{ waiting: boolean }>(sql`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND ${holderPid}::int = ANY(pg_blocking_pids(pid))) AS waiting`)
              ).rows[0]?.waiting,
            { timeout: 5000, interval: 20 },
          )
          .toBe(true);
        await associatePendingImages(
          holder,
          galleryBinding("project"),
          project.entityId,
          [parseEntityId("image", photo.id)],
        );
      });
    } finally {
      await reaping;
    }
    expect(await reaping).toMatchObject({ deletedIds: [], deletedKeys: [] });
    expect(
      await getDb(ctx.db).select().from(image).where(eq(image.id, photo.id)),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityAttachment)
        .where(eq(entityAttachment.imageId, photo.id)),
    ).toMatchObject([{ entityId: project.entityId }]);
  });

  it("serializes opposite singular replacements without deadlocking", async () => {
    const left = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic left logo",
    });
    const right = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic right logo",
    });
    const owner = await createRepoEntity(ctx, "project", {
      name: "Synthetic shared logo originals",
    });
    const first = await createOrReuseAttachedImage(
      ctx.db,
      {
        key: "test/left-logo.jpg",
        filename: "left.jpg",
        contentType: "image/jpeg",
        size: 1024,
      },
      { entity: "vendor", id: left.entityId },
    );
    const second = await createOrReuseAttachedImage(
      ctx.db,
      {
        key: "test/right-logo.jpg",
        filename: "right.jpg",
        contentType: "image/jpeg",
        size: 1024,
      },
      { entity: "vendor", id: right.entityId },
    );
    await insertEntityAttachments(ctx.db, {
      entityId: owner.entityId,
      imageId: first.row.id,
    });
    await insertEntityAttachments(ctx.db, {
      entityId: owner.entityId,
      imageId: second.row.id,
    });
    const results = await Promise.all([
      attachExistingImageToEntity(
        ctx.db,
        {
          imageId: parseShortcodeFor("image", second.row.shortcode),
          targetId: left.output.id,
          role: "logo",
        },
        ctx.actor,
      ),
      attachExistingImageToEntity(
        ctx.db,
        {
          imageId: parseShortcodeFor("image", first.row.shortcode),
          targetId: right.output.id,
          role: "logo",
        },
        ctx.actor,
      ),
    ]);
    expect(results).toEqual([{ reused: false }, { reused: false }]);
    const rows = await getDb(ctx.db)
      .select()
      .from(entityAttachment)
      .where(
        inArray(entityAttachment.entityId, [left.entityId, right.entityId]),
      );
    expect(rows.filter((row) => row.deletedAt === null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: left.entityId,
          imageId: second.row.id,
        }),
        expect.objectContaining({
          entityId: right.entityId,
          imageId: first.row.id,
        }),
      ]),
    );
  });

  it("replaces singular attachments atomically, preserves shared images, and deduplicates retries", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic logo supplier",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic shared image",
    });
    const target = { entity: "vendor", id: vendor.entityId } as const;
    const attach = (key: string, expectedImageCount: number) =>
      createOrReuseAttachedImage(
        ctx.db,
        {
          key: `test/${key}.jpg`,
          filename: `${key}.jpg`,
          contentType: "image/jpeg",
          size: 1024,
          idempotencyKey: key,
          expectedImageCount,
        },
        target,
      );
    const first = await attach("first-logo", 0);
    await insertEntityAttachments(ctx.db, {
      entityId: project.entityId,
      imageId: first.row.id,
    });
    const second = await attach("second-logo", 1);
    expect(second.detachedImageKeys).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(image)
        .where(eq(image.id, first.row.id)),
    ).toHaveLength(1);
    const retry = await attach("second-logo", 0);
    expect(retry.reused).toBe(true);
    expect(retry.row.id).toBe(second.row.id);
    await expect(attach("stale-logo", 0)).rejects.toThrow(
      "Expected 0 attached images, found 1",
    );
    const third = await attach("third-logo", 1);
    expect(third.detachedImageKeys).toEqual([second.row.key]);
    const active = await getDb(ctx.db)
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, vendor.entityId));
    expect(active.filter((row) => row.deletedAt === null)).toMatchObject([
      { role: "logo", imageId: third.row.id },
    ]);
    const book = await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic image book",
        rawJson: makeCookbookExtraction(),
        sourceLabel: "Synthetic book",
      },
      ctx.actor,
    );
    const cover = await createOrReuseAttachedImage(
      ctx.db,
      {
        key: "test/cover.jpg",
        filename: "cover.jpg",
        contentType: "image/jpeg",
        size: 1024,
      },
      { entity: "cookbook", id: book.entityId },
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityAttachment)
        .where(eq(entityAttachment.entityId, book.entityId)),
    ).toMatchObject([{ role: "cover", imageId: cover.row.id }]);
  });

  describe("detachImagesFromEntity", () => {
    const attachToProject = async (projectId: ProjectId, filename: string) =>
      (
        await createOrReuseAttachedImage(
          ctx.db,
          {
            key: `test/${crypto.randomUUID()}-${filename}`,
            filename,
            contentType: "image/jpeg",
            size: 1024,
          },
          { entity: "project", id: projectId },
        )
      ).row;

    const makeProject = async (name: string) =>
      (await createRepoEntity(ctx, "project", { name })).entityId;

    const rawImageRows = async (imageId: ImageId) =>
      await getDb(ctx.db).select().from(image).where(eq(image.id, imageId));

    it("deletes the file and returns its key when nothing else references it", async () => {
      const projectId = await makeProject("Detach Solo");
      const attached = await attachToProject(projectId, "solo.jpg");

      const result = await withTransaction(ctx.db, (tx) =>
        detachImagesFromEntity(tx, { entity: "project", id: projectId }, [
          parseEntityId("image", attached.id),
        ]),
      );

      expect(result.deletedIds).toEqual([attached.id]);
      expect(result.deletedKeys).toEqual([attached.key]);
      expect(await rawImageRows(attached.id)).toHaveLength(0);
    });

    it("keeps the file when a live join row on another entity still points at it", async () => {
      const projectA = await makeProject("Detach Shared A");
      const projectB = await makeProject("Detach Shared B");
      const attached = await attachToProject(projectA, "shared.jpg");
      await insertEntityAttachments(ctx.db, {
        entityId: projectB,
        imageId: attached.id,
      });

      const result = await withTransaction(ctx.db, (tx) =>
        detachImagesFromEntity(tx, { entity: "project", id: projectA }, [
          parseEntityId("image", attached.id),
        ]),
      );

      expect(result.deletedIds).toEqual([]);
      expect(await rawImageRows(attached.id)).toHaveLength(1);
    });

    /**
     * The `includes-deleted` decision, pinned. `deleteCookbook` tombstones the
     * row WITHOUT nulling `coverImageId`, so a soft-deleted cookbook still holds
     * a live FK — adding a `notDeleted(cookbook)` filter to the reference probe
     * would start destroying covers the row still points at.
     */

    /**
     * The opposite call for join rows: a tombstoned one is NOT a reference. Its
     * owning entity is gone (entity deletes cascade a soft delete onto it) and
     * nothing renders it, so the file goes — and the tombstone goes with it,
     * which is what keeps the FK from stranding.
     */
    it("reaps a file whose only other join row is soft-deleted, tombstone and all", async () => {
      const projectA = await makeProject("Detach Tombstone A");
      const projectB = await makeProject("Detach Tombstone B");
      const attached = await attachToProject(projectA, "tombstone.jpg");
      const [tombstoned] = await insertEntityAttachments(ctx.db, {
        entityId: projectB,
        imageId: attached.id,
        deletedAt: new Date(),
      });

      const result = await withTransaction(ctx.db, (tx) =>
        detachImagesFromEntity(tx, { entity: "project", id: projectA }, [
          parseEntityId("image", attached.id),
        ]),
      );

      expect(result.deletedIds).toEqual([attached.id]);
      expect(await rawImageRows(attached.id)).toHaveLength(0);
      expect(
        await getDb(ctx.db)
          .select()
          .from(entityAttachment)
          .where(eq(entityAttachment.id, tombstoned!.id)),
      ).toHaveLength(0);
    });
  });

  /**
   * The delete half of the same invariant. `removeEntity` cascades a SOFT delete
   * onto the join rows, so the association looks gone either way — only the
   * `Image` row itself, read UNFILTERED, tells a reaped file from an orphaned
   * one. These assert on the RETURNED keys rather than a mocked
   * `deleteS3Object`, because the keys are the contract: a caller that never
   * receives them cannot drop the object, and reaping the row without them makes
   * the key unrecoverable.
   */

  /**
   * The idempotency lookup names a candidate; the attachment still has to exist.
   * Constructed by hand rather than via a detach, so it keeps testing the gate
   * even though `detachImagesFromEntity` now deletes the row it detaches.
   */

  describe("imageScaffold.read reference-presence filter", () => {
    it("reports an unattached UPLOADED row and skips everything still spoken for", async () => {
      const projectId = (
        await createRepoEntity(ctx, "project", { name: "Unreferenced Sweep" })
      ).entityId;

      const orphan = await createUploadedImageRecord(ctx.db, {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "unref.jpg",
        contentType: "image/jpeg",
        size: 1024,
      });
      const attached = (
        await createOrReuseAttachedImage(
          ctx.db,
          {
            key: `test/${crypto.randomUUID()}.jpg`,
            filename: "attached.jpg",
            contentType: "image/jpeg",
            size: 1024,
          },
          { entity: "project", id: projectId },
        )
      ).row;
      const pending = await makePendingImage();
      const coverOnly = await createUploadedImageRecord(ctx.db, {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "book.jpg",
        contentType: "image/jpeg",
        size: 1024,
      });
      const { entityId: cookbookId } = await upsertCookbook(
        ctx.db,
        {
          name: "Sweep Book",
          rawJson: makeCookbookExtraction(),
          sourceLabel: "Sweep Book",
        },
        ctx.actor,
      );
      await insertEntityAttachments(ctx.db, {
        entityId: cookbookId,
        role: "cover",
        imageId: coverOnly.id,
      });
      // Deleting the book detaches its cover and reaps the unshared file.
      await deleteCookbook(ctx.db, cookbookId, ctx.actor);

      await getDb(ctx.db)
        .update(image)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(image.id, orphan.id));

      const listed = await imageScaffold.read(ctx.db, {
        filters: {
          status: "UPLOADED",
          referencePresenceFilter: "none",
          uploadedAgeHoursMin: 1,
        },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 100 },
      });

      // `imageScaffold.read` is a read API, so its rows carry shortcodes.
      expect(listed.data.map((row) => row.id)).toContain(orphan.shortcode);
      expect(listed.data.map((row) => row.id)).not.toContain(attached.id);
      expect(listed.data.map((row) => row.id)).not.toContain(pending.id);
      expect(listed.data.map((row) => row.id)).not.toContain(coverOnly.id);
    });
  });
});
