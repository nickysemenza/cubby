import type { ProjectId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { getImageByIdSchema } from "@cubby/schemas/image";
import { projectCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { cookbook, image, projectImage, vendor } from "~/server/db/schema";
import { makeCookbookExtraction } from "~/server/repo/repo.fixtures";
import { markImageUploadedWorkflow } from "~/server/workflows/image.server";

import { deleteCookbook, upsertCookbook } from "./cookbook";
import { getDb, insertAndReturn, withTransaction } from "./database-helpers";
import {
  countUnreferencedImages,
  createAndAssociateUploadedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  deleteImages,
  detachImagesFromEntity,
  findUnreferencedImages,
  imageList,
} from "./image";
import { createProject } from "./project";
import { findOrCreateVendor } from "./vendor";

describe("image repository", () => {
  const ctx = withTestDb();

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
    await getDb(ctx.db)
      .update(cookbook)
      .set({ coverImageId: cover.id })
      .where(eq(cookbook.id, cookbookId));
    const vendorId = await findOrCreateVendor(ctx.db, "FK Clear Vendor");
    await getDb(ctx.db)
      .update(vendor)
      .set({ logoImageId: logo.id })
      .where(eq(vendor.id, vendorId));

    await expect(
      deleteImages(ctx.db, [
        parseEntityId("image", cover.id),
        parseEntityId("image", logo.id),
      ]),
    ).resolves.toBeDefined();

    const [book] = await getDb(ctx.db)
      .select({ coverImageId: cookbook.coverImageId })
      .from(cookbook)
      .where(eq(cookbook.id, cookbookId));
    expect(book).toBeDefined();
    expect(book?.coverImageId).toBeNull();

    const [vendorRow] = await getDb(ctx.db)
      .select({ logoImageId: vendor.logoImageId })
      .from(vendor)
      .where(eq(vendor.id, vendorId));
    expect(vendorRow).toBeDefined();
    expect(vendorRow?.logoImageId).toBeNull();
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
      await createAndAssociateUploadedImage(
        ctx.db,
        {
          key: `test/${crypto.randomUUID()}-${filename}`,
          filename,
          contentType: "image/jpeg",
          size: 1024,
        },
        { entity: "project", id: projectId },
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

  /**
   * The idempotency lookup names a candidate; the attachment still has to exist.
   * Constructed by hand rather than via a detach, so it keeps testing the gate
   * even though `detachImagesFromEntity` now deletes the row it detaches.
   */

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
        { entity: "project", id: projectId },
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
        {
          name: "Sweep Book",
          rawJson: makeCookbookExtraction(),
          sourceLabel: "Sweep Book",
        },
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
  });
});
