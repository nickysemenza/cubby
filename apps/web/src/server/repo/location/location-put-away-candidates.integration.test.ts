/**
 * The put-away candidate roster, against real SQL.
 *
 * The counts are the whole payload — they are what the model reads as
 * corroboration — and every way they can be wrong is a way only Postgres can be
 * wrong: a `filter (where ...)` that forgets to exclude the source product, a
 * soft-deleted row that still satisfies a join, an installed fixture counted as
 * somewhere to put a spare. None of that is decidable from inputs alone.
 */

import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteInventoryEntries } from "~/server/repo/inventory";
import {
  deleteLocations,
  getLocationPutAwayCandidates,
} from "~/server/repo/location";
import { deleteProducts } from "~/server/repo/product";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

describe("getLocationPutAwayCandidates", () => {
  const ctx = withTestDb();

  const amount = { value: 1, unit: "each" };

  const seedLocation = (name: string) =>
    createLocationFixture(ctx.db, makeLocationInput({ name }), TEST_ACTOR);

  const seedProduct = (
    name: string,
    overrides: Parameters<typeof makeProductInput>[0] = {},
  ) =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name, ...overrides }),
      TEST_ACTOR,
    );

  const byName = (
    candidates: Awaited<ReturnType<typeof getLocationPutAwayCandidates>>,
    name: string,
  ) => {
    const found = candidates.find((c) => c.name === name);
    if (!found) throw new Error(`no candidate named ${name}`);
    return found;
  };

  let shelf: Awaited<ReturnType<typeof seedLocation>>;
  let bin: Awaited<ReturnType<typeof seedLocation>>;
  let source: Awaited<ReturnType<typeof seedProduct>>;

  beforeEach(async () => {
    shelf = await seedLocation("Shelf A");
    bin = await seedLocation("Bin B");
    source = await seedProduct("Source Drill", {
      tags: ["m18"],
      manufacturer: "Milwaukee",
      category: "tools",
    });
  });

  it("offers every live location, stocked or not", async () => {
    const candidates = await getLocationPutAwayCandidates(
      ctx.db,
      source.entityId,
    );

    expect(candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Shelf A", "Bin B"]),
    );
    expect(byName(candidates, "Bin B")).toMatchObject({
      itemCount: 0,
      tagSiblings: 0,
      holdsProduct: false,
    });
  });

  it("counts a sibling once per product and never counts the source", async () => {
    const sibling = await seedProduct("Sibling Battery", {
      tags: ["m18"],
      manufacturer: "Milwaukee",
      category: "tools",
    });
    const unrelated = await seedProduct("Unrelated Mug", {
      tags: [],
      manufacturer: "Acme",
      category: "household",
    });
    await createInventoryFixture(
      ctx.db,
      { productId: sibling.id, locationId: shelf.id, amount },
      TEST_ACTOR,
    );
    await createInventoryFixture(
      ctx.db,
      { productId: unrelated.id, locationId: shelf.id, amount },
      TEST_ACTOR,
    );
    await createInventoryFixture(
      ctx.db,
      { productId: source.id, locationId: shelf.id, amount },
      TEST_ACTOR,
    );

    const row = byName(
      await getLocationPutAwayCandidates(ctx.db, source.entityId),
      "Shelf A",
    );

    expect(row.itemCount).toBe(3);
    expect(row.tagSiblings).toBe(1);
    expect(row.manufacturerSiblings).toBe(1);
    expect(row.categorySiblings).toBe(1);
    expect(row.holdsProduct).toBe(true);
  });

  it("does not count an installed fixture as somewhere to put a spare", async () => {
    const sibling = await seedProduct("Wired Sibling", {
      tags: ["m18"],
      manufacturer: "Milwaukee",
      category: "tools",
    });
    await createInventoryFixture(
      ctx.db,
      {
        productId: sibling.id,
        locationId: shelf.id,
        amount,
        placement: "installed",
      },
      TEST_ACTOR,
    );

    const row = byName(
      await getLocationPutAwayCandidates(ctx.db, source.entityId),
      "Shelf A",
    );

    expect(row).toMatchObject({ itemCount: 0, tagSiblings: 0 });
  });

  // Emptying a shelf soft-deletes the entry rather than removing it, so this is
  // the common path, not an edge case: without `notDeleted(inventoryEntry)` the
  // roster would keep crediting a shelf for stock that is no longer on it.
  it("stops counting an emptied entry, and drops a soft-deleted location", async () => {
    const sibling = await seedProduct("Departed Sibling", {
      tags: ["m18"],
      manufacturer: "Milwaukee",
      category: "tools",
    });
    const entry = await createInventoryFixture(
      ctx.db,
      { productId: sibling.id, locationId: shelf.id, amount },
      TEST_ACTOR,
    );
    await deleteInventoryEntries(ctx.db, [entry.entityId], TEST_ACTOR);
    await deleteLocations(ctx.db, [bin.entityId], TEST_ACTOR);

    const candidates = await getLocationPutAwayCandidates(
      ctx.db,
      source.entityId,
    );

    expect(candidates.map((c) => c.name)).not.toContain("Bin B");
    expect(byName(candidates, "Shelf A")).toMatchObject({
      itemCount: 0,
      tagSiblings: 0,
    });
  });

  it("treats the placeholder manufacturer and a null category as no signal", async () => {
    const anonymous = await seedProduct("Anonymous Source", {
      tags: [],
      manufacturer: "(unspecified)",
      category: null,
    });
    const otherAnonymous = await seedProduct("Another Anonymous", {
      tags: [],
      manufacturer: "(unspecified)",
      category: null,
    });
    await createInventoryFixture(
      ctx.db,
      { productId: otherAnonymous.id, locationId: shelf.id, amount },
      TEST_ACTOR,
    );

    const row = byName(
      await getLocationPutAwayCandidates(ctx.db, anonymous.entityId),
      "Shelf A",
    );

    expect(row).toMatchObject({
      itemCount: 1,
      manufacturerSiblings: 0,
      categorySiblings: 0,
    });
  });

  it("returns nothing for a product that does not exist", async () => {
    await deleteProducts(ctx.db, [source.entityId], TEST_ACTOR);

    expect(await getLocationPutAwayCandidates(ctx.db, source.entityId)).toEqual(
      [],
    );
  });
});
