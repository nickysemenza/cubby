import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { image } from "~/server/db/schema";
import { setDataException } from "~/server/repo/data-quality/exceptions";
import { getDb } from "~/server/repo/database-helpers";
import { findProductsWithUpcGaps } from "~/server/repo/problems/detectors-product";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  insertEntityAttachments,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { selectUpcImageBackfill } from "~/server/services/product-orchestration.service";

import {
  countProductsWithNoImagesWithGtin,
  findProductsWithNoImages,
} from "./analytics";

// One "displayable Product image" definition (live attachment, live Image, not a
// label) must drive every worklist. These pin the divergences that existed when
// each caller hand-copied it, plus the backfill honouring `product_image`
// exceptions so a recorded dead end is not re-researched on every sweep.
describe("displayable Product image predicate", () => {
  const ctx = withTestDb();

  const stocked = async (name: string, upc: string) => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: `${name} shelf` }),
      ctx.actor,
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name, manufacturer: "(unspecified)", upc }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    return product;
  };

  it("treats a soft-deleted Image as no image in the backfill selection and count", async () => {
    const product = await stocked("Deleted image product", "036000291452");
    const photo = await createImageFixture(ctx.db, "predicate-deleted");
    await insertEntityAttachments(ctx.db, {
      entityId: product.entityId,
      imageId: photo.id,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, photo.id));

    const noImages = await findProductsWithNoImages(ctx.db);
    expect(noImages.map((row) => row.id)).toContain(product.entityId);
    expect(await countProductsWithNoImagesWithGtin(ctx.db)).toBe(
      (await selectUpcImageBackfill(ctx.db)).length,
    );
  });

  it("does not let a label-only attachment count as the UPC-gap image", async () => {
    const product = await stocked("Label only product", "012345678905");
    const label = await createImageFixture(ctx.db, "predicate-label");
    await insertEntityAttachments(ctx.db, {
      entityId: product.entityId,
      imageId: label.id,
      purpose: "label",
    });

    const candidates = await findProductsWithUpcGaps(ctx.db);
    expect(
      candidates.find((row) => row.id === product.entityId)?.hasImage,
    ).toBe(false);
  });

  it("skips Products with an active product_image exception in the backfill", async () => {
    const open = await stocked("Open backfill product", "042100005264");
    const excepted = await stocked("Excepted backfill product", "036000291452");
    await setDataException(
      ctx.db,
      {
        entityId: excepted.id,
        check: "product_image",
        reason: "unavailable",
        note: "Discontinued; every listing retired.",
      },
      ctx.actor,
    );

    const selected = (await selectUpcImageBackfill(ctx.db)).map(
      (row) => row.productId,
    );
    expect(selected).toContain(open.entityId);
    expect(selected).not.toContain(excepted.entityId);
    expect(await countProductsWithNoImagesWithGtin(ctx.db)).toBe(
      selected.length,
    );
  });
});
