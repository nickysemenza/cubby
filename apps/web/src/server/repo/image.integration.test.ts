import type { ProjectId } from "@cubby/schemas/identifiers";
import {
  parseEntityId,
  parseShortcodeFor,
  userId,
} from "@cubby/schemas/identifiers";
import { getImageByIdSchema } from "@cubby/schemas/image";
import { projectCreateInput } from "@cubby/schemas/project";
import { generateShortcode } from "@cubby/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  cookbook,
  entityAttachment,
  image,
  importRun,
  importRunTarget,
  ledgerParty,
  user,
} from "~/server/db/schema";
import { makeCookbookExtraction } from "~/server/repo/repo.fixtures";
import { markImageUploadedWorkflow } from "~/server/workflows/image.server";

import { deleteCookbook, upsertCookbook } from "./cookbook";
import {
  associatePendingImages,
  getDb,
  imageJoinBindings,
  insertAndReturn,
  withTransaction,
} from "./database-helpers";
import {
  createOrReuseAttachedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  countCullablePendingImages,
  cullPendingImages,
  deleteImages,
  detachImagesFromEntity,
  imageList,
  getImageHashIndex,
  setImagePerceptualHashes,
} from "./image";
import { createProject } from "./project";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor } from "./vendor";

let importRunFixtureSeq = 0;
const uniqImportRunLabel = (label: string) =>
  `${label}-${(importRunFixtureSeq++).toString(36)}`;

/** Minimal live `LedgerParty`, for fixtures that only need a valid owner id. */
const mkLedgerParty = (db: Database) =>
  insertWithShortcode(db, "ledgerParty", {
    name: uniqImportRunLabel("Ledger party"),
    kind: "member",
  });

const mkActorUser = (db: Database) =>
  insertAndReturn(db, user, {
    id: uniqImportRunLabel("user"),
    name: "Import run fixture actor",
    email: `${uniqImportRunLabel("actor")}@example.test`,
  });

/**
 * A live `photo_inventory` `ImportRun`, with the actor snapshot columns the
 * table requires (mirrors `mkImportRun` in
 * `problems/detectors-integrity.integration.test.ts`, trimmed to what the
 * image-filter tests need).
 */
const mkPhotoInventoryRun = async (db: Database) => {
  const party = await mkLedgerParty(db);
  const [partySnapshot, actor] = await Promise.all([
    getDb(db)
      .select({
        shortcode: ledgerParty.shortcode,
        name: ledgerParty.name,
        kind: ledgerParty.kind,
      })
      .from(ledgerParty)
      .where(eq(ledgerParty.id, party.id))
      .then((rows) => rows[0]!),
    mkActorUser(db),
  ]);
  return insertAndReturn(db, importRun, {
    shortcode: generateShortcode("importRun"),
    purpose: "photo_inventory",
    trigger: "manual",
    ledgerPartyId: party.id,
    actorUserId: userId.parse(actor.id),
    actorName: actor.name,
    actorEmail: actor.email,
    actorLedgerPartyShortcode: partySnapshot.shortcode,
    actorLedgerPartyName: partySnapshot.name,
    actorLedgerPartyKind: partySnapshot.kind,
  });
};

const mkImportRunTargetRow = (
  db: Database,
  values: { runId: string; imageId: string; position?: number; state?: string },
) =>
  insertAndReturn(db, importRunTarget, {
    runId: values.runId,
    imageId: parseEntityId("image", values.imageId),
    position: values.position,
    state: values.state ?? "pending",
    targetFingerprint: uniqImportRunLabel("target-fingerprint"),
  });

