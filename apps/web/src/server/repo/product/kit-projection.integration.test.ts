import type { ProductId } from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
} from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { productComponent } from "~/server/db/schema";
import { getDb } from "../database-helpers";
import { createExpense } from "../expense";
import {
  createIngredientFixture,
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "../repo.fixtures";
import {
  effectiveProductPriceSql,
  loadExactEffectivePrices,
  loadProductPricing,
  loadProductPricingForIngredientIds,
} from "./pricing";
import {
  expectedQuantitySql,
  loadProductQuantityLedgers,
} from "./quantity-ledger";

/**
 * Projecting a kit's Expense into the parts it contains, against real SQL.
 *
 * Everything here is a `WITH RECURSIVE` question the tiers below cannot ask: the
 * walk's termination, the sibling denominator's soft-delete visibility, and
 * whether the four pricing paths that must agree still return the same number
 * once each of them carries a recursive CTE.
 */
describe("kit component projection", () => {
  const ctx = withTestDb();

  const seedExpense = (overrides: Partial<ExpenseCreateInput>) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput(overrides)),
      ctx.actor,
    );

  const makeProduct = async (
    name: string,
    overrides: Parameters<typeof makeProductInput>[0] = {},
  ) =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name, ...overrides }),
      ctx.actor,
    );

  /**
   * Rows, not `attachProductComponents`: the cycle case has to build a graph the
   * write path is allowed to refuse, and the point of the depth cap is that a
   * read must survive rows however they got there.
   */
  const attach = async (
    parentProductId: ProductId,
    components: Array<{ productId: ProductId; quantity: number }>,
  ) => {
    await getDb(ctx.db)
      .insert(productComponent)
      .values(
        components.map(({ productId, quantity }) => ({
          parentProductId,
          componentProductId: productId,
          quantity,
        })),
      );
  };

  const derivedPriceFor = async (id: ProductId) =>
    (await loadProductPricing(ctx.db, [{ id, price: null }])).get(id)
      ?.derivedPrice ?? null;

  const listSortPriceFor = async (id: ProductId) => {
    const rows = await getDb(ctx.db).execute(
      sql`SELECT ${sql.raw(effectiveProductPriceSql('"Product"'))} AS price
            FROM "Product" WHERE "Product"."id" = ${id}`,
    );
    const row = (rows as unknown as { rows: Array<{ price: number | null }> })
      .rows[0];
    return row?.price ?? null;
  };

  it("splits a kit's expense across its components, quantity-weighted", async () => {
    const kit = await makeProduct("Nine Piece Kit");
    const parts = [];
    for (let index = 0; index < 9; index += 1) {
      parts.push(await makeProduct(`Kit Part ${index}`));
    }
    await attach(
      kit.entityId,
      parts.map((part) => ({ productId: part.entityId, quantity: 1 })),
    );
    await seedExpense({
      name: "bought the kit",
      cost: 199,
      productId: kit.id,
      productQuantity: 1,
    });

    // $199 over nine single-quantity parts, one unit each.
    for (const part of parts) {
      expect(await derivedPriceFor(part.entityId)).toBe(22.11);
    }
    // The kit keeps its own price; projecting down never disturbs it.
    expect(await derivedPriceFor(kit.entityId)).toBe(199);
  });

  it("gives a component at quantity 2 twice the share of one at quantity 1", async () => {
    const kit = await makeProduct("Two Part Kit");
    const single = await makeProduct("Single Part");
    const double = await makeProduct("Doubled Part");
    await attach(kit.entityId, [
      { productId: single.entityId, quantity: 1 },
      { productId: double.entityId, quantity: 2 },
    ]);
    await seedExpense({
      name: "bought the kit",
      cost: 30,
      productId: kit.id,
      productQuantity: 1,
    });

    const pricing = await loadProductPricing(ctx.db, [
      { id: single.entityId, price: null },
      { id: double.entityId, price: null },
    ]);
    // $10 of $30 against one unit; $20 of $30 against two.
    expect(pricing.get(single.entityId)?.knownUnitCount).toBe(1);
    expect(pricing.get(double.entityId)?.knownUnitCount).toBe(2);
    expect(pricing.get(single.entityId)?.derivedPrice).toBe(10);
    expect(pricing.get(double.entityId)?.derivedPrice).toBe(10);
  });

  it("agrees across all four pricing paths on one component", async () => {
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "Kit Part Ingredient" },
      ctx.actor,
    );
    const kit = await makeProduct("Four Pack");
    const part = await makeProduct("Packed Unit", {
      ingredientId: ingredient.entityId,
    });
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 4 }]);
    await seedExpense({
      name: "bought the four pack",
      cost: 20,
      productId: kit.id,
      productQuantity: 1,
    });

    const [loader, exact, ingredientLoader, listSort] = await Promise.all([
      derivedPriceFor(part.entityId),
      loadExactEffectivePrices(ctx.db, [{ id: part.entityId, price: null }]),
      loadProductPricingForIngredientIds(ctx.db, [ingredient.entityId]),
      listSortPriceFor(part.entityId),
    ]);

    expect(loader).toBe(5);
    expect(exact.get(part.entityId)).toBe(5);
    expect(ingredientLoader.get(part.entityId)?.derivedPrice).toBe(5);
    expect(listSort).toBe(5);
  });

  it("blends a component's own expenses with its projected share", async () => {
    const kit = await makeProduct("Blend Kit");
    const part = await makeProduct("Blended Part");
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 1 }]);
    await seedExpense({
      name: "bought the kit",
      cost: 40,
      productId: kit.id,
      productQuantity: 1,
    });
    await seedExpense({
      name: "bought a spare standalone",
      cost: 20,
      productId: part.id,
      productQuantity: 1,
    });

    // $40 projected over one unit plus $20 own over one unit: $60 / 2.
    const pricing = await loadProductPricing(ctx.db, [
      { id: part.entityId, price: null },
    ]);
    expect(pricing.get(part.entityId)?.knownUnitCount).toBe(2);
    expect(pricing.get(part.entityId)?.derivedPrice).toBe(30);
    // The counts stay own-only — a parent's line is not this product's line.
    expect(pricing.get(part.entityId)?.knownExpenseCount).toBe(1);
    expect(await listSortPriceFor(part.entityId)).toBe(30);
  });

  it("lets an explicit price beat the projection on every path", async () => {
    const kit = await makeProduct("Override Kit");
    const part = await makeProduct("Overridden Part", { price: 3.5 });
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 1 }]);
    await seedExpense({
      name: "bought the kit",
      cost: 90,
      productId: kit.id,
      productQuantity: 1,
    });

    const pricing = await loadProductPricing(ctx.db, [
      { id: part.entityId, price: 3.5 },
    ]);
    expect(pricing.get(part.entityId)?.derivedPrice).toBe(90);
    expect(pricing.get(part.entityId)?.effectivePrice).toBe(3.5);
    expect(pricing.get(part.entityId)?.source).toBe("explicit");
    const exact = await loadExactEffectivePrices(ctx.db, [
      { id: part.entityId, price: 3.5 },
    ]);
    expect(exact.get(part.entityId)).toBe(3.5);
    expect(await listSortPriceFor(part.entityId)).toBe(3.5);
  });

  it("prices a component that has no expense of its own", async () => {
    const kit = await makeProduct("Sole Source Kit");
    const part = await makeProduct("Sole Source Part");
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 1 }]);
    await seedExpense({
      name: "bought the kit",
      cost: 12.5,
      productId: kit.id,
      productQuantity: 1,
    });

    const pricing = await loadProductPricing(ctx.db, [
      { id: part.entityId, price: null },
    ]);
    expect(pricing.get(part.entityId)?.derivedPrice).toBe(12.5);
    expect(pricing.get(part.entityId)?.source).toBe("derived");
    expect(await listSortPriceFor(part.entityId)).toBe(12.5);
  });

  it("reweights the share when a sibling component is detached", async () => {
    const kit = await makeProduct("Reweight Kit");
    const kept = await makeProduct("Kept Part");
    const dropped = await makeProduct("Dropped Part");
    await attach(kit.entityId, [
      { productId: kept.entityId, quantity: 1 },
      { productId: dropped.entityId, quantity: 1 },
    ]);
    await seedExpense({
      name: "bought the kit",
      cost: 50,
      productId: kit.id,
      productQuantity: 1,
    });
    expect(await derivedPriceFor(kept.entityId)).toBe(25);

    await getDb(ctx.db).execute(
      sql`UPDATE "ProductComponent" SET "deletedAt" = now()
           WHERE "componentProductId" = ${dropped.entityId}`,
    );
    // The whole $50 now sits on the one live component, not $25 with $25 lost.
    expect(await derivedPriceFor(kept.entityId)).toBe(50);
  });

  it("projects through two levels of nesting", async () => {
    const outer = await makeProduct("Outer Kit");
    const middle = await makeProduct("Middle Kit");
    const leaf = await makeProduct("Leaf Part");
    await attach(outer.entityId, [{ productId: middle.entityId, quantity: 2 }]);
    await attach(middle.entityId, [{ productId: leaf.entityId, quantity: 3 }]);
    await seedExpense({
      name: "bought the outer kit",
      cost: 60,
      productId: outer.id,
      productQuantity: 1,
    });

    // $60 / 1 outer → $60 over 2 middles ($30) → $60 over 6 leaves ($10).
    expect(await derivedPriceFor(middle.entityId)).toBe(30);
    expect(await derivedPriceFor(leaf.entityId)).toBe(10);
    expect(await listSortPriceFor(leaf.entityId)).toBe(10);

    const ledgers = await loadProductQuantityLedgers(ctx.db, [
      middle.entityId,
      leaf.entityId,
    ]);
    expect(ledgers.get(middle.entityId)?.expectedQuantity).toBe(2);
    expect(ledgers.get(leaf.entityId)?.expectedQuantity).toBe(6);
  });

  it("terminates on a cyclic graph instead of hanging", async () => {
    const first = await makeProduct("Cycle A");
    const second = await makeProduct("Cycle B");
    await attach(first.entityId, [{ productId: second.entityId, quantity: 1 }]);
    await attach(second.entityId, [{ productId: first.entityId, quantity: 1 }]);
    await seedExpense({
      name: "bought A",
      cost: 10,
      productId: first.id,
      productQuantity: 1,
    });

    // The cap truncates the walk, so both sides return a finite number rather
    // than spinning. The per-unit answer stays $10 because cost and units are
    // double-counted in step.
    expect(await derivedPriceFor(first.entityId)).toBe(10);
    expect(await derivedPriceFor(second.entityId)).toBe(10);
    expect(await listSortPriceFor(second.entityId)).toBe(10);
  });

  it("projects expectedQuantity through a kit purchase and its return", async () => {
    const kit = await makeProduct("Quantity Kit");
    const part = await makeProduct("Quantity Part");
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 2 }]);
    await seedExpense({
      name: "bought two kits",
      cost: 100,
      productId: kit.id,
      productQuantity: 2,
    });

    const bought = await loadProductQuantityLedgers(ctx.db, [part.entityId]);
    // Two kits with two of the part inside each.
    expect(bought.get(part.entityId)?.acquiredUnits).toBe(4);
    expect(bought.get(part.entityId)?.expectedQuantity).toBe(4);

    await seedExpense({
      name: "returned one kit",
      cost: -50,
      productId: kit.id,
      productQuantity: -1,
    });
    const afterReturn = await loadProductQuantityLedgers(ctx.db, [
      part.entityId,
    ]);
    // The exit carries through the same edge: two of the part went back.
    expect(afterReturn.get(part.entityId)?.exitedUnits).toBe(2);
    expect(afterReturn.get(part.entityId)?.expectedQuantity).toBe(2);
  });

  it("keeps the projected expectedQuantity agreeing with the list filter", async () => {
    const kit = await makeProduct("Filter Kit");
    const part = await makeProduct("Filter Part");
    await attach(kit.entityId, [{ productId: part.entityId, quantity: 3 }]);
    await seedExpense({
      name: "bought the kit",
      cost: 15,
      productId: kit.id,
      productQuantity: 1,
    });

    const ledgers = await loadProductQuantityLedgers(ctx.db, [part.entityId]);
    expect(ledgers.get(part.entityId)?.expectedQuantity).toBe(3);

    const rows = await getDb(ctx.db).execute(
      sql`SELECT ${sql.raw(expectedQuantitySql('"Product"'))} AS expected
            FROM "Product" WHERE "Product"."id" = ${part.entityId}`,
    );
    const row = (rows as unknown as { rows: Array<{ expected: number }> })
      .rows[0];
    expect(row?.expected).toBe(3);
  });
});
