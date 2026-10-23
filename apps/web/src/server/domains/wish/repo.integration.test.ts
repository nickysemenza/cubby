import { sql } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { updateProduct } from "~/server/domains/product/repo/crud";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createProductFixture as createProduct,
  makeProductInput,
  makeExpenseInput,
} from "~/server/testing/repo.fixtures";

import { wishPriceRangeSql } from "./price-range";
import { createWish, wishList, wishListSummary } from "./repo";

describe("wish candidates", () => {
  const ctx = withTestDb();

  it("owns candidate ranges, unpriced values and empty ranges in SQL", async () => {
    for (const [prices, expected] of [
      [[200, 650, 425], { low: 200, high: 650, pricedCount: 3 }],
      [[425], { low: 425, high: 425, pricedCount: 1 }],
      [[200, null], { low: 200, high: 200, pricedCount: 1 }],
      [[0, null], { low: 0, high: 0, pricedCount: 1 }],
      [[null], null],
      [[], null],
    ] as const) {
      const result = await getDb(ctx.db).execute(sql`
        SELECT ${wishPriceRangeSql(sql`price`)} AS range
        FROM jsonb_array_elements_text(${JSON.stringify(prices)}::jsonb) item
        CROSS JOIN LATERAL (SELECT item::double precision AS price) p
      `);
      expect(result.rows[0]?.range).toEqual(expected);
    }
    const priced = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic priced candidate", price: 125 }),
      ctx.actor,
    );
    const unpriced = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic unpriced candidate", price: null }),
      ctx.actor,
    );
    const derived = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic derived candidate", price: null }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Synthetic candidate acquisition",
        productId: derived.id,
        productQuantity: 2,
        cost: 40,
      }),
      ctx.actor,
    );
    const created = await createWish(
      ctx.db,
      {
        name: "Synthetic range wish",
        notes: null,
        candidateProductIds: [priced.id, unpriced.id, derived.id],
      },
      ctx.actor,
    );
    const listed = await wishList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 20,
    });
    expect(created.output.priceRange).toEqual({
      low: 20,
      high: 125,
      pricedCount: 2,
    });
    expect(
      created.output.candidates.find((candidate) => candidate.id === derived.id)
        ?.price,
    ).toBe(20);
    expect(
      listed.data.find((row) => row.id === created.output.id)?.priceRange,
    ).toEqual(created.output.priceRange);
    expect(await wishListSummary(ctx.db, {})).toEqual({
      priceLow: 20,
      priceHigh: 125,
    });
  });

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

  // Native draws the Wish's candidates from these rows (`display.itemsPath`),
  // so the wording and the link target are the server's, not a client's.
  it("carries each candidate as a worded row that opens its product", async () => {
    const skillet = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Cast iron skillet",
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
        model: "CI-12",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );

    const wish = await createWish(
      ctx.db,
      { name: "Pan wish", notes: null, candidateProductIds: [skillet.id] },
      ctx.actor,
    );

    expect(wish.output.candidateItems).toEqual([
      {
        entity: "product",
        id: skillet.id,
        title: "Cast iron skillet",
        subtitle: "Acme · CI-12",
        trailing: null,
      },
    ]);
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
