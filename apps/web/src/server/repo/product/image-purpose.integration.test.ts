import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productImage } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { updateProduct } from "~/server/repo/product";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  createOrReuseAttachedImage,
  createUploadedImageRecord,
} from "../image";
import { getProductImagesByProductIds } from "./crud";

describe("pending Product image roles", () => {
  const ctx = withTestDb();

  it("corrects an existing attachment role and preserves it after reattachment", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Label attachment product" }),
      ctx.actor,
    );
    const secondProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Shared label attachment product" }),
      ctx.actor,
    );
    const label = await createImageFixture(ctx.db, "pending-label-role");
    const labelCode = parseShortcodeFor("image", label.shortcode);

    await updateProduct(
      ctx.db,
      product.entityId,
      {
        pendingImageIds: [labelCode],
        pendingImagePurposes: { [labelCode]: "label" },
      },
      ctx.actor,
    );
    // A second live attachment keeps the source Image alive while the first
    // Product link is detached, exercising restore rather than re-upload.
    await updateProduct(
      ctx.db,
      secondProduct.entityId,
      { pendingImageIds: [labelCode] },
      ctx.actor,
    );
    // Existing attachment roles can be corrected without creating another
    // ProductImage link; a later unspecified retry must retain that choice.
    await updateProduct(
      ctx.db,
      product.entityId,
      {
        pendingImageIds: [labelCode],
        pendingImagePurposes: { [labelCode]: "item" },
      },
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      {
        pendingImageIds: [labelCode],
        pendingImagePurposes: { [labelCode]: "label" },
      },
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { removeImageIds: [labelCode] },
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [labelCode] },
      ctx.actor,
    );

    const row = await getDb(ctx.db).query.productImage.findFirst({
      where: and(
        eq(productImage.productId, product.entityId),
        eq(productImage.imageId, label.id),
        notDeleted(productImage),
      ),
      columns: { purpose: true },
    });
    expect(row?.purpose).toBe("label");
    // Summary and project galleries use this lighter read instead of the
    // Product detail mapper; confirmed labels must be excluded here too.
    const galleries = await getProductImagesByProductIds(ctx.db, [
      product.entityId,
      secondProduct.entityId,
    ]);
    expect(galleries[product.entityId]).toEqual([]);
    expect(galleries[secondProduct.entityId]).toHaveLength(1);
    const document = await createUploadedImageRecord(ctx.db, {
      key: "tests/item-care.pdf",
      filename: "care.pdf",
      contentType: "application/pdf",
      size: 32,
    });
    await updateProduct(
      ctx.db,
      product.entityId,
      {
        pendingImageIds: [parseShortcodeFor("image", document.shortcode)],
      },
      ctx.actor,
    );
    // Upload preconditions use the complete attachment count, not just item
    // thumbnails: this Product now has one label and one document.
    const attached = await createOrReuseAttachedImage(
      ctx.db,
      {
        key: "tests/new-item.jpg",
        filename: "item.jpg",
        contentType: "image/jpeg",
        size: 32,
        expectedImageCount: 2,
        purpose: "item",
      },
      { entity: "product", id: product.entityId },
    );
    expect(attached.reused).toBe(false);
  });
});