describe("image repository", () => {
  const ctx = withTestDb();

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
    expect(
      index.repair.filter(({ id }) => ids.has(id)).map(({ id }) => id),
    ).toEqual([newer.shortcode, older.shortcode]);
  });

  it("resolves public image identity before marking an upload complete", async () => {
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "workflow-upload.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const input = getImageByIdSchema.parse({ id: pending.shortcode });
    expect(await markImageUploadedWorkflow(ctx.db, input)).toMatchObject({
      status: "UPLOADED",
    });
    await expect(markImageUploadedWorkflow(ctx.db, input)).rejects.toThrow(
      "Failed to update record",
    );
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
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Idempotent photo project" }),
        ctx.actor,
      )
    ).entityId;
    const pending = await createPendingImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "retry.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const imageId = parseEntityId("image", pending.id);
    const dbc = getDb(ctx.db);
    await associatePendingImages(dbc, imageJoinBindings.project, projectId, [
      imageId,
      imageId,
    ]);
    await associatePendingImages(
      dbc,
      imageJoinBindings.project,
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
    await associatePendingImages(dbc, imageJoinBindings.project, projectId, [
      imageId,
      appendedId,
    ]);

    expect(
      (
        await dbc
          .select()
          .from(entityAttachment)
          .where(eq(entityAttachment.subjectEntityId, projectId))
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
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Unavailable photo project" }),
        ctx.actor,
      )
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
      associatePendingImages(dbc, imageJoinBindings.project, projectId, ids),
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
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Pending photo cleanup project" }),
        ctx.actor,
      )
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
      imageJoinBindings.project,
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

  /**
   * `Cookbook.coverImageId` and `Vendor.logoImageId` are declared `clearFk` in
   * IMAGE_HARD_DELETE: nulled before the Image row goes, so the parent survives
   * without its cover. Nothing exercised either — every other test here that
   * touches those columns drives the pending-image cull, not `deleteImages`.
   *
   * Both are plain `references(() => image.id)` with no `onDelete`, so Postgres
   * defaults to NO ACTION. A regression therefore fails LOUD — the FK violation
   * rolls the transaction back — which is why this ranks below the fail-open
   * statement-row guard. It is still the exact shape this file's own comment
   * says already happened once for `PurchaseImage`, so the assertion is on the
   * promise RESOLVING as much as on the columns reading null.
   */
  it("clears cookbook covers and vendor logos before hard-deleting the image", async () => {
    const cover = await createUploadedImageRecord(ctx.db, {
      key: `covers/${crypto.randomUUID()}.jpg`,
      filename: "fk-clear-cover.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const logo = await createUploadedImageRecord(ctx.db, {
      key: `vendors/${crypto.randomUUID()}.png`,
      filename: "fk-clear-logo.png",
      contentType: "image/png",
      size: 512,
    });
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      {
        name: "FK Clear Book",
        rawJson: makeCookbookExtraction(),
        author: [],
        sourceLabel: "FK Clear Book.epub",
      },
      ctx.actor,
    );
    await getDb(ctx.db).insert(entityAttachment).values({
      subjectEntityId: cookbookId,
      role: "cover",
      imageId: cover.id,
    });
    const vendorId = await findOrCreateVendor(ctx.db, "FK Clear Vendor");
    await getDb(ctx.db).insert(entityAttachment).values({
      subjectEntityId: vendorId,
      role: "logo",
      imageId: logo.id,
    });

    await expect(
      deleteImages(ctx.db, [
        parseEntityId("image", cover.id),
        parseEntityId("image", logo.id),
      ]),
    ).resolves.toBeDefined();

    // The associations go with the image; the cookbook and vendor survive.
    expect(
      await getDb(ctx.db)
        .select({ id: entityAttachment.id })
        .from(entityAttachment)
        .where(
          inArray(entityAttachment.subjectEntityId, [cookbookId, vendorId]),
        ),
    ).toEqual([]);
    expect(
      await getDb(ctx.db).query.cookbook.findFirst({
        where: eq(cookbook.id, cookbookId),
        columns: { deletedAt: true },
      }),
    ).toEqual({ deletedAt: null });
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

  it("filters images by importRunId and targetState", async () => {
    const run = await mkPhotoInventoryRun(ctx.db);
    const otherRun = await mkPhotoInventoryRun(ctx.db);
    const pendingImage = await makeImage("run-pending.jpg");
    const preparedImage = await makeImage("run-prepared.jpg");
    const otherRunImage = await makeImage("other-run.jpg");
    const untargetedImage = await makeImage("untargeted.jpg");

    await mkImportRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: pendingImage.id,
      position: 1,
      state: "pending",
    });
    await mkImportRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: preparedImage.id,
      position: 2,
      state: "prepared",
    });
    await mkImportRunTargetRow(ctx.db, {
      runId: otherRun.id,
      imageId: otherRunImage.id,
      position: 1,
      state: "pending",
    });

    const runCode = parseShortcodeFor("importRun", run.shortcode);
    const byRun = await imageList(ctx.db, { importRunId: runCode }, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    const byRunIds = byRun.data.map((row) => row.id);
    expect(byRunIds).toContain(pendingImage.shortcode);
    expect(byRunIds).toContain(preparedImage.shortcode);
    expect(byRunIds).not.toContain(otherRunImage.shortcode);
    expect(byRunIds).not.toContain(untargetedImage.shortcode);

    const byRunAndState = await imageList(
      ctx.db,
      { importRunId: runCode, targetState: "pending" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    const byRunAndStateIds = byRunAndState.data.map((row) => row.id);
    expect(byRunAndStateIds).toContain(pendingImage.shortcode);
    expect(byRunAndStateIds).not.toContain(preparedImage.shortcode);

    const byStateAlone = await imageList(
      ctx.db,
      { targetState: ["pending"] },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
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

  it("orders a run's images by ImportRunTarget.position, then createdAt", async () => {
    const run = await mkPhotoInventoryRun(ctx.db);
    const first = await makeImage("position-first.jpg");
    const second = await makeImage("position-second.jpg");
    const third = await makeImage("position-third.jpg");

    // Inserted out of position order, so a pass without the position ORDER BY
    // would come back in this insertion/createdAt order instead.
    await mkImportRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: third.id,
      position: 3,
    });
    await mkImportRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: first.id,
      position: 1,
    });
    await mkImportRunTargetRow(ctx.db, {
      runId: run.id,
      imageId: second.id,
      position: 2,
    });

    const listed = await imageList(
      ctx.db,
      { importRunId: parseShortcodeFor("importRun", run.shortcode) },
      [],
      { pageIndex: 0, pageSize: 100 },
    );

    expect(listed.data.map((row) => row.id)).toEqual([
      first.shortcode,
      second.shortcode,
      third.shortcode,
    ]);
  });
});

