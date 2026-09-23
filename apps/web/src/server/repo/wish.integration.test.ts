import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateProduct } from "~/server/repo/product";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  taxonomyId,
  taxonomyShortcode,
} from "../../../tooling/product-category-fixtures";
import { createWish } from "./wish";

describe("wish candidates", () => {
  const ctx = withTestDb();

  // The wishlist used to require every candidate to resolve to feature
  // `tools`. That restriction is gone: any live Product can be a candidate.
  it("accepts a non-tool Product as a candidate", async () => {
    const food = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Wishlist food candidate",
        categoryId: taxonomyShortcode("food"),
      }),
      ctx.actor,
    );

    const wish = await createWish(
      ctx.db,
      { name: "Non-tool wish", notes: null, candidateProductIds: [food.id] },
      ctx.actor,
    );

    expect(wish.output.candidates).toMatchObject([{ id: food.id }]);
  });

  // Changing a wishlisted Product's category used to be refused unless the
  // destination was also `tools`. Nothing gates the category of a wish
  // candidate anymore.
  it("no longer refuses a category change for a wishlisted Product", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Wishlisted tool",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    await createWish(
      ctx.db,
      { name: "Tool wish", notes: null, candidateProductIds: [tool.id] },
      ctx.actor,
    );

    await expect(
      updateProduct(
        ctx.db,
        tool.entityId,
        { categoryId: taxonomyId("hardware") },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ detachedImageKeys: [] });
  });
});
