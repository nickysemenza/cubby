import { expenseCreateInput } from "@cubby/schemas/project";
import { and, inArray, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
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
import { loadProductPriceSum, loadProductPricing } from "./pricing";
import { loadProductQuantityLedgers } from "./quantity-ledger";

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
    expect(page.sums!.price).toBeCloseTo(159.99, 2);
  });

  it("keeps nested kit shares, own counts, overrides, refunds, and live siblings aligned across batch reads and the footer", async () => {
    const [outer, inner, leaf, other, sibling] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Outer kit" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Inner kit" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Leaf" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Other leaf", price: 2.25 }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Sibling" }),
        ctx.actor,
      ),
    ]);
    await attachProductComponents(
      ctx.db,
      outer.entityId,
      [
        { productId: inner.entityId, quantity: 2 },
        { productId: sibling.entityId, quantity: 1 },
      ],
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      inner.entityId,
      [
        { productId: leaf.entityId, quantity: 3 },
        { productId: other.entityId, quantity: 1 },
      ],
      ctx.actor,
    );
    for (const [name, productId, cost, productQuantity] of [
      ["Outer acquisition", outer.id, 90, 1],
      ["Inner acquisition", inner.id, 30, 1],
      ["Unknown leaf acquisition", leaf.id, 10, null],
      ["Leaf refund", leaf.id, -5, -1],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name,
            productId,
            cost,
            productQuantity,
          }),
        ),
        ctx.actor,
      );
    }

    const products = [outer, inner, leaf, other, sibling].map(
      ({ entityId, id }) => ({
        id: entityId,
        price: id === other.id ? 2.25 : null,
      }),
    );
    const before = await loadProductPricing(ctx.db, products);
    const ledger = await loadProductQuantityLedgers(
      ctx.db,
      products.map(({ id }) => id),
    );
    expect(before.get(leaf.entityId)).toMatchObject({
      derivedPrice: 7.5,
      effectivePrice: 7.5,
      knownExpenseCount: 0,
      unknownExpenseCount: 1,
      knownUnitCount: 9,
    });
    expect(before.get(other.entityId)).toMatchObject({
      derivedPrice: 7.5,
      effectivePrice: 2.25,
      source: "explicit",
    });
    expect(ledger.get(leaf.entityId)?.expectedQuantity).toBe(8);

    const filtered = and(
      inArray(product.id, [leaf.entityId, other.entityId]),
      notDeleted(product),
    );
    expect(await loadProductPriceSum(ctx.db, filtered)).toBeCloseTo(9.75, 2);

    await getDb(ctx.db).execute(sql`UPDATE "EntityLink"
      SET "deletedAt" = now()
      WHERE "kind" = 'productComponent'
        AND "fromEntityId" = ${outer.entityId}
        AND "toEntityId" = ${sibling.entityId}`);
    const after = await loadProductPricing(ctx.db, products);
    expect(after.get(leaf.entityId)?.derivedPrice).toBe(10);
    expect(after.get(other.entityId)?.effectivePrice).toBe(2.25);
    expect(await loadProductPriceSum(ctx.db, filtered)).toBeCloseTo(12.25, 2);
  });
});
