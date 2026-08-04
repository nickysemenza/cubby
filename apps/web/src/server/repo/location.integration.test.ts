import { unsafeLocationId, unsafeProductId } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { image, location, locationImage, product } from "~/server/db/schema";
import { getDb, insertAndReturn } from "./database-helpers";
import { createInventoryEntry } from "./inventory";
import {
  bulkReparentLocations,
  createLocation,
  findOrCreateLocationByName,
  getLocationById,
  locationList,
} from "./location";
import { createProduct } from "./product";
import { makeLocationInput, makeProductInput } from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";

describe("findOrCreateLocationByName", () => {
  const ctx = withTestDb();

  it("returns the existing location on a repeat call (no duplicate)", async () => {
    const first = await findOrCreateLocationByName(
      ctx.db,
      "Pantry",
      null,
      "room",
    );
    expect(first.created).toBe(true);

    const second = await findOrCreateLocationByName(
      ctx.db,
      "Pantry",
      null,
      "room",
    );
    expect(second.created).toBe(false);
    expect(second.locationId).toEqual(first.locationId);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(location);
    expect(result!.count).toEqual(1);
  });

  it("recovers from a concurrent create race instead of 500ing", async () => {
    // Cross-request race, deterministically forced (the findOrCreate primitive's
    // conflict branch): a "winner" txn inserts the same-named location and holds
    // its lock open while our call runs. Our SELECT misses (winner uncommitted),
    // the INSERT ... ON CONFLICT DO NOTHING blocks on the lock; once the winner
    // commits, DO NOTHING returns no row and the re-SELECT finds the winner —
    // no unique-violation 500, no duplicate.
    const name = "Garage";

    let releaseWinner!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    let winnerId = "";
    const winner = getDb(ctx.db).transaction(async (tx) => {
      const [row] = await tx
        .insert(location)
        .values({ name, type: "room", shortcode: "LRACE1" })
        .returning();
      winnerId = row!.id;
      await winnerCommitted; // hold the txn (and its lock) open
    });

    // Let the winner reach (and hold) its uncommitted INSERT.
    await new Promise((r) => setTimeout(r, 100));

    const loser = findOrCreateLocationByName(ctx.db, name, null, "room");

    // Give the call time to reach its blocked INSERT, then commit the winner.
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, result] = await Promise.all([winner, loser]);

    // Recovered onto the winner's row — no throw, no duplicate.
    expect(result.created).toBe(false);
    expect(result.locationId).toEqual(winnerId);

    const [countRow] = await getDb(ctx.db)
      .select({ count: count() })
      .from(location)
      .where(eq(location.name, name));
    expect(countRow!.count).toEqual(1);
  });
});

describe("bulkReparentLocations", () => {
  const ctx = withTestDb();

  // Regression: `inArray` collapses duplicate ids in the UPDATE, so the
  // `updated.length !== ids.length` guard used to trip a spurious
  // LOCATION_NOT_FOUND whenever `ids` contained a repeat. Only the router
  // caller deduped before this fix — the repo function itself now dedupes,
  // so the invariant travels with the exported function regardless of caller.
  it("tolerates a duplicate id in the ids array", async () => {
    const parent = await createLocation(
      ctx.db,
      makeLocationInput({ name: "New Parent" }),
      ctx.actor,
    );
    const child = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Reparented Child" }),
      ctx.actor,
    );

    const childId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, child.id, "location"))!,
    );
    const parentId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, parent.id, "location"))!,
    );

    await expect(
      bulkReparentLocations(ctx.db, [childId, childId], parentId, ctx.actor),
    ).resolves.toBeUndefined();

    const updated = await getLocationById(ctx.db, childId);
    expect(updated.parent?.id).toEqual(parent.id);
  });
});

