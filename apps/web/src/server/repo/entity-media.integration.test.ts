import { entityRefKey } from "@cubby/schemas/entity";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { locationImage, product, productImage } from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/repo/image";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { getDb } from "./database-helpers";
import { getEntityDisplayImages } from "./entity-media";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";

describe("entity media public display images", () => {
  const ctx = withTestDb();

  it("deduplicates public refs and returns explicit nulls for absent or external records", async () => {
    const pictured = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Pictured public ref" }),
      ctx.actor,
    );
    const unpictured = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unpictured public ref" }),
      ctx.actor,
    );
    const deleted = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Deleted public ref" }),
      ctx.actor,
    );
    const picturedLocation = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Pictured public location" }),
      ctx.actor,
    );
    const cover = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "cover.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    await getDb(ctx.db).insert(productImage).values({
      productId: pictured.entityId,
      imageId: cover.id,
      sortOrder: 0,
    });
    const deletedCover = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "deleted-cover.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    await getDb(ctx.db).insert(productImage).values({
      productId: deleted.entityId,
      imageId: deletedCover.id,
      sortOrder: 0,
    });
    const locationCover = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "location-cover.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    await getDb(ctx.db).insert(locationImage).values({
      locationId: picturedLocation.entityId,
      imageId: locationCover.id,
      sortOrder: 0,
    });
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, deleted.entityId));

    const result = await getEntityDisplayImages(ctx.db, [
      { entityType: "product", entityId: pictured.id },
      { entityType: "product", entityId: pictured.id },
      { entityType: "product", entityId: unpictured.id },
      { entityType: "product", entityId: deleted.id },
      { entityType: "location", entityId: picturedLocation.id },
      { entityType: "location", entityId: pictured.id },
      { entityType: "usda-food", entityId: "123456" },
      { entityType: "product", entityId: "PRD-NOT-FOUND" },
    ]);

    expect(result).toEqual({
      [entityRefKey("product", pictured.id)]: {
        url: getR2PublicUrl(cover.key),
      },
      [entityRefKey("product", unpictured.id)]: null,
      [entityRefKey("product", deleted.id)]: null,
      [entityRefKey("location", picturedLocation.id)]: {
        url: getR2PublicUrl(locationCover.key),
      },
      [entityRefKey("location", pictured.id)]: null,
      [entityRefKey("usda-food", "123456")]: null,
      [entityRefKey("product", "PRD-NOT-FOUND")]: null,
    });
  });
});
