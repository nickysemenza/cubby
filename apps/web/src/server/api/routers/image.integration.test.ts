import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { deleteImages, getImageById } from "~/server/repo/image";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/**
 * Image hard-delete behavior is now exercised at the repository boundary;
 * browser mutations use the dedicated Start transport.
 */
describe("image delete", () => {
  const ctx = withTestDb();

  const seedImage = async (filename: string) =>
    await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: `https://example.test/${filename}`,
      filename,
      contentType: "image/jpeg",
      size: 1024,
      status: "UPLOADED",
    });

  const stillExists = async (id: string) =>
    await getImageById(ctx.db, id).then(
      () => true,
      () => false,
    );

  it("deletes by the IMG- code the list and detail pages hand back", async () => {
    const row = await seedImage("deletable.jpg");

    const result = await deleteImages(ctx.db, [unsafeImageId(row.id)]);

    expect(result.deletedIds).toHaveLength(1);
    expect(await stillExists(row.id)).toBe(false);
  });

  it("deletes a multi-row selection, as bulk table delete does", async () => {
    const first = await seedImage("bulk-one.jpg");
    const second = await seedImage("bulk-two.jpg");

    const result = await deleteImages(ctx.db, [
      unsafeImageId(first.id),
      unsafeImageId(second.id),
    ]);

    expect(result.deletedIds).toHaveLength(2);
    expect(await stillExists(first.id)).toBe(false);
    expect(await stillExists(second.id)).toBe(false);
  });
});

import { unsafeImageId } from "@cubby/schemas/identifiers";
