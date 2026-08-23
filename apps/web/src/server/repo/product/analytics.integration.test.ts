import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "../repo.fixtures";
import {
  countProductsWithNoImagesWithGtin,
  findProductsWithNoImages,
} from "./analytics";

describe("product analytics", () => {
  const ctx = withTestDb();

  it("counts the same barcode-backed image gaps as the maintenance list", async () => {
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Barcode Backfill Count",
        upc: "012345678905",
      }),
      ctx.actor,
    );

    const listed = await findProductsWithNoImages(ctx.db, {
      excludeIngredients: true,
    });

    await expect(countProductsWithNoImagesWithGtin(ctx.db)).resolves.toBe(
      listed.filter((row) => row.primaryGtin !== null).length,
    );
  });
});
