import { unsafePurchaseId } from "@cubby/schemas/identifiers";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { cookbook, image, purchaseImage } from "~/server/db/schema";
import { deleteCookbook, upsertCookbook } from "./cookbook";
import { getDb, insertAndReturn } from "./database-helpers";
import {
  createAndAssociateUploadedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  deleteImages,
  getImageById,
  markImageUploaded,
  updateImage,
} from "./image";
import { createPurchase } from "./purchase";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { findOrCreateVendor, getVendorByID } from "./vendor";

describe("image repository", () => {
  const ctx = withTestDb();

  const makePendingImage = async (overrides?: { filename?: string }) =>
    createPendingImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: "https://example.com/test.jpg",
      filename: overrides?.filename ?? "original.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

  it("renames an image and leaves every other column untouched", async () => {
    const created = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: "https://example.com/original.jpg",
      filename: "original.jpg",
      contentType: "image/jpeg",
      size: 2048,
    });

    const updated = await updateImage(ctx.db, created.id, {
      filename: "renamed.jpg",
    });

    expect(updated.filename).toEqual("renamed.jpg");
    // Derived columns are untouched.
    expect(updated.key).toEqual(created.key);
    expect(updated.url).toEqual(created.url);
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
      url: "https://example.com/already.jpg",
      filename: "already.jpg",
      contentType: "image/jpeg",
      size: 512,
    });

    await expect(markImageUploaded(ctx.db, uploaded.id)).rejects.toThrow();
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
    const { id: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Cover Test Book", rawJson: [], sourceLabel: "Cover Test Book" },
      ctx.actor,
    );
    // Bypass upsertCookbook's normal coverImageId path (which would flip the
    // image to UPLOADED) to reconstruct the PENDING+cover state directly.
    await getDb(ctx.db)
      .update(cookbook)
      .set({ coverImageId: pending.id })
      .where(eq(cookbook.id, cookbookId));

    const culled = await cullPendingImages(ctx.db, 0);
    expect(culled.deletedIds).not.toContain(pending.id);

    const stillThere = await getImageById(ctx.db, pending.id);
    expect(stillThere.status).toEqual("PENDING");
  });

  // The non-obvious half of the guard above: deleteCookbook tombstones the
  // Cookbook row (deletedAt set) WITHOUT nulling coverImageId, so a soft-deleted
  // cookbook still holds a live FK to the image. findCullablePendingImages is
  // deliberately NOT filtered by notDeleted(cookbook) — filtering it would cull
  // exactly the images that then blow up the hard-delete on
  // Cookbook_coverImageId_fkey.
  it("a PENDING image referenced by a SOFT-DELETED cookbook's coverImageId also survives the pending cull", async () => {
    const pending = await makePendingImage();
    const { id: cookbookId } = await upsertCookbook(
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
      url: "https://example.com/test.jpg",
      filename: "original.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

  const makePurchase = async (orderId: string | null = null) => {
    const vendorId = await findOrCreateVendor(ctx.db, "PurchaseImage Test Co");
    const vendor = await getVendorByID(ctx.db, vendorId);
    const charge = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: vendor.id, orderId }),
      ctx.actor,
    );
    // Entity-attachment/FK plumbing below needs the real uuid, not the
    // public shortcode `createPurchase` returns as `.id`.
    const resolved = await resolveLiveShortcode(ctx.db, charge.id, "purchase");
    if (!resolved) throw new Error("purchase not found after create");
    return { ...charge, uuid: unsafePurchaseId(resolved) };
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
        url: "https://example.com/invoice.pdf",
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 4096,
      },
      "purchase",
      charge.uuid,
    );

    const result = await deleteImages(ctx.db, [uploaded.id]);
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

  it("getImageById resolves a purchase-attached image to entityType PURCHASE", async () => {
    const charge = await makePurchase("PO-2002");
    const uploaded = await createAndAssociateUploadedImage(
      ctx.db,
      {
        key: `test-documents/${crypto.randomUUID()}.pdf`,
        url: "https://example.com/invoice-2.pdf",
        filename: "invoice-2.pdf",
        contentType: "application/pdf",
        size: 2048,
      },
      "purchase",
      charge.uuid,
    );

    const found = await getImageById(ctx.db, uploaded.id);
    expect(found.entityType).toEqual("PURCHASE");
    expect(found.entityId).toEqual(charge.uuid);
    expect(found.entityName).toEqual("PO-2002");
  });
});
