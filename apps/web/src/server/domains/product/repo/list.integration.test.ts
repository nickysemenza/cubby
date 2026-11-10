import { type LocationCreateInput } from "@cubby/schemas/entities/location";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  TEST_ACTOR,
  TEST_HOME_SHORTCODE,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import { location, product } from "~/server/db/schema";
import { createIngredient } from "~/server/domains/ingredient/repo/crud";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createPlantFixture,
  createProductFixture,
  createProductIdentityFixture,
  listProductsFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { productScaffold } from "./crud";
import { loadProductPriceSum, loadProductPricing } from "./pricing";
import { loadProductQuantityLedgers } from "./quantity-ledger";

/**
 * `ingredientIdFilter` (the SKU's own ingredient) and `growsPlantIdFilter`
 * (the crop this product seeds — the Product↔Ingredient "grows" relation) are
 * independent shortcode-resolved id filters on `productScaffold.where`; each must
 * narrow by its own column, not the other's.
 */
describe("product list id filters", () => {
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
    const flourBag = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet",
        growsPlantId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await listProductsFixture(
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
    const flourBag = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag 2", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet 2",
        growsPlantId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await listProductsFixture(
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
    const kit = await createProductIdentityFixture(
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
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Example kit acquisition",
        productId: kit.id,
        productQuantity: 1,
        cost: 90,
      }),
    );

    await drainStoredDerived(ctx.db);
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

    const page = await listProductsFixture(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page.data).toHaveLength(2);
    expect((await productScaffold.totals(ctx.db, {}))?.price).toBeCloseTo(
      159.99,
      2,
    );
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
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          name,
          productId,
          cost,
          productQuantity,
        }),
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
    await drainStoredDerived(ctx.db);
    expect(await loadProductPriceSum(ctx.db, filtered)).toBeCloseTo(9.75, 2);

    await getDb(ctx.db).execute(sql`UPDATE "EntityLink"
      SET "deletedAt" = now()
      WHERE "kind" = 'productComponent'
        AND "fromEntityId" = ${outer.entityId}
        AND "toEntityId" = ${sibling.entityId}`);
    const after = await loadProductPricing(ctx.db, products);
    expect(after.get(leaf.entityId)?.derivedPrice).toBe(10);
    expect(after.get(other.entityId)?.effectivePrice).toBe(2.25);
    expect(await loadProductPriceSum(ctx.db, filtered)).toBeCloseTo(9.75, 2);
    await drainStoredDerived(ctx.db);
    expect(await loadProductPriceSum(ctx.db, filtered)).toBeCloseTo(12.25, 2);
  });
});

// Failures: the base page can accidentally retain hidden enrichment SQL or
// expose FK UUIDs; patch IDs can bypass the authoritative filters; deferred
// pricing/ledger/USDA can drift from legacy full rows; summary can total only
// the loaded page or exclude real negative Expense lines.
describe("product list staged projections", () => {
  const ctx = withTestDb();

  it("restricts derived patches through existing filters and preserves full price and ledger arithmetic", async () => {
    const included = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Staged derived", price: 17 }),
      ctx.actor,
    );
    const excluded = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Other derived", price: 31 }),
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Staged purchase",
        productId: included.id,
        cost: 30,
        productQuantity: 3,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Staged refund",
        productId: included.id,
        cost: -10,
        productQuantity: -1,
      }),
    );
    const filters = { ids: [included.id, excluded.id], nameFilter: "Staged" };
    const pagination = { pageIndex: 0, pageSize: 50 };
    await drainStoredDerived(ctx.db);
    const full = await listProductsFixture(ctx.db, filters, [], pagination);
    const enrichment = await productScaffold.read(ctx.db, {
      filters,
      sorts: [],
      pagination,
      projection: [
        "price",
        "pricing",
        "quantityLedger",
        "onHandUnits",
        "quantityVariance",
        "expenseTotal",
      ],
    });
    expect(enrichment.data).toHaveLength(1);
    expect(enrichment.data[0]).toMatchObject({
      id: included.id,
      price: full.data[0]!.price,
      pricing: full.data[0]!.pricing,
      quantityLedger: full.data[0]!.quantityLedger,
      onHandUnits: full.data[0]!.onHandUnits,
      quantityVariance: full.data[0]!.quantityVariance,
      expenseTotal: 20,
    });
    expect(enrichment.data[0]?.pricing).toMatchObject({
      effectivePrice: 17,
      derivedPrice: 10,
      knownUnitCount: 3,
    });
    expect(enrichment.data[0]?.quantityLedger).toMatchObject({
      acquiredUnits: 3,
      exitedUnits: 1,
      expectedQuantity: 2,
    });
    expect(enrichment.data[0]).not.toHaveProperty("displayImages");
    expect(enrichment.data[0]).not.toHaveProperty("dataQuality");
    expect(enrichment).not.toHaveProperty("sums");
  });
});

