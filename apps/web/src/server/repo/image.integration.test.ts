import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
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
});
