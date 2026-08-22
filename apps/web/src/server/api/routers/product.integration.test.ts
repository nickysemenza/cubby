import type { ProductCategory } from "@cubby/schemas/product";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
} from "@cubby/schemas/project";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "~/server/repo/expense";
import { deleteInventoryEntries } from "~/server/repo/inventory";
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

    expect(result.siblings).toEqual([
      {
        id: sibling.id,
        name: "Sibling",
        manufacturer: "Sibling Maker",
        category: null,
        tags: ["shared", "sibling-only"],
      },
    ]);
    expect(result.siblings[0]?.id).not.toBe(sibling.entityId);
    // Nothing is stocked, so the storage half has nothing to say.
    expect(result.tagStorage).toEqual([]);
  });
});

describe("product.tagSiblings storage rollup", () => {
  const ctx = withTestDb();

  const stock = (
    productId: string,
    locationId: string,
    placement?: "installed",
  ) =>
    createInventoryFixture(
      ctx.db,
      {
        productId,
        locationId,
        amount: { value: 1, unit: "count" },
        ...(placement ? { placement } : {}),
      },
      ctx.actor,
    );

  it("counts distinct siblings per location, excluding the viewed product", async () => {
    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Garage", type: "room" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Shelf A", type: "shelf", parentId: room.id }),
      ctx.actor,
    );
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Bin 3", type: "box" }),
      ctx.actor,
    );

    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["m18"] }),
      ctx.actor,
    );
    const [a, b, c] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "A", tags: ["m18"] }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "B", tags: ["m18"] }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "C", tags: ["m18"] }),
        ctx.actor,
      ),
    ]);

    await stock(a.id, shelf.id);
    await stock(b.id, shelf.id);
    await stock(c.id, bin.id);
    // The viewed product is on the shelf too: it marks, it does not count.
    await stock(source.id, shelf.id);

    const caller = createTestCaller(productRouter, ctx.db);
    const { tagStorage } = await caller.tagSiblings(source.id);

    expect(tagStorage).toEqual([
      {
        tag: "m18",
        omittedLocationCount: 0,
        locations: [
          {
            id: shelf.id,
            name: "Shelf A",
            ancestors: [
              { id: TEST_HOME_SHORTCODE, name: "Home", type: "house" },
              { id: room.id, name: "Garage", type: "room" },
            ],
            productCount: 2,
            holdsSource: true,
          },
          {
            id: bin.id,
            name: "Bin 3",
            ancestors: [
              { id: TEST_HOME_SHORTCODE, name: "Home", type: "house" },
            ],
            productCount: 1,
            holdsSource: false,
          },
        ],
      },
    ]);
  });

  it("omits installed fixtures and soft-deleted entries", async () => {
    const wall = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Wall", type: "room" }),
      ctx.actor,
    );
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["dimmer"] }),
      ctx.actor,
    );
    const fixture = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Wired In", tags: ["dimmer"] }),
      ctx.actor,
    );
    const removed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Removed", tags: ["dimmer"] }),
      ctx.actor,
    );

    await stock(fixture.id, wall.id, "installed");
    const goneEntry = await stock(removed.id, wall.id);
    await deleteInventoryEntries(ctx.db, [goneEntry.entityId], ctx.actor);

    const caller = createTestCaller(productRouter, ctx.db);
    const { siblings, tagStorage } = await caller.tagSiblings(source.id);

    // Both are still siblings — only their storage is out of scope.
    expect(siblings.map((s) => s.name).sort()).toEqual(["Removed", "Wired In"]);
    expect(tagStorage).toEqual([]);
  });

  it("caps the list and discloses the remainder", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["festool"] }),
      ctx.actor,
    );

    // Six locations, each holding one sibling, so ranking is by name.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const loc = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `Spot ${n}`, type: "shelf" }),
        ctx.actor,
      );
      const sibling = await createProductFixture(
        ctx.db,
        makeProductInput({ name: `Sibling ${n}`, tags: ["festool"] }),
        ctx.actor,
      );
      await stock(sibling.id, loc.id);
    }

    const caller = createTestCaller(productRouter, ctx.db);
    const { tagStorage } = await caller.tagSiblings(source.id);

    expect(tagStorage).toHaveLength(1);
    expect(tagStorage[0]?.locations.map((l) => l.name)).toEqual([
      "Spot 1",
      "Spot 2",
      "Spot 3",
      "Spot 4",
    ]);
    expect(tagStorage[0]?.omittedLocationCount).toBe(2);
  });

  it("drops a tag whose only stocked product is the viewed one", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Lone Shelf", type: "shelf" }),
      ctx.actor,
    );
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["lonely"] }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unstocked Sibling", tags: ["lonely"] }),
      ctx.actor,
    );
    await stock(source.id, shelf.id);

    const caller = createTestCaller(productRouter, ctx.db);
    const { siblings, tagStorage } = await caller.tagSiblings(source.id);

    expect(siblings).toHaveLength(1);
    // `holdsSource` alone is not a reason to show a row — that is just this
    // product's own Stocked At table, restated.
    expect(tagStorage).toEqual([]);
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

