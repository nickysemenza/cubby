import { unsafeImageShortcode } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getImageById } from "~/server/repo/image";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestCaller } from "../trpc";
import { imageRouter } from "./image";

/**
 * Router-level, not repo-level, because the bug this guards lives exactly at
 * the boundary: `imageWithEntitySchema` hands the table and detail page an
 * `IMG-` code, while `deleteImagesWithStorage` keys on `Image.id`. Every repo
 * test passes uuids directly and so cannot see the mismatch.
 *
 * `createDeleteProcedure` infers its id type from the callback and then casts,
 * so a branded parameter alone does NOT catch a missed resolve — that is how
 * this reached review. These exercise the real procedure.
 */
describe("imageRouter.delete", () => {
  const ctx = withTestDb();

  const caller = () => createTestCaller(imageRouter, ctx.db);

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

    const result = await caller().delete({
      ids: [unsafeImageShortcode(row.shortcode)],
    });

    expect(result.deleted).toBe(1);
    expect(await stillExists(row.id)).toBe(false);
  });

  it("deletes a multi-row selection, as bulk table delete does", async () => {
    const first = await seedImage("bulk-one.jpg");
    const second = await seedImage("bulk-two.jpg");

    const result = await caller().delete({
      ids: [
        unsafeImageShortcode(first.shortcode),
        unsafeImageShortcode(second.shortcode),
      ],
    });

    expect(result.deleted).toBe(2);
    expect(await stillExists(first.id)).toBe(false);
    expect(await stillExists(second.id)).toBe(false);
  });

  it("refuses a raw uuid rather than treating it as a public code", async () => {
    const row = await seedImage("uuid-rejected.jpg");

    // Parse-time refusal from the `imageShortcode` input schema. Without it the
    // uuid would reach `resolveAllPresent`, resolve to nothing, and report a
    // cheerful `deleted: 0` for a row that is still there.
    await expect(caller().delete({ ids: [row.id as never] })).rejects.toThrow();

    expect(await stillExists(row.id)).toBe(true);
  });
});
