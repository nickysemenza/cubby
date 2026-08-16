import type { ProductCategory } from "@cubby/schemas/product";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "~/server/repo/expense";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { productRouter } from "./product";

describe("product.tagSiblings", () => {
  const ctx = withTestDb();

  it("returns sibling shortcodes as public ids", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["shared", "source-only"] }),
      ctx.actor,
    );
    const sibling = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Sibling",
        manufacturer: "Sibling Maker",
        tags: ["shared", "sibling-only"],
      }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unrelated", tags: ["unrelated"] }),
      ctx.actor,
    );

    const caller = createTestCaller(productRouter, ctx.db);
    const result = await caller.tagSiblings(source.id);

    expect(result).toEqual([
      {
        id: sibling.id,
        name: "Sibling",
        manufacturer: "Sibling Maker",
        category: null,
        tags: ["shared", "sibling-only"],
      },
    ]);
    expect(result[0]?.id).not.toBe(sibling.entityId);
  });
});

/**
 * The list path the products table actually calls.
 *
 * Worth its own suite because the correlated subqueries behind Expected and
 * Variance are hand-qualified raw SQL, and the failure mode there is silent:
 * a wrong alias self-joins and returns 0 for every row rather than erroring.
 * Only running them through the real query builders catches that — and the
 * sort/filter path uses a *different* aliasing rule from the sort path, so
 * both are exercised here.
 */
describe("product.list quantity ledger", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput(overrides)),
      ctx.actor,
    );

  const list = (
    filters: Record<string, unknown> = {},
    sort?: { orderBy: string; direction: "asc" | "desc" },
  ) =>
    createTestCaller(productRouter, ctx.db).list({
      filters,
      sort: sort ?? { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 50 },
    });

  it("returns the ledger, on-hand and variance, and sorts and filters on them", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Ledger shelf" }),
      ctx.actor,
    );
    // Bought 5, returned 1 → expected 4, and 4 on the shelf. Agrees.
    const agreeing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Agreeing Box" }),
      ctx.actor,
    );
    // Bought 2, nothing gone → expected 2, but only 1 on the shelf.
    const mismatched = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Mismatched Bit" }),
      ctx.actor,
    );
    // Sold one that was never recorded as bought → expected -1.
    const negative = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Zzz Ghost Tool" }),
      ctx.actor,
    );

    await createInventoryFixture(
      ctx.db,
      {
        productId: agreeing.entityId,
        locationId: shelf.entityId,
        amount: { value: 4, unit: "each" },
      },
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: mismatched.entityId,
        locationId: shelf.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    await seedLine({
      name: "boxes",
      cost: 25,
      productId: agreeing.id,
      productQuantity: 5,
    });
    await seedLine({
      name: "one back",
      cost: -5,
      productId: agreeing.id,
      productQuantity: -1,
    });
    await seedLine({
      name: "bits",
      cost: 8,
      productId: mismatched.id,
      productQuantity: 2,
    });
    await seedLine({
      name: "bits, count unknown",
      cost: 4,
      productId: mismatched.id,
      productQuantity: null,
    });
    await seedLine({
      name: "ghost sold",
      cost: -40,
      productId: negative.id,
      productQuantity: -1,
    });

    const all = await list();
    const byId = new Map(all.items.map((row) => [row.id, row]));

    expect(byId.get(agreeing.id)).toMatchObject({
      quantityLedger: {
        acquiredUnits: 5,
        exitedUnits: 1,
        expectedQuantity: 4,
        unknownAcquisitionLines: 0,
        unknownExitLines: 0,
      },
      onHandUnits: 4,
      quantityVariance: 0,
    });
    expect(byId.get(mismatched.id)).toMatchObject({
      quantityLedger: { expectedQuantity: 2, unknownAcquisitionLines: 1 },
      onHandUnits: 1,
      quantityVariance: -1,
    });
    // Not stocked: on-hand and variance are null rather than a misleading 0.
    expect(byId.get(negative.id)).toMatchObject({
      quantityLedger: { expectedQuantity: -1 },
      onHandUnits: null,
      quantityVariance: null,
    });

    // Sorting runs through `resolveProductSort`'s raw correlated SQL — a wrong
    // alias there returns 0 for every row, which reads as "already sorted".
    const ascending = await list(
      {},
      {
        orderBy: "expectedQuantity",
        direction: "asc",
      },
    );
    const ranked = ascending.items
      .filter((row) => byId.has(row.id))
      .map((row) => row.id);
    expect(ranked).toEqual([negative.id, mismatched.id, agreeing.id]);

    // Filtering uses the interpolated-column form instead, because one where
    // clause is shared by three different query builders.
    const negatives = await list({ expectedQuantityMax: -1 });
    expect(negatives.items.map((row) => row.id)).toContain(negative.id);
    expect(negatives.items.map((row) => row.id)).not.toContain(agreeing.id);

    const disagreeing = await list({ quantityVarianceFilter: "mismatched" });
    expect(disagreeing.items.map((row) => row.id)).toEqual([mismatched.id]);

    const agreeingOnly = await list({ quantityVarianceFilter: "matched" });
    expect(agreeingOnly.items.map((row) => row.id)).toEqual([agreeing.id]);

    const withUnknowns = await list({ unknownQuantityLinesFilter: "has" });
    expect(withUnknowns.items.map((row) => row.id)).toEqual([mismatched.id]);
  });

  /**
   * A product stocked in two different units has no meaningful on-hand total,
   * so the Variance cell renders `—`. The filter and the sort have to agree
   * with that: pulling such a product into "Shelf disagrees" — or ordering by
   * its position — would be deciding on a number the user is never shown, and
   * `each` + `can` is not a quantity.
   */
  it("leaves mixed-unit products out of both variance filters", async () => {
    const shelfA = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Mixed unit shelf A" }),
      ctx.actor,
    );
    const shelfB = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Mixed unit shelf B" }),
      ctx.actor,
    );
    const mixed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Mixed Unit Sealant" }),
      ctx.actor,
    );

    await createInventoryFixture(
      ctx.db,
      {
        productId: mixed.entityId,
        locationId: shelfA.entityId,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: mixed.entityId,
        locationId: shelfB.entityId,
        amount: { value: 3, unit: "can" },
      },
      ctx.actor,
    );
    await seedLine({
      name: "sealant",
      cost: 12,
      productId: mixed.id,
      productQuantity: 2,
    });

    const all = await list();
    const row = all.items.find((item) => item.id === mixed.id);
    // The render's contract: no total, so no variance.
    expect(row?.onHandUnits).toBeNull();
    expect(row?.quantityVariance).toBeNull();

    // 2 each + 3 can would sum to 5 against an expected 2 — a "mismatch" that
    // only exists if you add apples to oranges.
    const disagreeing = await list({ quantityVarianceFilter: "mismatched" });
    expect(disagreeing.items.map((item) => item.id)).not.toContain(mixed.id);
    const agreeingOnly = await list({ quantityVarianceFilter: "matched" });
    expect(agreeingOnly.items.map((item) => item.id)).not.toContain(mixed.id);
  });
});

