import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "./expense";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { createWish, wishList } from "./wish";

const pagination = { pageIndex: 0, pageSize: 50 };

/**
 * `wishFilterFields` spreads `auditDateFilterFields` and `wishRelatedFilterFields`,
 * and the filter manifest renders controls for both — so if `buildWishWhere`
 * doesn't apply them, the UI sends filters the server silently ignores. That is
 * the same manifest/server drift the wishlist rebuild set out to remove, only
 * pointing the other way, and nothing else catches it: the manifest unit test
 * checks that every emitted field EXISTS on the schema, not that the repo reads
 * it.
 */
describe("wishList filters", () => {
  const ctx = withTestDb();

  it("applies the related-candidate search the manifest exposes", async () => {
    const matching = await createProduct(
      ctx.db,
      makeProductInput({ name: "Domino Joining Machine", category: "tools" }),
      ctx.actor,
    );
    const other = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unrelated Bench Grinder", category: "tools" }),
      ctx.actor,
    );
    const { output: wanted } = await createWish(
      ctx.db,
      {
        name: "loose tenon joinery",
        notes: null,
        candidateProductIds: [matching.id],
      },
      ctx.actor,
    );
    await createWish(
      ctx.db,
      {
        name: "sharpening station",
        notes: null,
        candidateProductIds: [other.id],
      },
      ctx.actor,
    );

    const { data } = await wishList(
      ctx.db,
      { productSearch: "Domino" },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([wanted.id]);
  });

  it("applies the audit date range the manifest exposes", async () => {
    const { output: created } = await createWish(
      ctx.db,
      { name: "audit range wish", notes: null, candidateProductIds: [] },
      ctx.actor,
    );

    // A window starting well after every row was created must exclude it. Left
    // unapplied, `createdFrom` is dropped and this returns the row anyway.
    const future = await wishList(
      ctx.db,
      { createdFrom: "2999-01-01" },
      [],
      pagination,
    );
    expect(future.data.map((row) => row.id)).not.toContain(created.id);

    const past = await wishList(
      ctx.db,
      { createdFrom: "2000-01-01" },
      [],
      pagination,
    );
    expect(past.data.map((row) => row.id)).toContain(created.id);
  });
});

/**
 * The list's price-range column derives each row's low/high in TS from the
 * hydrated `candidates[].price` (`loadProductPricing`), while the footer totals
 * come from a SQL aggregate over the whole filtered set
 * (`effectiveProductPriceSql`). Two implementations of one rule — so assert
 * they agree, including on the derived-from-Expense path where the two are
 * most likely to drift.
 */
describe("wishList price ranges", () => {
  const ctx = withTestDb();

  /** A Tool whose effective price comes from acquisition history, not `price`. */
  const createExpensePricedTool = async (name: string, unitCost: number) => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name, category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: `${name} purchase`,
        productId: tool.id,
        productQuantity: 2,
        cost: unitCost * 2,
      }),
      ctx.actor,
    );
    return tool;
  };

  it("spans priced candidates and sums low/high over the filtered set", async () => {
    const cheap = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Budget Track Saw",
        category: "tools",
        price: 200,
      }),
      ctx.actor,
    );
    const dear = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Premium Track Saw",
        category: "tools",
        price: 650,
      }),
      ctx.actor,
    );
    // No explicit price and no expense history — unknown, not free. It must
    // stay out of the range rather than dragging the low down to $0.
    const unpriced = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unpriced Track Saw", category: "tools" }),
      ctx.actor,
    );
    const derived = await createExpensePricedTool("Refurb Domino", 425);

    const { output: sawWish } = await createWish(
      ctx.db,
      {
        name: "track saw",
        notes: null,
        candidateProductIds: [cheap.id, dear.id, unpriced.id],
      },
      ctx.actor,
    );
    const { output: dominoWish } = await createWish(
      ctx.db,
      { name: "domino", notes: null, candidateProductIds: [derived.id] },
      ctx.actor,
    );
    // Nothing priced at all: contributes no range and nothing to the totals.
    await createWish(
      ctx.db,
      { name: "open idea", notes: null, candidateProductIds: [unpriced.id] },
      ctx.actor,
    );

    const { data, sums } = await wishList(ctx.db, {}, [], pagination);
    const rowPrices = (id: string) =>
      data
        .find((row) => row.id === id)!
        .candidates.flatMap((c) => (c.price === null ? [] : [c.price]));

    expect(rowPrices(sawWish.id)).toEqual(expect.arrayContaining([200, 650]));
    expect(rowPrices(sawWish.id)).toHaveLength(2);
    // A lone candidate is both the high and the low.
    expect(rowPrices(dominoWish.id)).toEqual([425]);

    // Footer totals: sum of each row's low, and of each row's high.
    expect(sums.priceLow).toBeCloseTo(200 + 425, 2);
    expect(sums.priceHigh).toBeCloseTo(650 + 425, 2);
  });

  it("scopes the totals to the filter, not the page", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Filtered Tool", category: "tools", price: 90 }),
      ctx.actor,
    );
    const { output: wanted } = await createWish(
      ctx.db,
      { name: "still wanted", notes: null, candidateProductIds: [tool.id] },
      ctx.actor,
    );
    const other = await createProduct(
      ctx.db,
      makeProductInput({ name: "Bought Tool", category: "tools", price: 40 }),
      ctx.actor,
    );
    await createWish(
      ctx.db,
      { name: "already bought", notes: null, candidateProductIds: [other.id] },
      ctx.actor,
    );

    const all = await wishList(ctx.db, {}, [], pagination);
    expect(all.sums.priceHigh).toBeCloseTo(130, 2);

    const scoped = await wishList(
      ctx.db,
      { candidateProductId: tool.id },
      [],
      pagination,
    );
    expect(scoped.data.map((row) => row.id)).toEqual([wanted.id]);
    expect(scoped.sums.priceLow).toBeCloseTo(90, 2);
    expect(scoped.sums.priceHigh).toBeCloseTo(90, 2);
  });

  it("sorts by the range midpoint", async () => {
    const seed = async (name: string, prices: number[]) => {
      const products = await Promise.all(
        prices.map((price, index) =>
          createProduct(
            ctx.db,
            makeProductInput({
              name: `${name} option ${index}`,
              category: "tools",
              price,
            }),
            ctx.actor,
          ),
        ),
      );
      const { output } = await createWish(
        ctx.db,
        {
          name,
          notes: null,
          candidateProductIds: products.map((product) => product.id),
        },
        ctx.actor,
      );
      return output.id;
    };

    // Midpoints: 150, 300, 500. Note the widest range does NOT have the
    // highest low or the highest high on its own — only the midpoint orders
    // these three correctly.
    const narrowLow = await seed("narrow low", [140, 160]);
    const wide = await seed("wide", [100, 500]);
    const narrowHigh = await seed("narrow high", [480, 520]);

    const asc = await wishList(
      ctx.db,
      {},
      [{ orderBy: "priceRange", direction: "asc" }],
      pagination,
    );
    expect(asc.data.map((row) => row.id)).toEqual([
      narrowLow,
      wide,
      narrowHigh,
    ]);

    const desc = await wishList(
      ctx.db,
      {},
      [{ orderBy: "priceRange", direction: "desc" }],
      pagination,
    );
    expect(desc.data.map((row) => row.id)).toEqual([
      narrowHigh,
      wide,
      narrowLow,
    ]);
  });
});
