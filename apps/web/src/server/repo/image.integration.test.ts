import type { ProjectId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { projectCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  cookbook,
  image,
  projectImage,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";
import { deleteCookbook, upsertCookbook } from "./cookbook";
import { getDb, insertAndReturn, withTransaction } from "./database-helpers";
import {
  countCullablePendingImages,
  countUnreferencedImages,
  createAndAssociateUploadedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  deleteImages,
  detachImagesFromEntity,
  findAttachmentByIdempotencyKey,
  findUnreferencedImages,
  getImageById,
  getImagesByProjectIds,
  imageList,
  markImageUploaded,
  updateImage,
} from "./image";
import { createProject, deleteProjects, getProjectByID } from "./project";
import { createPurchase } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor, getVendorByID } from "./vendor";

describe("image repository", () => {
  const ctx = withTestDb();

  const makePendingImage = async (overrides?: { filename?: string }) =>
    createPendingImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: overrides?.filename ?? "original.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

  it("renames an image and leaves every other column untouched", async () => {
    const created = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "original.jpg",
      contentType: "image/jpeg",
      size: 2048,
    });

    const updated = await updateImage(ctx.db, created.id, {
      filename: "renamed.jpg",
    });

    expect(updated.filename).toEqual("renamed.jpg");
    expect(updated.key).toEqual(created.key);
    expect(updated.url).toEqual(getR2PublicUrl(created.key));
    expect(updated.size).toEqual(created.size);
    expect(updated.contentType).toEqual(created.contentType);
    expect(updated.status).toEqual(created.status);
  });

  it("throws for an unknown image id", async () => {
    await expect(
      updateImage(ctx.db, "00000000-0000-0000-0000-000000000000", {
        filename: "nope.jpg",
      }),
    ).rejects.toThrow();
  });

  it("returns every direct vendor-logo association for a shared image", async () => {
    const logo = await createUploadedImageRecord(ctx.db, {
      key: `vendors/${crypto.randomUUID()}.png`,
      filename: "shared-logo.png",
      contentType: "image/png",
      size: 1024,
    });
    const firstId = await findOrCreateVendor(ctx.db, "Shared Image Vendor A");
    const secondId = await findOrCreateVendor(ctx.db, "Shared Image Vendor B");
    await getDb(ctx.db)
      .update(vendor)
      .set({ logoImageId: logo.id })
      .where(eq(vendor.id, firstId));
    await getDb(ctx.db)
      .update(vendor)
      .set({ logoImageId: logo.id })
      .where(eq(vendor.id, secondId));

    const found = await getImageById(ctx.db, logo.id);
    const { associations } = found;

    expect(associations).toEqual([
      expect.objectContaining({
        entityType: "vendor",
        entityName: "Shared Image Vendor A",
        role: "logo",
      }),
      expect.objectContaining({
        entityType: "vendor",
        entityName: "Shared Image Vendor B",
        role: "logo",
      }),
    ]);
    expect(associations.map(({ entityId }) => entityId)).toEqual([
      (await getVendorByID(ctx.db, firstId)).id,
      (await getVendorByID(ctx.db, secondId)).id,
    ]);
  });

  it("markImageUploaded flips PENDING to UPLOADED, and the row is then not returned by the pending cull", async () => {
    const pending = await makePendingImage();
    expect(pending.status).toEqual("PENDING");

    const updated = await markImageUploaded(ctx.db, pending.id);
    expect(updated.status).toEqual("UPLOADED");

    const reread = await getImageById(ctx.db, pending.id);
    expect(reread.status).toEqual("UPLOADED");

    // The finalize step is what protects a standalone upload from the
    // pending-image cull: an unfinalized (still-PENDING) row with no entity
    // association is exactly what the cull selects and deletes (R2 object
    // included). A row that has already been marked UPLOADED must survive it,
    // even though it still has no entity association.
    const culled = await cullPendingImages(ctx.db, 0);
    expect(culled.deletedIds).not.toContain(pending.id);

    const stillThere = await getImageById(ctx.db, pending.id);
    expect(stillThere.status).toEqual("UPLOADED");
  });

  it("markImageUploaded is scoped to PENDING rows and cannot resurrect a FAILED/already-UPLOADED row", async () => {
    const uploaded = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "already.jpg",
      contentType: "image/jpeg",
      size: 512,
    });

    await expect(markImageUploaded(ctx.db, uploaded.id)).rejects.toThrow();
  });

  it("returns displayable project covers in cover order", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Project covers" }),
      ctx.actor,
    );
    const pdf = await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}.pdf`,
      filename: "project.pdf",
      contentType: "application/pdf",
      size: 1024,
    });
    const failed = await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}-failed.jpg`,
      filename: "failed.jpg",
      contentType: "image/jpeg",
      size: 1024,
      renderStatus: "failed",
    });
    const cover = await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}-cover.jpg`,
      filename: "cover.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: project.entityId,
      imageId: pdf.id,
      sortOrder: -2,
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: project.entityId,
      imageId: failed.id,
      sortOrder: -1,
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: project.entityId,
      imageId: cover.id,
    });

    await expect(
      getImagesByProjectIds(ctx.db, [project.entityId]),
    ).resolves.toEqual({
      [project.entityId]: [
        {
          id: parseShortcodeFor("image", cover.shortcode),
          url: getR2PublicUrl(cover.key),
          filename: "cover.jpg",
        },
      ],
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
  it("a PENDING image referenced only by a live cookbook's coverImageId survives the pending cull", async () => {
    const pending = await makePendingImage();
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Cover Test Book", rawJson: [], sourceLabel: "Cover Test Book" },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(cookbook)
      .set({ coverImageId: pending.id })
      .where(eq(cookbook.id, cookbookId));

    const culled = await cullPendingImages(ctx.db, 0);
    expect(culled.deletedIds).not.toContain(pending.id);

    const stillThere = await getImageById(ctx.db, pending.id);
    expect(stillThere.status).toEqual("PENDING");
    expect(stillThere.associations).toEqual([
      expect.objectContaining({
        entityType: "cookbook",
        entityName: "Cover Test Book",
        role: "cover",
      }),
    ]);
  });

  it("counts exactly the pending rows the cull would remove", async () => {
    const cullable = await makePendingImage();
    const protectedImage = await makePendingImage();
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Pending Count Book", rawJson: [], sourceLabel: "Count Book" },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(cookbook)
      .set({ coverImageId: protectedImage.id })
      .where(eq(cookbook.id, cookbookId));

    const count = await countCullablePendingImages(ctx.db, 0);
    const culled = await cullPendingImages(ctx.db, 0);

    expect(culled.count).toBe(count);
    expect(culled.deletedIds).toContain(cullable.id);
    expect(culled.deletedIds).not.toContain(protectedImage.id);
  });

  it("keeps a PENDING image referenced only by a tombstoned join row", async () => {
    const protectedImage = await makePendingImage();
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Deleted image attachment project" }),
      ctx.actor,
    );
    await insertAndReturn(ctx.db, projectImage, {
      projectId: project.entityId,
      imageId: protectedImage.id,
      deletedAt: new Date(),
    });

    const count = await countCullablePendingImages(ctx.db, 0);
    const culled = await cullPendingImages(ctx.db, 0);

    expect(culled.count).toBe(count);
    expect(culled.deletedIds).not.toContain(protectedImage.id);
    expect((await getImageById(ctx.db, protectedImage.id)).status).toBe(
      "PENDING",
    );
  });

  // The non-obvious half of the guard above: deleteCookbook tombstones the
  // Cookbook row (deletedAt set) WITHOUT nulling coverImageId, so a soft-deleted
  // cookbook still holds a live FK to the image. findCullablePendingImages is
  // deliberately NOT filtered by notDeleted(cookbook) — filtering it would cull
  // exactly the images that then blow up the hard-delete on
  // Cookbook_coverImageId_fkey.
  it("a PENDING image referenced by a SOFT-DELETED cookbook's coverImageId also survives the pending cull", async () => {
    const pending = await makePendingImage();
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      {
        name: "Deleted Cover Test Book",
        rawJson: [],
        sourceLabel: "Deleted Cover Test Book",
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(cookbook)
      .set({ coverImageId: pending.id })
      .where(eq(cookbook.id, cookbookId));

    await deleteCookbook(ctx.db, cookbookId, ctx.actor);
    const [row] = await getDb(ctx.db)
      .select({
        deletedAt: cookbook.deletedAt,
        coverImageId: cookbook.coverImageId,
      })
      .from(cookbook)
      .where(eq(cookbook.id, cookbookId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.coverImageId).toBe(pending.id);

    const culled = await cullPendingImages(ctx.db, 0);
    expect(culled.deletedIds).not.toContain(pending.id);

    const stillThere = await getImageById(ctx.db, pending.id);
    expect(stillThere.status).toEqual("PENDING");
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

  const makePurchase = async (orderId: string | null = null) => {
    const vendorId = await findOrCreateVendor(ctx.db, "PurchaseImage Test Co");
    const vendor = await getVendorByID(ctx.db, vendorId);
    // The FK plumbing below is keyed by the private uuid, which the repo hands
    // back alongside the public row — no second lookup needed.
    const { output: charge, entityId } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: vendor.id,
        orderId,
      }),
      ctx.actor,
    );
    return { ...charge, uuid: entityId };
  };

  // The live bug: on `main`, `deleteImages` never deletes `PurchaseImage`
  // rows before hard-deleting the image, so the DB rejects the delete with a
  // `PurchaseImage_imageId_fkey` violation instead of succeeding.
  it("deleteImages removes an image attached to a purchase, and its PurchaseImage row", async () => {
    const charge = await makePurchase("PO-1001");
    const uploaded = await createAndAssociateUploadedImage(
      ctx.db,
      {
        key: `test-documents/${crypto.randomUUID()}.pdf`,
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 4096,
      },
      "purchase",
      charge.uuid,
    );

    const result = await deleteImages(ctx.db, [
      parseEntityId("image", uploaded.id),
    ]);
    expect(result.deletedIds).toEqual([uploaded.id]);

    const [joinRow] = await getDb(ctx.db)
      .select({ id: purchaseImage.id })
      .from(purchaseImage)
      .where(eq(purchaseImage.imageId, uploaded.id));
    expect(joinRow).toBeUndefined();

    const [imageRow] = await getDb(ctx.db)
      .select({ id: image.id })
      .from(image)
      .where(eq(image.id, uploaded.id));
    expect(imageRow).toBeUndefined();
  });

  // Mirrors the cookbook-cover cases above: reconstruct PENDING + a live
  // `PurchaseImage` row directly (the normal attach path always flips PENDING
  // -> UPLOADED in the same statement), to pin the guard against a future
  // write path reintroducing this combination.
  it("a PENDING image referenced only by a purchase's PurchaseImage row survives the pending cull", async () => {
    const charge = await makePurchase();
    const pending = await makePendingImage();
    await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId: charge.uuid,
      imageId: pending.id,
    });

    const culled = await cullPendingImages(ctx.db, 0);
    expect(culled.deletedIds).not.toContain(pending.id);

    const stillThere = await getImageById(ctx.db, pending.id);
    expect(stillThere.status).toEqual("PENDING");
  });

  describe("detachImagesFromEntity", () => {
    const attachToProject = async (projectId: ProjectId, filename: string) =>
      await createAndAssociateUploadedImage(
        ctx.db,
        {
          key: `test/${crypto.randomUUID()}-${filename}`,
          filename,
          contentType: "image/jpeg",
          size: 1024,
        },
        "project",
        projectId,
      );

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
      await insertAndReturn(ctx.db, projectImage, {
        projectId: projectB,
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
    it("keeps a cookbook cover even after the cookbook is soft-deleted", async () => {
      const projectId = await makeProject("Detach Cover");
      const attached = await attachToProject(projectId, "cover.jpg");
      const { entityId: cookbookId } = await upsertCookbook(
        ctx.db,
        {
          name: "Detach Cover Book",
          rawJson: [],
          sourceLabel: "Detach Cover Book",
        },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(cookbook)
        .set({ coverImageId: attached.id })
        .where(eq(cookbook.id, cookbookId));
      await deleteCookbook(ctx.db, cookbookId, ctx.actor);

      const result = await withTransaction(ctx.db, (tx) =>
        detachImagesFromEntity(tx, { entity: "project", id: projectId }, [
          parseEntityId("image", attached.id),
        ]),
      );

      expect(result.deletedIds).toEqual([]);
      expect(await rawImageRows(attached.id)).toHaveLength(1);
    });

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
        .insert(projectImage)
        .values({
          projectId: projectB,
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
          .from(projectImage)
          .where(eq(projectImage.id, tombstoned!.id)),
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
  describe("removeEntity reaps images its cascade orphaned", () => {
    const rawImageRows = async (imageId: string) =>
      await getDb(ctx.db).select().from(image).where(eq(image.id, imageId));

    const makeProjectWithImage = async (name: string) => {
      const projectId = (
        await createProject(
          ctx.db,
          projectCreateInput.parse({ name }),
          ctx.actor,
        )
      ).entityId;
      const attached = await createAndAssociateUploadedImage(
        ctx.db,
        {
          key: `test/${crypto.randomUUID()}.jpg`,
          filename: "doomed.jpg",
          contentType: "image/jpeg",
          size: 1024,
        },
        "project",
        projectId,
      );
      return { projectId, attached };
    };

    it("deletes the file and hands back its key", async () => {
      const { projectId, attached } = await makeProjectWithImage("Doomed Proj");

      const { detachedImageKeys } = await deleteProjects(
        ctx.db,
        [(await getProjectByID(ctx.db, projectId))!.id],
        ctx.actor,
      );

      expect(detachedImageKeys).toEqual([attached.key]);
      expect(await rawImageRows(attached.id)).toHaveLength(0);
    });

    it("keeps a file the deleted entity was not the last to reference", async () => {
      const { projectId, attached } =
        await makeProjectWithImage("Doomed Share");
      const survivorId = (
        await createProject(
          ctx.db,
          projectCreateInput.parse({ name: "Surviving Proj" }),
          ctx.actor,
        )
      ).entityId;
      await insertAndReturn(ctx.db, projectImage, {
        projectId: survivorId,
        imageId: attached.id,
      });

      const { detachedImageKeys } = await deleteProjects(
        ctx.db,
        [(await getProjectByID(ctx.db, projectId))!.id],
        ctx.actor,
      );

      expect(detachedImageKeys).toEqual([]);
      expect(await rawImageRows(attached.id)).toHaveLength(1);
    });
  });

  /**
   * The idempotency lookup names a candidate; the attachment still has to exist.
   * Constructed by hand rather than via a detach, so it keeps testing the gate
   * even though `detachImagesFromEntity` now deletes the row it detaches.
   */
  it("findAttachmentByIdempotencyKey ignores a targeted row with no live attachment", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Idempotency Liveness" }),
      ctx.actor,
    );
    const orphan = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "orphan.jpg",
      contentType: "image/jpeg",
      size: 1024,
      targetType: "project",
      targetId: project.entityId,
      idempotencyKey: "enrichment:v1",
    });

    await expect(
      findAttachmentByIdempotencyKey(
        ctx.db,
        "project",
        project.entityId,
        "enrichment:v1",
      ),
    ).resolves.toBeNull();

    // The row itself is untouched — the gate narrows the lookup, it does not
    // clean up. That is `findUnreferencedImages`' job. The repo takes the uuid
    // and hands back the public `IMG-` code, so the two sides differ by design.
    expect((await getImageById(ctx.db, orphan.id)).id).toEqual(
      orphan.shortcode,
    );
  });

  describe("findUnreferencedImages", () => {
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
      const attached = await createAndAssociateUploadedImage(
        ctx.db,
        {
          key: `test/${crypto.randomUUID()}.jpg`,
          filename: "attached.jpg",
          contentType: "image/jpeg",
          size: 1024,
        },
        "project",
        projectId,
      );
      const pending = await makePendingImage();
      const coverOnly = await createUploadedImageRecord(ctx.db, {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "book.jpg",
        contentType: "image/jpeg",
        size: 1024,
      });
      const { entityId: cookbookId } = await upsertCookbook(
        ctx.db,
        { name: "Sweep Book", rawJson: [], sourceLabel: "Sweep Book" },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(cookbook)
        .set({ coverImageId: coverOnly.id })
        .where(eq(cookbook.id, cookbookId));
      await deleteCookbook(ctx.db, cookbookId, ctx.actor);

      await getDb(ctx.db)
        .update(image)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(image.id, orphan.id));

      const found = (await findUnreferencedImages(ctx.db)).map((r) => r.id);
      expect(await countUnreferencedImages(ctx.db)).toBe(found.length);
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

      expect(found).toContain(orphan.id);
      expect(found).not.toContain(attached.id);
      expect(found).not.toContain(pending.id);
      expect(found).not.toContain(coverOnly.id);
      // `imageList` is a read API, so its rows carry shortcodes; the raw uuid
      // stays inside `findUnreferencedImages`, which feeds `deleteImages`.
      expect(listed.data.map((row) => row.id)).toContain(orphan.shortcode);
      expect(listed.data.map((row) => row.id)).not.toContain(attached.id);
      expect(listed.data.map((row) => row.id)).not.toContain(pending.id);
      expect(listed.data.map((row) => row.id)).not.toContain(coverOnly.id);
    });

    it("leaves a just-created row alone until the grace window passes", async () => {
      const fresh = await createUploadedImageRecord(ctx.db, {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "fresh.jpg",
        contentType: "image/jpeg",
        size: 1024,
      });

      // The default window — an import that associates in a separate step must
      // not be reaped out from under itself mid-flight.
      const found = await findUnreferencedImages(ctx.db);

      expect(found.map((r) => r.id)).not.toContain(fresh.id);
    });
  });

  it("getImageById resolves a purchase-attached image to entityType PURCHASE", async () => {
    const charge = await makePurchase("PO-2002");
    const uploaded = await createAndAssociateUploadedImage(
      ctx.db,
      {
        key: `test-documents/${crypto.randomUUID()}.pdf`,
        filename: "invoice-2.pdf",
        contentType: "application/pdf",
        size: 2048,
      },
      "purchase",
      charge.uuid,
    );

    const found = await getImageById(ctx.db, uploaded.id);
    expect(found.entityType).toEqual("PURCHASE");
    expect(found.entityId).toEqual(charge.id);
    expect(found.entityName).toEqual("PO-2002");
  });
});