/**
 * The `unlocated` saved views select on `expectedQuantityMin` + an inventory
 * presence of `none` — two filters that already existed but were never combined
 * or tested. This is the behavioural contract behind them; the manifest entries
 * are only a preset over this query.
 *
 * It is deliberately the complement of the variance filters above:
 * `quantityVarianceFilter` is scoped to products that are BOTH stocked and in
 * the ledger, and `onHandUnitsSql` is NULL for a zero-entry shelf, so nothing in
 * that pair can reach a product that is owned on paper and stocked nowhere.
 */
describe("product.list unlocated cohort", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput(overrides)),
      ctx.actor,
    );

  const list = (filters: Record<string, unknown> = {}) =>
    createTestCaller(productRouter, ctx.db).list({
      filters,
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 50 },
    });

  it("selects owned-on-paper, stocked-nowhere — and nothing else", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Unlocated shelf" }),
      ctx.actor,
    );
    const make = (name: string, category: ProductCategory) =>
      createProductFixture(
        ctx.db,
        makeProductInput({ name, category }),
        ctx.actor,
      );

    // Bought 2, never sold, never stocked. The whole point.
    const unlocated = await make("A Unlocated Rack", "tools");
    // Same ledger, but it is on a shelf — that is `shelf-disagrees` territory.
    const stocked = await make("B Stocked Rack", "tools");
    // Bought one, sold one: nets to zero, so nothing is owned to be missing.
    const soldOff = await make("C Sold Off Rack", "tools");
    // No ledger at all — a provenance gap, not a location one.
    const noLedger = await make("D Ledgerless Rack", "tools");
    // Its only line proves the cost but not the count. A null quantity is never
    // read as 1, so it cannot push the ledger to "one or more owned".
    const unknownOnly = await make("E Uncounted Rack", "tools");
    // Unlocated too, but a consumable — the reason the broad view cannot be
    // scoped by category, and the reason the durables view exists.
    const consumable = await make("F Unlocated Snacks", "food");

    await createInventoryFixture(
      ctx.db,
      {
        productId: stocked.entityId,
        locationId: shelf.entityId,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );

    await seedLine({
      name: "racks",
      cost: 40,
      productId: unlocated.id,
      productQuantity: 2,
    });
    await seedLine({
      name: "racks, shelved",
      cost: 40,
      productId: stocked.id,
      productQuantity: 2,
    });
    await seedLine({
      name: "rack in",
      cost: 20,
      productId: soldOff.id,
      productQuantity: 1,
    });
    await seedLine({
      name: "rack out",
      cost: -12,
      productId: soldOff.id,
      productQuantity: -1,
    });
    await seedLine({
      name: "racks, count unknown",
      cost: 15,
      productId: unknownOnly.id,
      productQuantity: null,
    });
    await seedLine({
      name: "snacks",
      cost: 9,
      productId: consumable.id,
      productQuantity: 3,
    });

    const cohort = await list({
      expectedQuantityMin: 1,
      inventoryPresenceFilter: "none",
    });
    expect(cohort.items.map((row) => row.id)).toEqual([
      unlocated.id,
      consumable.id,
    ]);
    // Spelled out so a regression names the row it wrongly admitted.
    for (const excluded of [stocked, soldOff, noLedger, unknownOnly]) {
      expect(cohort.items.map((row) => row.id)).not.toContain(excluded.id);
    }

    // The unlocated row is exactly the one the variance filters cannot see.
    const disagreeing = await list({ quantityVarianceFilter: "mismatched" });
    expect(disagreeing.items.map((row) => row.id)).not.toContain(unlocated.id);
    const agreeing = await list({ quantityVarianceFilter: "matched" });
    expect(agreeing.items.map((row) => row.id)).not.toContain(unlocated.id);

    // `unlocated-durables` adds one category predicate and drops the snacks.
    const durables = await list({
      expectedQuantityMin: 1,
      inventoryPresenceFilter: "none",
      categoryFilter: ["tools", "tool-accessories", "storage"],
    });
    expect(durables.items.map((row) => row.id)).toEqual([unlocated.id]);
  });
});