describe("locationList parentPresenceFilter", () => {
  const ctx = withTestDb();

  it("filters to root locations with 'none' and to children with 'has'", async () => {
    const root = await createLocation(
      ctx.db,
      { name: "Kitchen", aliases: [], type: "room", parentId: null },
      ctx.actor,
    );
    const child = await createLocation(
      ctx.db,
      { name: "Pantry Shelf", aliases: [], type: "shelf", parentId: root.id },
      ctx.actor,
    );

    const rootsOnly = await locationList(
      ctx.db,
      { parentPresenceFilter: "none" },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(rootsOnly.data.map((l) => l.id)).toEqual([root.id]);

    const childrenOnly = await locationList(
      ctx.db,
      { parentPresenceFilter: "has" },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(childrenOnly.data.map((l) => l.id)).toEqual([child.id]);
  });

  describe("inventoryPresenceFilter", () => {
    const listWith = (filters: Parameters<typeof locationList>[1]) =>
      locationList(ctx.db, filters, [{ orderBy: "name", direction: "asc" }], {
        pageIndex: 0,
        pageSize: 50,
      });

    it("partitions stocked shelves from empty ones", async () => {
      const stocked = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Stocked Shelf" }),
        ctx.actor,
      );
      const empty = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Empty Shelf" }),
        ctx.actor,
      );
      const p = await createProduct(
        ctx.db,
        makeProductInput({ name: "Shelf Product" }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: unsafeProductId(
            (await resolveLiveShortcode(ctx.db, p.id, "product"))!,
          ),
          locationId: unsafeLocationId(
            (await resolveLiveShortcode(ctx.db, stocked.id, "location"))!,
          ),
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const has = await listWith({ inventoryPresenceFilter: "has" });
      expect(has.data.map((l) => l.id)).toContain(stocked.id);
      expect(has.data.map((l) => l.id)).not.toContain(empty.id);
      expect(has.count).toBe(has.data.length);

      const none = await listWith({ inventoryPresenceFilter: "none" });
      expect(none.data.map((l) => l.id)).toContain(empty.id);
      expect(none.data.map((l) => l.id)).not.toContain(stocked.id);

      const atLeastOne = await listWith({ directItemCountMin: 1 });
      expect(atLeastOne.data.map((l) => l.id)).toContain(stocked.id);
      expect(atLeastOne.data.map((l) => l.id)).not.toContain(empty.id);

      const zeroItems = await listWith({ directItemCountMax: 0 });
      expect(zeroItems.data.map((l) => l.id)).toContain(empty.id);
      expect(zeroItems.data.map((l) => l.id)).not.toContain(stocked.id);

      // Inventory count sorting must use the live relation, not this persisted
      // valuation snapshot (which can temporarily lag inventory mutations).
      await getDb(ctx.db)
        .update(location)
        .set({
          valuation: {
            directValuation: 0,
            totalValuation: 0,
            directItemCount: 999,
            totalItemCount: 999,
            direct: { priced: 0, missingPricing: 0, miscNoPrice: 0 },
            total: { priced: 0, missingPricing: 0, miscNoPrice: 0 },
          },
        })
        .where(
          eq(
            location.id,
            unsafeLocationId(
              (await resolveLiveShortcode(ctx.db, empty.id, "location"))!,
            ),
          ),
        );
      const sorted = await locationList(
        ctx.db,
        {},
        [{ orderBy: "inventoryEntries", direction: "desc" }],
        { pageIndex: 0, pageSize: 50 },
      );
      expect(sorted.data.findIndex((l) => l.id === stocked.id)).toBeLessThan(
        sorted.data.findIndex((l) => l.id === empty.id),
      );
    });

    /**
     * The subquery inner-joins Product with notDeleted to match
     * `dbLocationToListAPI`, which drops entries whose product is soft-deleted
     * (`isNotDeleted(entry.product)`). Without the join such a shelf renders
     * empty but filters as stocked.
     *
     * The state is written directly here because `deleteProducts` refuses a
     * product that still has live inventory (PRODUCT_HAS_INVENTORY), so the
     * single-delete path can't produce it. Both the mapper's filter and this
     * join are defensive against the paths that don't go through that guard —
     * this test pins that the two stay in agreement either way.
     */
    it("a shelf holding only a soft-deleted product counts as empty", async () => {
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Ghost Stock Shelf" }),
        ctx.actor,
      );
      const doomed = await createProduct(
        ctx.db,
        makeProductInput({ name: "Doomed Shelf Product" }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: unsafeProductId(
            (await resolveLiveShortcode(ctx.db, doomed.id, "product"))!,
          ),
          locationId: unsafeLocationId(
            (await resolveLiveShortcode(ctx.db, shelf.id, "location"))!,
          ),
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ deletedAt: new Date() })
        .where(
          eq(
            product.id,
            unsafeProductId(
              (await resolveLiveShortcode(ctx.db, doomed.id, "product"))!,
            ),
          ),
        );

      const none = await listWith({ inventoryPresenceFilter: "none" });
      const row = none.data.find((l) => l.id === shelf.id);
      expect(row).toBeDefined();
      // The filter and the rendered cell must agree.
      expect(row?.inventoryEntries).toEqual([]);

      const has = await listWith({ inventoryPresenceFilter: "has" });
      expect(has.data.map((l) => l.id)).not.toContain(shelf.id);

      const zeroItems = await listWith({ directItemCountMax: 0 });
      expect(zeroItems.data.map((l) => l.id)).toContain(shelf.id);
    });
  });
});

describe("locationList imagePresenceFilter", () => {
  const ctx = withTestDb();

  const listWith = (filters: Parameters<typeof locationList>[1]) =>
    locationList(ctx.db, filters, [{ orderBy: "name", direction: "asc" }], {
      pageIndex: 0,
      pageSize: 50,
    });

  /** Create a location and attach one image to it, returning the shortcode id. */
  const locationWithImage = async (
    name: string,
    overrides: {
      contentType?: string;
      imageDeleted?: boolean;
      joinDeleted?: boolean;
    } = {},
  ) => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      ctx.actor,
    );
    const entityId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, created.id, "location"))!,
    );
    const img = await insertAndReturn(ctx.db, image, {
      key: `location-presence-${name}`,
      url: "https://example.com/location-presence.png",
      filename: "location-presence.png",
      contentType: overrides.contentType ?? "image/png",
      size: 100,
      status: "UPLOADED",
      ...(overrides.imageDeleted ? { deletedAt: new Date() } : {}),
    });
    await insertAndReturn(ctx.db, locationImage, {
      locationId: entityId,
      imageId: img.id,
      ...(overrides.joinDeleted ? { deletedAt: new Date() } : {}),
    });
    return created.id;
  };

  it("partitions locations with a displayable image from those without", async () => {
    const withImage = await locationWithImage("Photographed Shelf");
    const withoutImage = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Unphotographed Shelf" }),
      ctx.actor,
    );

    const has = await listWith({ imagePresenceFilter: "has" });
    expect(has.data.map((l) => l.id)).toEqual([withImage]);
    expect(has.count).toBe(has.data.length);

    // "none" must return the complement — every other live location — not zero
    // rows, which is the NOT IN / NULL trap `idSetPresence` warns about.
    const none = await listWith({ imagePresenceFilter: "none" });
    expect(none.data.map((l) => l.id)).toContain(withoutImage.id);
    expect(none.data.map((l) => l.id)).not.toContain(withImage);
  });

  it("counts a PDF-only, soft-deleted-image, or detached-association location as having no image", async () => {
    const pdfOnly = await locationWithImage("Manual Only Shelf", {
      contentType: PDF_CONTENT_TYPE,
    });
    const imageDeleted = await locationWithImage("Deleted Image Shelf", {
      imageDeleted: true,
    });
    const joinDeleted = await locationWithImage("Detached Image Shelf", {
      joinDeleted: true,
    });

    const has = await listWith({ imagePresenceFilter: "has" });
    expect(has.data).toHaveLength(0);

    const none = await listWith({ imagePresenceFilter: "none" });
    const noneIds = none.data.map((l) => l.id);
    expect(noneIds).toContain(pdfOnly);
    expect(noneIds).toContain(imageDeleted);
    expect(noneIds).toContain(joinDeleted);

    // The filter and the rendered cell must agree: a soft-deleted ASSOCIATION
    // must not still hand the thumbnail column an image to draw.
    const detachedRow = none.data.find((l) => l.id === joinDeleted);
    expect(detachedRow?.images).toEqual([]);
  });
});
