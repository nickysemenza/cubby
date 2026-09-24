import { expenseCreateInput } from "@cubby/schemas/project";
import { and, inArray } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { createExpense } from "~/server/repo/expense";
import { createIngredient } from "~/server/repo/ingredient";
import { attachProductComponents } from "~/server/repo/product-components";
import {
  createPlantFixture,
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { productList } from ".";
import { loadProductPriceSum } from "./pricing";

/**
 * `ingredientIdFilter` (the SKU's own ingredient) and `growsPlantIdFilter`
 * (the crop this product seeds — the Product↔Ingredient "grows" relation) are
 * independent shortcode-resolved id filters on `buildProductWhere`; each must
 * narrow by its own column, not the other's.
 */
describe("productList id filters", () => {
  const ctx = withTestDb();

  it("ingredientIdFilter narrows to products whose own ingredientId matches, leaving growsPlantId-only matches out", async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Filter flour" },
      TEST_ACTOR,
    );
    const tomato = await createPlantFixture(
      ctx.db,
      { name: "Filter tomato crop" },
      TEST_ACTOR,
    );
    const flourBag = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet",
        growsPlantId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await productList(
      ctx.db,
      { ingredientIdFilter: flour.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    const ids = new Set(data.map((row) => row.id));
    expect(ids.has(flourBag.id)).toBe(true);
    expect(ids.has(tomatoSeeds.id)).toBe(false);
  });

  it("growsPlantIdFilter narrows to products whose growsPlantId matches, leaving ingredientId-only matches out", async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Filter flour 2" },
      TEST_ACTOR,
    );
    const tomato = await createPlantFixture(
      ctx.db,
      { name: "Filter tomato crop 2" },
      TEST_ACTOR,
    );
    const flourBag = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag 2", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet 2",
        growsPlantId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await productList(
      ctx.db,
      { growsPlantIdFilter: tomato.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    const ids = new Set(data.map((row) => row.id));
    expect(ids.has(tomatoSeeds.id)).toBe(true);
    expect(ids.has(flourBag.id)).toBe(false);
  });
});

describe("product list price footer", () => {
  const ctx = withTestDb();

  it("sums the full filtered set with explicit prices and projected kit prices", async () => {
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example kit" }),
      ctx.actor,
    );
    const [single, doubled, explicit, unpriced] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Single part" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Double part" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Explicit item", price: 9.99 }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Unpriced item" }),
        ctx.actor,
      ),
    ]);
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [
        { productId: single.entityId, quantity: 1 },
        { productId: doubled.entityId, quantity: 2 },
      ],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Example kit acquisition",
          productId: kit.id,
          productQuantity: 1,
          cost: 90,
        }),
      ),
      ctx.actor,
    );

    const filteredSum = await loadProductPriceSum(
      ctx.db,
      and(
        inArray(product.id, [
          single.entityId,
          doubled.entityId,
          explicit.entityId,
          unpriced.entityId,
        ]),
        notDeleted(product),
      ),
    );
    expect(filteredSum).toBeCloseTo(69.99, 2);

    const page = await productList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page.data).toHaveLength(2);
    expect(page.sums.price).toBeCloseTo(159.99, 2);
  });
});