/**
 * The Product `locationIdFilter` selects a Location's whole subtree: a person
 * filtering by "Garage" expects what sits on its shelves. Failure modes: only
 * the exact Location matches; a soft-deleted descendant or the walk through
 * one leaks stock; a parentId cycle loops; a Product stocked in two selected
 * nodes duplicates its row; a deleted or unknown selection widens instead of
 * matching nothing.
 */
describe("product list location subtree filter", () => {
  const ctx = withTestDb();

  const place = async (
    name: string,
    parentCode: NonNullable<LocationCreateInput["parentId"]>,
    type: "room" | "shelf" = "shelf",
  ) => {
    const loc = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name, type, parentId: parentCode }),
      ctx.actor,
    );
    return { id: loc.id, entityId: loc.entityId };
  };
  const stock = async (name: string, where: { id: string }[]) => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    for (const loc of where) {
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }
    return item;
  };
  const listAt = async (
    locationIdFilter: NonNullable<
      Parameters<typeof listProductsFixture>[1]["locationIdFilter"]
    >,
  ): Promise<string[]> => {
    const { data } = await listProductsFixture(
      ctx.db,
      { locationIdFilter },
      [],
      {
        pageIndex: 0,
        pageSize: 50,
      },
    );
    return data.map((row) => row.id);
  };

  it("includes products stocked in descendants, one row each, and nothing outside the subtree", async () => {
    const garage = await place("Subtree garage", TEST_HOME_SHORTCODE, "room");
    const rack = await place("Subtree rack", garage.id);
    const bin = await place("Subtree bin", rack.id);
    const attic = await place("Subtree attic", TEST_HOME_SHORTCODE, "room");
    const direct = await stock("Direct widget", [garage]);
    const deep = await stock("Deep widget", [bin]);
    const twice = await stock("Twice widget", [garage, rack, bin]);
    const outside = await stock("Outside widget", [attic]);

    const ids = await listAt(garage.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([direct.id, deep.id, twice.id]));
    expect(ids).not.toContain(outside.id);
    // Selecting a leaf stays narrow.
    const leafIds = await listAt(bin.id);
    expect(new Set(leafIds)).toEqual(new Set([deep.id, twice.id]));
  });

  it("ignores soft-deleted descendants and does not walk through them", async () => {
    const cellar = await place("Deleted cellar", TEST_HOME_SHORTCODE, "room");
    const live = await place("Deleted live shelf", cellar.id);
    const gone = await place("Deleted gone shelf", cellar.id);
    const beyond = await place("Deleted beyond bin", gone.id);
    const kept = await stock("Kept widget", [live]);
    const lost = await stock("Lost widget", [gone]);
    const beyondItem = await stock("Beyond widget", [beyond]);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, gone.entityId));

    const ids = await listAt(cellar.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(lost.id);
    expect(ids).not.toContain(beyondItem.id);
  });

  it("terminates on a parentId cycle", async () => {
    const a = await place("Cycle A", TEST_HOME_SHORTCODE, "room");
    const b = await place("Cycle B", a.id);
    const item = await stock("Cycle widget", [b]);
    await getDb(ctx.db)
      .update(location)
      .set({ parentId: b.entityId })
      .where(eq(location.id, a.entityId));
    expect(await listAt(a.id)).toEqual([item.id]);
  });
});

// The Expected, Variance and Unit price cells print server-composed text
// (`display.labelPath`), so no client re-derives the ledger's uncertainty.
describe("product list display labels", () => {
  const ctx = withTestDb();

  it("discloses unquantified ledger lines in the Expected label", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Label ledger bolt" }),
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Label bought 3",
        productId: product.id,
        cost: 30,
        productQuantity: 3,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Label bought ?",
        productId: product.id,
        cost: 10,
        productQuantity: null,
      }),
    );
    const { data } = await listProductsFixture(
      ctx.db,
      { ids: [product.id] },
      [],
      {
        pageIndex: 0,
        pageSize: 10,
      },
    );
    expect(data).toHaveLength(1);
    expect(data[0]?.ledgerExpectedQuantityLabel).toBe("3 +1?");
    // Nothing on the shelf: there is no shelf-versus-ledger variance to print.
    expect(data[0]?.quantityVarianceLabel).toBeNull();
  });
});
