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
      productQuantity: 1,
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
      productQuantity: 1,
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
});
