import {
  type EntityId,
  type LocationShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { UpcLookupPort } from "~/server/clients/upc-lookup";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
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

// Every scanned product is already local. These external adapters throw on use,
// making a successful scan the behavioral proof that no network lookup occurs.
const unexpectedUsdaClient = (): UsdaFoodLookupPort => ({
  findFood: async (): Promise<FoodSummary | null> => {
    throw new Error("USDA lookup was not expected");
  },
});

const unexpectedUpcLookupClient = (): UpcLookupPort => ({
  lookup: async (): Promise<UPCLookupResponse | null> => {
    throw new Error("UPC lookup was not expected");
  },
  lookupBatch: async () => {
    throw new Error("UPC batch lookup was not expected");
  },
});

describe("scanAtLocation", () => {
  const ctx = withTestDb();

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
      shortcode: parseShortcodeFor("location", out.id),
      entityId: parseEntityId("location", await requireId(out.id, "location")),
    };
  };

  const makeProduct = async (name: string, upc: string) => {
    const out = await quickCreateProduct(ctx.db, { name, upc }, TEST_ACTOR);
    return {
      shortcode: out.id,
      entityId: parseEntityId("product", await requireId(out.id, "product")),
    };
  };

  const scan = (locationId: LocationShortcode, barcode: string) =>
    scanAtLocation(
      ctx.db,
      unexpectedUsdaClient(),
      unexpectedUpcLookupClient(),
      { locationId, code: { kind: "barcode", value: barcode } },
      TEST_ACTOR,
    );

  const rowsAt = async (
    locationEntityId: EntityId<"location">,
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

  // Two reads of the same code moments apart both see "not stocked here" and
  // race to insert. The partial unique index arbitrates; the loser must
  // converge on confirming the winner, not surface a raw 23505.
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
      shortcode: parseShortcodeFor("location", out.id),
      entityId: parseEntityId("location", await requireId(out.id, "location")),
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
    const productId = parseEntityId(
      "product",
      await requireId(product.id, "product"),
    );
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
});
