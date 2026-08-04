import {
  type ProductId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { ProductCreateInput } from "@cubby/schemas/product";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { inventoryEntry, product, productExternalId } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import {
  createProduct,
  mergeProducts,
  previewMergeProducts,
} from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/**
 * `mergeProducts` exists to resolve two structural collisions that a blind FK
 * re-point cannot survive — the per-product `(source, kind)` identifier slot and
 * the `(productId, locationId)` stock slot. Both are partial unique indexes, so
 * getting either wrong doesn't produce a subtly wrong number, it aborts the
 * whole transaction. These tests exercise each one directly rather than through
 * the happy path.
 */
describe("mergeProducts", () => {
  const ctx = withTestDb();

  const resolveId = async (
    shortcode: string,
    entity: "product" | "location",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  const seedProduct = async (
    name: string,
    overrides: Omit<Partial<ProductCreateInput>, "ingredientId"> = {},
  ) => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name, ...overrides }),
      TEST_ACTOR,
    );
    return {
      shortcode: created.id,
      id: unsafeProductId(await resolveId(created.id, "product")),
    };
  };

  const seedLocation = async (name: string) => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return unsafeLocationId(await resolveId(created.id, "location"));
  };

  const liveExternalIds = (productId: ProductId) =>
    getDb(ctx.db).query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, productId),
        notDeleted(productExternalId),
      ),
      columns: { source: true, kind: true, externalId: true, url: true },
    });

  const liveEntries = (productId: ProductId) =>
    getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.productId, productId),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true, locationId: true, amount: true },
    });

  it("soft-deletes the losers and folds their identity into the survivor", async () => {
    const keeper = await seedProduct("Cordless Drill", {
      model: "DCD791D2",
      aliases: ["Drill"],
    });
    const loser = await seedProduct("20V MAX Drill Kit", {
      model: "DCD791D2",
      // The keeper has none of these, so each is a gap the merge fills.
      upc: "012345678905",
      price: 199,
      notes: "From the retailer import",
    });

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.deletedIds).toEqual([loser.shortcode]);
    const rows = await getDb(ctx.db).query.product.findMany({
      where: eq(product.model, "DCD791D2"),
      columns: {
        id: true,
        aliases: true,
        upc: true,
        price: true,
        notes: true,
        deletedAt: true,
      },
    });
    const survivor = rows.find((row) => row.id === keeper.id);
    const dead = rows.find((row) => row.id === loser.id);
    expect(dead?.deletedAt).not.toBeNull();
    // The loser's own name becomes a survivor alias, so a search for the old
    // spelling still lands somewhere.
    expect(survivor?.aliases).toContain("20V MAX Drill Kit");
    expect(survivor?.price).toBe(199);
    expect(survivor?.notes).toBe("From the retailer import");
    // `upc` is adopted only AFTER the loser is soft-deleted — the partial
    // unique `Product_upc_key` would abort the merge otherwise.
    expect(survivor?.upc).toBe("012345678905");
    expect(summary.carriedFields).toContain("upc");
  });

  it("keeps the survivor's value when both fill the same external-id slot", async () => {
    const keeper = await seedProduct("Keeper Grinder", {
      model: "GRINDER-1",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-KEEPER",
          url: null,
        },
      ],
    });
    const loser = await seedProduct("Loser Grinder", {
      model: "GRINDER-1",
      externalIds: [
        // Same slot, different value — the conflict that makes a blind
        // re-point violate `(productId, source, kind)`.
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-LOSER",
          url: "https://example.test/loser",
        },
        // A slot the keeper does NOT fill — this one simply moves.
        {
          source: "amazon",
          kind: "asin",
          externalId: "B00LOSER01",
          url: null,
        },
      ],
    });

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.externalIdsMoved).toBe(1);
    expect(summary.externalIdsDiscarded).toBe(1);

    const survivorIds = await liveExternalIds(keeper.id);
    const bySlot = new Map(
      survivorIds.map((row) => [`${row.source}/${row.kind}`, row]),
    );
    // The keeper's SKU stands; the loser's is gone rather than silently winning.
    expect(bySlot.get("homedepot/retailer_sku")?.externalId).toBe("HD-KEEPER");
    // ...but the url the keeper's row lacked is carried over
    // (fill-never-overwrite).
    expect(bySlot.get("homedepot/retailer_sku")?.url).toBe(
      "https://example.test/loser",
    );
    expect(bySlot.get("amazon/asin")?.externalId).toBe("B00LOSER01");
    // Nothing is left pointing at the merged-away product.
    expect(await liveExternalIds(loser.id)).toHaveLength(0);
  });

  it("sums stock in a shared location instead of losing a row", async () => {
    const shelf = await seedLocation("Merge Shelf");
    const otherShelf = await seedLocation("Merge Other Shelf");
    const keeper = await seedProduct("Keeper Bit Set", { model: "BITS-1" });
    const loser = await seedProduct("Loser Bit Set", { model: "BITS-1" });

    await createInventoryEntry(
      ctx.db,
      {
        productId: keeper.id,
        locationId: shelf,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: shelf,
        amount: { value: 3, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: otherShelf,
        amount: { value: 5, unit: "each" },
      },
      TEST_ACTOR,
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.inventoryMerged).toBe(1);
    expect(summary.inventoryMoved).toBe(1);

    const entries = await liveEntries(keeper.id);
    expect(entries).toHaveLength(2);
    // The colliding entry ADDS rather than one row winning or the insert
    // erroring — the whole point of the fold.
    expect(entries.find((e) => e.locationId === shelf)?.amount.value).toBe(5);
    expect(entries.find((e) => e.locationId === otherShelf)?.amount.value).toBe(
      5,
    );
    expect(await liveEntries(loser.id)).toHaveLength(0);
  });

  // Two losers on ONE shelf. Folding per-row reads the unmutated target each
  // pass, so the second write overwrites the first: 2 + 3 + 4 persists as 6 and
  // a quantity vanishes inside a destructive operation. `planSlotCollisions`
  // groups by target so the sum happens once.
  it("sums every absorbed entry when two losers share the keeper's location", async () => {
    const shelf = await seedLocation("Triple Shelf");
    const keeper = await seedProduct("Keeper Clamp", { model: "CLAMP-1" });
    const loserA = await seedProduct("Loser Clamp A", { model: "CLAMP-1" });
    const loserB = await seedProduct("Loser Clamp B", { model: "CLAMP-1" });

    for (const [product, value] of [
      [keeper, 2],
      [loserA, 3],
      [loserB, 4],
    ] as const) {
      await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: shelf,
          amount: { value, unit: "each" },
        },
        TEST_ACTOR,
      );
    }

    const summary = await mergeProducts(
      ctx.db,
      {
        keepId: keeper.shortcode,
        mergeIds: [loserA.shortcode, loserB.shortcode],
      },
      TEST_ACTOR,
    );

    expect(summary.inventoryMerged).toBe(2);
    const entries = await liveEntries(keeper.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount.value).toBe(9);
    expect(await liveEntries(loserA.id)).toHaveLength(0);
    expect(await liveEntries(loserB.id)).toHaveLength(0);
  });

  it("refuses — and previews a blocker — when shared-location units disagree", async () => {
    const shelf = await seedLocation("Mismatch Shelf");
    const keeper = await seedProduct("Keeper Screws", { model: "SCREW-1" });
    const loser = await seedProduct("Loser Screws", { model: "SCREW-1" });

    await createInventoryEntry(
      ctx.db,
      {
        productId: keeper.id,
        locationId: shelf,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: shelf,
        amount: { value: 1, unit: "box" },
      },
      TEST_ACTOR,
    );

    // The preview surfaces it BEFORE the destructive action, which is the only
    // thing a preview is allowed to gate confirmation on.
    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]?.code).toBe("block-inventory-unit-mismatch");

    await expect(
      mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/different units/);

    // Nothing was written — the whole merge rolls back.
    const survivor = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, loser.id),
      columns: { deletedAt: true },
    });
    expect(survivor?.deletedAt).toBeNull();
  });
});
