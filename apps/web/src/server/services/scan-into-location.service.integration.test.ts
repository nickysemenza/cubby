import {
  type LocationShortcode,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import {
  createInventoryEntry,
  getInventoryByLocationIds,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { quickCreateProduct } from "~/server/repo/product";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  resolveScanStrays,
  scanAtLocation,
} from "./scan-into-location.service";

// Every product in this suite is seeded with its barcode already known, so
// `findOrCreateByCode` short-circuits on the local lookup and never reaches
// these. They exist to satisfy the signature, and asserting they stay unused
// is itself part of the contract: a sweep of a stocked shelf must not fan out
// to USDA or the UPC worker on every read.
const fakeUsdaClient = (): USDAClient =>
  ({
    findFood: vi.fn(async (): Promise<FoodSummary | null> => null),
  }) as unknown as USDAClient;

const fakeUpcLookupClient = (): UPCLookupClient => {
  const single = vi.fn(async (): Promise<UPCLookupResponse | null> => null);
  return {
    lookup: single,
    lookupBatch: vi.fn(async () => new Map()),
  } as unknown as UPCLookupClient;
};

describe("scanAtLocation", () => {
  const ctx = withTestDb();
  const each = { value: 1, unit: "each" };

  const requireId = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  const makeLocation = async (name: string) => {
    const out = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return {
      shortcode: out.id as LocationShortcode,
      entityId: unsafeLocationId(await requireId(out.id, "location")),
    };
  };

  const makeProduct = async (name: string, upc: string) => {
    const out = await quickCreateProduct(ctx.db, { name, upc }, TEST_ACTOR);
    return {
      shortcode: out.id,
      entityId: unsafeProductId(await requireId(out.id, "product")),
    };
  };

  const scan = (locationId: LocationShortcode, barcode: string) =>
    scanAtLocation(
      ctx.db,
      fakeUsdaClient(),
      fakeUpcLookupClient(),
      { locationId, code: { kind: "barcode", value: barcode } },
      TEST_ACTOR,
    );

  const rowsAt = async (
    locationEntityId: ReturnType<typeof unsafeLocationId>,
    productShortcode: string,
  ) => {
    const entries = await getInventoryByLocationIds(
      ctx.db,
      [locationEntityId],
      { placement: "all" },
    );
    return entries.filter((entry) => entry.product.id === productShortcode);
  };

  it("adds a row, stamped verified, when nothing is stocked anywhere", async () => {
    const shelf = await makeLocation("Bookshelf A");
    const product = await makeProduct("Dune", "012345678905");

    const result = await scan(shelf.shortcode, "012345678905");

    expect(result.outcome).toBe("added");
    expect(result.strays).toEqual([]);
    const rows = await rowsAt(shelf.entityId, product.shortcode);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verifiedAt).not.toBeNull();
  });

  // The core of the presence-sweep model. Sweeping the same shelf twice must
  // leave every amount alone — an increment here would double a bookshelf.
  it("confirms without changing the amount when it is already on this shelf", async () => {
    const shelf = await makeLocation("Bookshelf B");
    const product = await makeProduct("Neuromancer", "012345678906");
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: shelf.entityId,
        amount: { value: 3, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await scan(shelf.shortcode, "012345678906");

    expect(result.outcome).toBe("confirmed");
    const rows = await rowsAt(shelf.entityId, product.shortcode);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toEqual({ value: 3, unit: "each" });
    expect(rows[0]?.verifiedAt).not.toBeNull();
  });

  it("queues without writing when the only copy lives elsewhere", async () => {
    const office = await makeLocation("Office shelf");
    const shelf = await makeLocation("Bookshelf C");
    const product = await makeProduct("Snow Crash", "012345678907");
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: office.entityId,
        amount: each,
      },
      TEST_ACTOR,
    );

    const result = await scan(shelf.shortcode, "012345678907");

    expect(result.outcome).toBe("queued");
    expect(result.strays).toHaveLength(1);
    expect(result.strays[0]?.location.id).toBe(office.shortcode);
    expect(result.strays[0]?.ambiguousQuantity).toBe(false);
    expect(await rowsAt(shelf.entityId, product.shortcode)).toEqual([]);
    expect(await rowsAt(office.entityId, product.shortcode)).toHaveLength(1);
  });

  it("never treats an installed fixture as stock to pull in", async () => {
    const wall = await makeLocation("Kitchen wall");
    const shelf = await makeLocation("Parts bin");
    const product = await makeProduct("Faucet", "012345678908");
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: wall.entityId,
        amount: each,
        placement: "installed",
      },
      TEST_ACTOR,
    );

    const result = await scan(shelf.shortcode, "012345678908");

    expect(result.outcome).toBe("added");
    expect(result.strays).toEqual([]);
  });

  it("flags a multi-unit source row as an ambiguous move", async () => {
    const pantry = await makeLocation("Pantry");
    const shelf = await makeLocation("Counter");
    const product = await makeProduct("Flour", "012345678909");
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: pantry.entityId,
        amount: { value: 5, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await scan(shelf.shortcode, "012345678909");

    expect(result.strays[0]?.ambiguousQuantity).toBe(true);
  });

  it("stocks a scanned Cubby product label without creating anything", async () => {
    const shelf = await makeLocation("Bookshelf E");
    const product = await makeProduct("Labelled thing", "012345678913");

    const result = await scanAtLocation(
      ctx.db,
      fakeUsdaClient(),
      fakeUpcLookupClient(),
      {
        locationId: shelf.shortcode,
        code: { kind: "product", value: product.shortcode },
      },
      TEST_ACTOR,
    );

    expect(result.outcome).toBe("added");
    expect(result.product.created).toBe(false);
    expect(await rowsAt(shelf.entityId, product.shortcode)).toHaveLength(1);
  });

  // Two reads of the same code moments apart both see "not stocked here" and
  // race to insert. The partial unique index arbitrates; the loser must
  // converge on confirming the winner, not surface a raw 23505.
  it("converges on one row when the same code is scanned concurrently", async () => {
    const shelf = await makeLocation("Bookshelf D");
    const product = await makeProduct("Anathem", "012345678910");

    const results = await Promise.all([
      scan(shelf.shortcode, "012345678910"),
      scan(shelf.shortcode, "012345678910"),
    ]);

    const rows = await rowsAt(shelf.entityId, product.shortcode);
    expect(rows).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "added",
      "confirmed",
    ]);
  });
});