describe("product.quantitySummaries", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput(overrides)),
      ctx.actor,
    );

  it("returns the list's comparable and mixed-unit quantity semantics by shortcode", async () => {
    const shelfA = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Summary shelf A" }),
      ctx.actor,
    );
    const shelfB = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Summary shelf B" }),
      ctx.actor,
    );
    const agreeing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Summary agreeing" }),
      ctx.actor,
    );
    const mismatched = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Summary mismatched" }),
      ctx.actor,
    );
    const mixed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Summary mixed" }),
      ctx.actor,
    );

    await Promise.all([
      createInventoryFixture(
        ctx.db,
        {
          productId: agreeing.entityId,
          locationId: shelfA.entityId,
          amount: { value: 3, unit: "each" },
        },
        ctx.actor,
      ),
      createInventoryFixture(
        ctx.db,
        {
          productId: mismatched.entityId,
          locationId: shelfA.entityId,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      ),
      createInventoryFixture(
        ctx.db,
        {
          productId: mixed.entityId,
          locationId: shelfA.entityId,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      ),
      createInventoryFixture(
        ctx.db,
        {
          productId: mixed.entityId,
          locationId: shelfB.entityId,
          amount: { value: 1, unit: "can" },
        },
        ctx.actor,
      ),
    ]);
    await Promise.all([
      seedLine({ productId: agreeing.id, productQuantity: 3, cost: 3 }),
      seedLine({ productId: mismatched.id, productQuantity: 2, cost: 2 }),
      seedLine({ productId: mixed.id, productQuantity: 2, cost: 2 }),
    ]);

    const summaries = await createTestCaller(
      productRouter,
      ctx.db,
    ).quantitySummaries({ ids: [agreeing.id, mismatched.id, mixed.id] });

    expect(summaries[agreeing.id]).toMatchObject({
      quantityLedger: { expectedQuantity: 3 },
      onHandUnits: 3,
      quantityVariance: 0,
    });
    expect(summaries[mismatched.id]).toMatchObject({
      quantityLedger: { expectedQuantity: 2 },
      onHandUnits: 1,
      quantityVariance: -1,
    });
    expect(summaries[mixed.id]).toMatchObject({
      quantityLedger: { expectedQuantity: 2 },
      onHandUnits: null,
      quantityVariance: null,
    });
  });
});

