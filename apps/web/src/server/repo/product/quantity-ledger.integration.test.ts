import type { ProductId } from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "../expense";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "../repo.fixtures";
import { loadProductQuantityLedgers } from "./quantity-ledger";

/**
 * The ledger rule, exercised against a real database.
 *
 * Every case here is a shape that exists in the production ledger, and several
 * are shapes an earlier draft of the rule got wrong — the negative-cost line
 * that stores a POSITIVE quantity (302 live rows do), and the $0 line whose
 * sign is the only thing distinguishing a freebie from a discard.
 */
describe("loadProductQuantityLedgers", () => {
  const ctx = withTestDb();

  const seed = (overrides: Partial<ExpenseCreateInput>) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput(overrides)),
      ctx.actor,
    );

  const ledgerFor = async (productId: ProductId) =>
    (await loadProductQuantityLedgers(ctx.db, [productId])).get(productId);

  it("nets acquisitions against every kind of exit", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Outlet Box" }),
      ctx.actor,
    );

    await seed({
      name: "bought 8",
      cost: 33.44,
      productId: prod.id,
      productQuantity: 8,
    });
    // A return: negative cost, POSITIVE quantity — the shape 302 live rows use.
    // The sign of the money decides, so this is 8 units leaving.
    await seed({
      name: "returned 8",
      cost: -33.44,
      productId: prod.id,
      productQuantity: 8,
    });
    await seed({
      name: "bought 2 more",
      cost: 9,
      productId: prod.id,
      productQuantity: 2,
    });

    expect(await ledgerFor(prod.entityId)).toEqual({
      acquiredUnits: 10,
      exitedUnits: 8,
      expectedQuantity: 2,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
    });
  });

  it("reads a $0 line by its quantity's sign", async () => {
    const freebie = await createProduct(
      ctx.db,
      makeProductInput({ name: "Promo Battery" }),
      ctx.actor,
    );
    const discarded = await createProduct(
      ctx.db,
      makeProductInput({ name: "Kahuna Burner" }),
      ctx.actor,
    );

    // The ambiguity the signed quantity exists to resolve: both lines cost $0.
    await seed({
      name: "promo pack",
      cost: 0,
      productId: freebie.id,
      productQuantity: 1,
    });
    await seed({
      name: "bought",
      cost: 165,
      productId: discarded.id,
      productQuantity: 1,
    });
    await seed({
      name: "Discarded — Kahuna Burner",
      cost: 0,
      productId: discarded.id,
      productQuantity: -1,
    });

    expect((await ledgerFor(freebie.entityId))?.expectedQuantity).toBe(1);
    expect(await ledgerFor(discarded.entityId)).toEqual({
      acquiredUnits: 1,
      exitedUnits: 1,
      expectedQuantity: 0,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
    });
  });

  it("goes negative rather than clamping — that is the defect signal", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Circular Saw" }),
      ctx.actor,
    );
    // The acquisition was never recorded, so the sale has nothing to net against.
    await seed({
      name: "sold",
      cost: -60,
      productId: prod.id,
      productQuantity: 1,
    });

    expect((await ledgerFor(prod.entityId))?.expectedQuantity).toBe(-1);
  });

  it("counts an unrecorded quantity rather than guessing at one", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Old Receipt Item" }),
      ctx.actor,
    );
    await seed({
      name: "bought 3",
      cost: 30,
      productId: prod.id,
      productQuantity: 3,
    });
    // The receipt proves the cost but not the count. Reading it as one unit is
    // exactly the silent guess the nullable column exists to prevent.
    await seed({
      name: "bought ?",
      cost: 10,
      productId: prod.id,
      productQuantity: null,
    });
    await seed({
      name: "returned ?",
      cost: -10,
      productId: prod.id,
      productQuantity: null,
    });

    expect(await ledgerFor(prod.entityId)).toEqual({
      acquiredUnits: 3,
      exitedUnits: 0,
      expectedQuantity: 3,
      unknownAcquisitionLines: 1,
      unknownExitLines: 1,
    });
  });

  it("ignores planned spend — `future` rows are not on any shelf yet", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "On Order" }),
      ctx.actor,
    );
    await seed({
      name: "have 2",
      cost: 20,
      productId: prod.id,
      productQuantity: 2,
    });
    await seed({
      name: "ordered 5 more",
      cost: 50,
      productId: prod.id,
      productQuantity: 5,
      future: true,
    });

    // 2, not 7 — planned spend has not arrived, so it is not expected on hand.
    expect((await ledgerFor(prod.entityId))?.expectedQuantity).toBe(2);
  });

  it("returns nothing for a product with no ledger, rather than a zero row", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Untouched" }),
      ctx.actor,
    );
    // The caller substitutes EMPTY_QUANTITY_LEDGER — "no rows" and "nets zero"
    // are different facts, and the map keeps them distinguishable.
    expect(await ledgerFor(prod.entityId)).toBeUndefined();
  });
});