describe("resolveScanStrays", () => {
  const ctx = withTestDb();
  const each = { value: 1, unit: "each" };

  const requireId = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  const makeLocation = async (name: string) => {
    const out = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return {
      shortcode: out.id as LocationShortcode,
      entityId: unsafeLocationId(await requireId(out.id, "location")),
    };
  };

  it("moves the queued strays and reports the ones already gone", async () => {
    const source = await makeLocation("Old room");
    const target = await makeLocation("New shelf");
    const product = await quickCreateProduct(
      ctx.db,
      { name: "Stray book", upc: "012345678911" },
      TEST_ACTOR,
    );
    const productId = unsafeProductId(await requireId(product.id, "product"));
    const entry = await createInventoryEntry(
      ctx.db,
      { productId, locationId: source.entityId, amount: each },
      TEST_ACTOR,
    );

    const result = await resolveScanStrays(
      ctx.db,
      { targetLocationId: target.shortcode, moves: [{ entryId: entry.id }] },
      TEST_ACTOR,
    );

    expect(result.moved).toBe(1);
    expect(result.skipped).toEqual([]);

    // Replaying is a skip, not a failure. The destination was empty, so the row
    // kept its id and simply moved — which makes the second attempt
    // `already-here`, not `already-moved`. Those are different facts and the
    // caller can tell them apart.
    const replay = await resolveScanStrays(
      ctx.db,
      { targetLocationId: target.shortcode, moves: [{ entryId: entry.id }] },
      TEST_ACTOR,
    );

    expect(replay.moved).toBe(0);
    expect(replay.skipped).toHaveLength(1);
    expect(replay.skipped[0]?.entryId).toBe(entry.id);
    expect(replay.skipped[0]?.reason).toBe("already-here");
  });

  // The other half: a full move ONTO an existing row of the same product sums
  // the quantities and HARD-deletes the source, so the queued id genuinely
  // stops existing. This is the case the re-read exists for.
  it("reports a stray whose source row a merge consumed", async () => {
    const source = await makeLocation("Merge source");
    const target = await makeLocation("Merge target");
    const product = await quickCreateProduct(
      ctx.db,
      { name: "Merged book", upc: "012345678914" },
      TEST_ACTOR,
    );
    const productId = unsafeProductId(await requireId(product.id, "product"));
    const sourceEntry = await createInventoryEntry(
      ctx.db,
      { productId, locationId: source.entityId, amount: each },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      { productId, locationId: target.entityId, amount: each },
      TEST_ACTOR,
    );

    const result = await resolveScanStrays(
      ctx.db,
      {
        targetLocationId: target.shortcode,
        moves: [{ entryId: sourceEntry.id }],
      },
      TEST_ACTOR,
    );
    expect(result.moved).toBe(1);

    const replay = await resolveScanStrays(
      ctx.db,
      {
        targetLocationId: target.shortcode,
        moves: [{ entryId: sourceEntry.id }],
      },
      TEST_ACTOR,
    );

    expect(replay.moved).toBe(0);
    expect(replay.skipped[0]?.reason).toBe("already-moved");
  });

  it("skips a stray that already sits at the target", async () => {
    const target = await makeLocation("Target shelf");
    const product = await quickCreateProduct(
      ctx.db,
      { name: "Homebody", upc: "012345678912" },
      TEST_ACTOR,
    );
    const productId = unsafeProductId(await requireId(product.id, "product"));
    const entry = await createInventoryEntry(
      ctx.db,
      { productId, locationId: target.entityId, amount: each },
      TEST_ACTOR,
    );

    const result = await resolveScanStrays(
      ctx.db,
      { targetLocationId: target.shortcode, moves: [{ entryId: entry.id }] },
      TEST_ACTOR,
    );

    expect(result.moved).toBe(0);
    expect(result.skipped[0]?.reason).toBe("already-here");
    expect(result.skipped[0]?.message).toBe("Already here.");
  });
});
