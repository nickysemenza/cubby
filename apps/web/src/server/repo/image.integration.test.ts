import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { cookbook } from "~/server/db/schema";
import { deleteCookbook, upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import {
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  getImageById,
  markImageUploaded,
  updateImage,
} from "./image";

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