/**
 * The detail page shows Expected beside On hand, so the detail response has to
 * carry the same three fields the list row does — from the same derivation.
 *
 * Asserted through the router because the failure mode is a shape that
 * typechecks: the page reads `product.quantityLedger`, and a detail path that
 * forgot to enrich would surface a zero ledger rather than an error.
 */
describe("product.getByID quantity ledger", () => {
  const ctx = withTestDb();

  it("carries the ledger, on-hand and variance, agreeing with the list row", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Detail ledger shelf" }),
      ctx.actor,
    );
    const prod = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Detail Ledger Clamp" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: prod.entityId,
        locationId: shelf.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "clamps",
          cost: 30,
          productId: prod.id,
          productQuantity: 3,
        }),
      ),
      ctx.actor,
    );

    const caller = createTestCaller(productRouter, ctx.db);
    const detail = await caller.getByID({ id: prod.id });

    expect(detail.quantityLedger).toMatchObject({
      acquiredUnits: 3,
      exitedUnits: 0,
      expectedQuantity: 3,
    });
    expect(detail.onHandUnits).toBe(1);
    expect(detail.quantityVariance).toBe(-2);

    // The two surfaces must not be able to disagree — same derivation, so the
    // same numbers for the same product.
    const list = await caller.list({
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    const row = list.items.find((item) => item.id === prod.id);
    expect(row?.quantityLedger).toEqual(detail.quantityLedger);
    expect(row?.onHandUnits).toBe(detail.onHandUnits);
    expect(row?.quantityVariance).toBe(detail.quantityVariance);
  });
});
