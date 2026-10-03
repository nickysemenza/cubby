import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createInventoryEntry } from "~/server/repo/inventory/crud";
import { listProductStock } from "~/server/repo/inventory/product-stock";
import { mergeProducts } from "~/server/repo/product/merge";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  dismissProductMatchPair,
  proposeProductMatch,
} from "./product-match.service";
import { getReceivingContext } from "./receiving-context.service";

const namesOnly = {
  vectorStore: {
    configured: () => false,
    upsert: async () => {},
    deleteByIds: async () => {},
    query: async () => [],
    queryById: async () => [],
  },
  semanticConfigured: () => false,
};

// Failure modes: a photo-created stocked Product that is probably the same
// item is invisible at receive time (double count); a dismissed pair keeps
// nagging; the read itself writes stock; a merge adds stock beyond summation.
describe("receiving context", () => {
  const ctx = withTestDb();
  const product = (name: string) =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name, model: null }),
      ctx.actor,
    );
  const stockOf = async (
    entityId: Awaited<ReturnType<typeof product>>["entityId"],
    shelfName: string,
  ) => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: shelfName }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: entityId,
        locationId: shelf.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "inherit",
        ownerLedgerPartyId: null,
      },
      ctx.actor,
    );
  };
  const totalUnits = async (
    ...ids: Awaited<ReturnType<typeof product>>["entityId"][]
  ) =>
    (await Promise.all(ids.map((id) => listProductStock(ctx.db, id))))
      .flat()
      .reduce((sum, row) => sum + row.value, 0);
  const read = (
    productId: Parameters<typeof getReceivingContext>[1]["productId"],
  ) => getReceivingContext(ctx.db, { productId }, namesOnly);

  it("surfaces a stocked photo Product proposed as the same item, and not once dismissed", async () => {
    const photo = await product("Synthetic canvas tote");
    const bought = await product("Canvas tote bag, natural");
    await stockOf(photo.entityId, "Synthetic closet shelf");
    await proposeProductMatch(ctx.db, {
      productIds: [bought.id, photo.id],
      evidence: "Same stitched label on the vendor page",
    });
    const before = await totalUnits(photo.entityId, bought.entityId);

    const context = await read(bought.id);
    expect(context.stock).toEqual([]);
    expect(context.matches).toMatchObject([
      {
        source: "agent",
        evidence: "Same stitched label on the vendor page",
        candidate: { id: photo.id, role: "photo", inventoryCount: 1 },
      },
    ]);
    expect(await totalUnits(photo.entityId, bought.entityId)).toBe(before);

    await dismissProductMatchPair(ctx.db, {
      productIds: [bought.id, photo.id],
    });
    expect((await read(bought.id)).matches).toEqual([]);
  });

  it("returns the Product's own live stock", async () => {
    const own = await product("Synthetic desk lamp");
    await stockOf(own.entityId, "Synthetic desk shelf");
    const context = await read(own.id);
    expect(context.stock).toMatchObject([
      {
        locationName: "Synthetic desk shelf",
        amount: { value: 1, unit: "each" },
      },
    ]);
    expect(context.matches).toEqual([]);
  });

  it("merging a counted photo Product only sums existing stock (BOTH_STOCKED_WARNING)", async () => {
    const photo = await product("Synthetic wool scarf");
    const bought = await product("Wool scarf, grey");
    await stockOf(photo.entityId, "Synthetic scarf shelf");
    await stockOf(bought.entityId, "Synthetic scarf shelf two");
    const before = await totalUnits(photo.entityId, bought.entityId);
    await mergeProducts(
      ctx.db,
      { keepId: bought.id, mergeIds: [photo.id] },
      ctx.actor,
    );
    expect(await totalUnits(photo.entityId, bought.entityId)).toBe(before);
    const survivor = await read(bought.id);
    expect(
      survivor.stock.reduce((sum, entry) => sum + entry.amount.value, 0),
    ).toBe(before);
  });
});