/**
 * The `unlocated` saved views select on `expectedQuantityMin` + an inventory
 * presence of `none` — two filters that already existed but were never combined
 * or tested. This is the behavioural contract behind them; the manifest entries
 * are only a preset over this query.
 *
 * It is deliberately the complement of the variance filters above:
 * `quantityVarianceFilter` is scoped to products that are present and in the
 * ledger, and `onHandUnitsSql` is NULL for a zero-entry shelf, so nothing in
 * that pair can reach a product that is owned on paper and held nowhere.
 *
 * "Present" means EITHER form — stock on a shelf, or a Location that IS the
 * product. Which is why this cohort has to exclude both: a bin in daily service
 * is not "stocked nowhere", and admitting it here would put the same row in two
 * views telling contradictory stories.
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

  /**
   * The two halves of one product identity: a tote can be owned on paper and
   * simultaneously BE a bin you store things in. Before `location.productId`
   * that was unrepresentable, so every such product looked stocked nowhere.
   *
   * Both assertions below fail against a shelf-only variance gate — the first
   * because the cohort never reaches a product with no `InventoryEntry`, the
   * second because the filter it selects on did not exist.
   */
  it("keeps bins-in-service out of unlocated and inside shelf-disagrees", async () => {
    const tote = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "G Tough Tote", category: "storage" }),
      ctx.actor,
    );
    // Three in service as bins, eight on the receipt: short five, and not a
    // single InventoryEntry anywhere. The production shape of PRD-Y7TZ.
    for (const name of ["Tote bin A", "Tote bin B", "Tote bin C"]) {
      await createLocationFixture(
        ctx.db,
        makeLocationInput({ name, productId: tote.id }),
        ctx.actor,
      );
    }
    await seedLine({
      name: "totes",
      cost: 80,
      productId: tote.id,
      productQuantity: 8,
    });

    // Present as locations, so the variance gate must admit it.
    const disagreeing = await list({ quantityVarianceFilter: "mismatched" });
    expect(disagreeing.items.map((row) => row.id)).toContain(tote.id);
    const row = disagreeing.items.find((item) => item.id === tote.id);
    expect(row).toMatchObject({ onHandUnits: 3, quantityVariance: -5 });

    // ...and the unlocated cohort must not, or both views claim the same row.
    const cohort = await list({
      expectedQuantityMin: 1,
      inventoryPresenceFilter: "none",
      servingAsLocationPresenceFilter: "none",
    });
    expect(cohort.items.map((item) => item.id)).not.toContain(tote.id);

    // The filter is a real predicate in both directions, not a no-op that
    // happens to leave the set unchanged.
    const inService = await list({ servingAsLocationPresenceFilter: "has" });
    expect(inService.items.map((item) => item.id)).toContain(tote.id);
  });

  /**
   * The third form of presence. A kit split into a composition record keeps the
   * Expense and holds no stock of its own — the shelf claim moved to its parts —
   * so it is not "stocked nowhere", it is stocked as its components.
   *
   * The parts are also the ACTIONABLE rows, which is the real argument for
   * suppressing the parent rather than merely tidying it away: a component's
   * expected quantity is the kit's units projected down through
   * `ProductComponent`, so an unstocked part matches this cohort on its own.
   * Listing the parent too reports one gap twice and less precisely — it names
   * the box instead of the missing piece.
   */
  it("keeps a decomposed kit out of unlocated, but never its unstocked parts", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Kit cohort room" }),
      ctx.actor,
    );
    const mk = (name: string) =>
      createProductFixture(
        ctx.db,
        makeProductInput({ name, category: "household" }),
        ctx.actor,
      );
    const kit = await mk("H Nightstand Set");
    const stockedPart = await mk("I Nightstand");
    const missingPart = await mk("J Drawer Pull");

    // The whole cost basis sits on the kit; neither part has an Expense.
    await seedLine({
      name: "nightstand set",
      cost: 172.21,
      productId: kit.id,
      productQuantity: 1,
    });
    await caller.attachComponents({
      parentProductId: kit.id,
      components: [
        { productId: stockedPart.id, quantity: 2 },
        { productId: missingPart.id, quantity: 1 },
      ],
    });
    await createInventoryFixture(
      ctx.db,
      {
        productId: stockedPart.entityId,
        locationId: room.entityId,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );

    const cohort = await list({
      expectedQuantityMin: 1,
      inventoryPresenceFilter: "none",
      componentPresenceFilter: "none",
    });
    const ids = cohort.items.map((item) => item.id);
    // The kit: its stock is on the shelf, under another name.
    expect(ids).not.toContain(kit.id);
    // The stocked part: present, so it was never in this cohort anyway.
    expect(ids).not.toContain(stockedPart.id);
    // The gap that is actually real, and the row worth acting on.
    expect(ids).toContain(missingPart.id);

    // The predicate does the work, rather than the kit happening to fall out
    // for some other reason: drop it and the parent is admitted again.
    const withoutFilter = await list({
      expectedQuantityMin: 1,
      inventoryPresenceFilter: "none",
    });
    expect(withoutFilter.items.map((item) => item.id)).toContain(kit.id);
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
