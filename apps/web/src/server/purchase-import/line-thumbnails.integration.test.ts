import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment, image } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { attachOrderLineThumbnails } from "./line-thumbnails";

// A brand-new mail-imported Product should arrive with the confirmation's own
// item thumbnail as its cover. Failure modes: an image the email never showed
// is fetched; a Product that already has an image gets a second cover; a fetch
// failure aborts the rest of the order.
describe("order line thumbnails", () => {
  const ctx = withTestDb();

  async function seed() {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Thumbnail Seeds ${crypto.randomUUID()}`,
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "THUMB-1",
      date: "2026-09-21",
    });
    const product = (name: string) =>
      insertWithShortcode(ctx.db, "product", { name, manufacturer: "" });
    const bare = await product("Example tomato packet");
    const pictured = await product("Example pepper packet");
    const failing = await product("Example bean packet");
    for (const [name, row] of [
      ["Example tomato packet", bare],
      ["Example pepper packet", pictured],
      ["Example bean packet", failing],
    ] as const)
      await insertWithShortcode(ctx.db, "expense", {
        name,
        purchaseId: purchase.id,
        productId: row.id,
        cost: 3,
        date: "2026-09-21",
        lineKind: "principal",
        costType: "materials",
      });
    const existing = await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "own.jpg",
      status: "UPLOADED",
      contentType: "image/jpeg",
      size: 1,
    });
    await getDb(ctx.db).insert(entityAttachment).values({
      entityId: pictured.id,
      entityKind: "product",
      role: "attachment",
      imageId: existing.id,
      sortOrder: 0,
      purpose: "item",
    });
    return { purchase, bare, pictured, failing };
  }

  const fetched: string[] = [];
  const importImage = async (
    db: Parameters<typeof attachOrderLineThumbnails>[0],
    params: { sourceUrl: string },
  ) => {
    fetched.push(params.sourceUrl);
    if (params.sourceUrl.includes("bean"))
      throw new Error("synthetic CDN failure");
    const row = await insertWithShortcode(db, "image", {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "thumb.jpg",
      status: "UPLOADED",
      contentType: "image/jpeg",
      size: 1,
      source: "catalog",
      sourceAssetUrl: params.sourceUrl,
    });
    return {
      imageId: parseShortcodeFor("image", row.shortcode),
      created: true,
    };
  };

  it("covers only image-less Products with images the email literally shows", async () => {
    const { purchase, bare, pictured, failing } = await seed();
    const html =
      '<img src="https://cdn.example.test/tomato.jpg">' +
      '<img src="https://cdn.example.test/pepper.jpg">' +
      '<img src="https://cdn.example.test/bean.jpg">';
    await attachOrderLineThumbnails(
      ctx.db,
      {
        purchaseId: purchase.id,
        mailContent: { bodyHtml: html, bodyText: null },
        lines: [
          {
            title: "Example bean packet",
            imageUrl: "https://cdn.example.test/bean.jpg",
          },
          {
            title: "Example tomato packet",
            imageUrl: "https://cdn.example.test/tomato.jpg",
            productUrl: "https://seeds.example.test/products/tomato",
          },
          {
            title: "Example pepper packet",
            imageUrl: "https://cdn.example.test/pepper.jpg",
          },
          {
            title: "Example tomato packet",
            imageUrl: "https://cdn.example.test/not-in-email.jpg",
          },
        ],
      },
      { importImage },
    );

    const coverOf = (productId: string) =>
      getDb(ctx.db)
        .select({
          sourceAssetUrl: image.sourceAssetUrl,
          sourcePageUrl: image.sourcePageUrl,
          sortOrder: entityAttachment.sortOrder,
        })
        .from(entityAttachment)
        .innerJoin(image, eq(image.id, entityAttachment.imageId))
        .where(
          and(
            eq(entityAttachment.entityId, productId),
            notDeleted(entityAttachment),
          ),
        );
    expect(await coverOf(bare.id)).toEqual([
      {
        sourceAssetUrl: "https://cdn.example.test/tomato.jpg",
        sourcePageUrl: "https://seeds.example.test/products/tomato",
        sortOrder: 0,
      },
    ]);
    // The Product that already had its own photo keeps it as the only image.
    expect(await coverOf(pictured.id)).toHaveLength(1);
    // A failed fetch skips that line and never aborts the others.
    expect(await coverOf(failing.id)).toEqual([]);
    expect(fetched).not.toContain("https://cdn.example.test/not-in-email.jpg");
    expect(fetched).not.toContain("https://cdn.example.test/pepper.jpg");
  });
});