// `PurchaseImage` is a charge's documents — the emailed PDF invoice or a photo
// of the paper slip (see purchase.ts / the `Vendor -> Purchase -> Expense`
// split). It was added as a new incoming FK edge on `image`, but three of its
// consumers in image.ts were never updated to know about it: `deleteImages`
// (missing the join-row delete -> a raw `PurchaseImage_imageId_fkey`
// violation, a 500 on `/images`), `imageEntityRelations`/
// `imageWithRelationsToAPI` (missing the relation/branch -> a charge document
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
      (
        await createProject(
          ctx.db,
          projectCreateInput.parse({ name }),
          ctx.actor,
        )
      ).entityId;

    const rawImageRows = async (imageId: string) =>
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
      await insertAndReturn(ctx.db, entityAttachment, {
        subjectEntityId: projectB,
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
      const [tombstoned] = await getDb(ctx.db)
        .insert(entityAttachment)
        .values({
          subjectEntityId: projectB,
          imageId: attached.id,
          deletedAt: new Date(),
        })
        .returning();

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

  describe("imageList reference-presence filter", () => {
    it("reports an unattached UPLOADED row and skips everything still spoken for", async () => {
      const projectId = (
        await createProject(
          ctx.db,
          projectCreateInput.parse({ name: "Unreferenced Sweep" }),
          ctx.actor,
        )
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
      await getDb(ctx.db).insert(entityAttachment).values({
        subjectEntityId: cookbookId,
        role: "cover",
        imageId: coverOnly.id,
      });
      // Deleting the book detaches its cover and reaps the unshared file.
      await deleteCookbook(ctx.db, cookbookId, ctx.actor);

      await getDb(ctx.db)
        .update(image)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(image.id, orphan.id));

      const listed = await imageList(
        ctx.db,
        {
          status: "UPLOADED",
          referencePresenceFilter: "none",
          uploadedAgeHoursMin: 1,
        },
        [],
        { pageIndex: 0, pageSize: 100 },
      );

      // `imageList` is a read API, so its rows carry shortcodes.
      expect(listed.data.map((row) => row.id)).toContain(orphan.shortcode);
      expect(listed.data.map((row) => row.id)).not.toContain(attached.id);
      expect(listed.data.map((row) => row.id)).not.toContain(pending.id);
      expect(listed.data.map((row) => row.id)).not.toContain(coverOnly.id);
    });
  });
});
