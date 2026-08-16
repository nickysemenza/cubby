import type { LocationShortcode } from "@cubby/schemas/identifiers";
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
  locationOptions,
  locationSearch,
  updateLocation,
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

// A duplicate-name error has to name the location that is blocking, not just
// report that something is. Without the shortcode the only way to find the
// blocker is a follow-up list_locations scan — which is exactly what the
// generic Postgres translation forced, and it could not even name the column:
// `Key (lower(name))=(ppe)` defeats its `Key (...)=` extraction.
describe("duplicate location names", () => {
  const ctx = withTestDb();

  it("names the conflicting shortcode when creating", async () => {
    const first = await createLocation(
      ctx.db,
      makeLocationInput({ name: "PPE" }),
      ctx.actor,
    );

    await expect(
      createLocation(ctx.db, makeLocationInput({ name: "PPE" }), ctx.actor),
    ).rejects.toThrow(new RegExp(`already exists: ${first.id}`));
  });

  it("matches case-insensitively, like the index does", async () => {
    const first = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Solder Drawer" }),
      ctx.actor,
    );

    // `Location_name_key` is on `lower(name)`, so this collides — and the
    // message must still resolve to the row that actually holds the name.
    await expect(
      createLocation(
        ctx.db,
        makeLocationInput({ name: "solder drawer" }),
        ctx.actor,
      ),
    ).rejects.toThrow(
      new RegExp(`“Solder Drawer” already exists: ${first.id}`),
    );
  });

  it("names the conflicting shortcode when renaming", async () => {
    const taken = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Taken Bin" }),
      ctx.actor,
    );
    const other = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Other Bin" }),
      ctx.actor,
    );
    const otherId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, other.id, "location"))!,
    );

    await expect(
      updateLocation(ctx.db, otherId, { name: "Taken Bin" }, ctx.actor),
    ).rejects.toThrow(new RegExp(`already exists: ${taken.id}`));
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

describe("locationSearch picker rows", () => {
  const ctx = withTestDb();

  const searchFor = (name: string) =>
    locationSearch(
      ctx.db,
      { nameFilter: name },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );

  /** Create a chain root → … → leaf, returning every created location. */
  const makeChain = async (names: string[]) => {
    const created = [];
    let parentId: LocationShortcode | null = null;
    for (const name of names) {
      const node = await createLocation(
        ctx.db,
        makeLocationInput({ name, type: "shelf", parentId }),
        ctx.actor,
      );
      created.push(node);
      parentId = node.id;
    }
    return created;
  };

  const idOf = async (shortcode: string) =>
    unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, shortcode, "location"))!,
    );

  it("returns the ancestor chain root-first, excluding the location itself", async () => {
    const [, , , leaf] = await makeChain([
      "House",
      "Garage",
      "Workbench",
      "tool chest",
    ]);

    const found = await searchFor("tool chest");
    expect(found.data).toHaveLength(1);
    expect(found.data[0]!.id).toBe(leaf!.id);
    expect(found.data[0]!.ancestors.map((a) => a.name)).toEqual([
      "House",
      "Garage",
      "Workbench",
    ]);
  });

  it("returns an empty chain for a top-level location", async () => {
    await createLocation(
      ctx.db,
      makeLocationInput({ name: "Standalone Room", type: "room" }),
      ctx.actor,
    );

    const found = await searchFor("Standalone Room");
    expect(found.data[0]!.ancestors).toEqual([]);
  });

  // A picker resolves a typed name through locationSearch and a typed `LOC-`
  // code through getLocationById's nested parent chain. If the two walks
  // disagreed about soft-deleted rungs, the SAME location would render two
  // different breadcrumbs depending on how the user found it.
  it("agrees with getLocationById's parent chain when an ancestor is soft-deleted", async () => {
    const [, middle, , leaf] = await makeChain([
      "Live Root",
      "Doomed Middle",
      "Live Inner",
      "Deep Bin",
    ]);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, await idOf(middle!.id)));

    const detail = await getLocationById(ctx.db, await idOf(leaf!.id));
    const detailChain: string[] = [];
    for (let node = detail.parent; node; node = node.parent) {
      detailChain.unshift(node.name);
    }

    const found = await searchFor("Deep Bin");
    expect(found.data[0]!.id).toBe(leaf!.id);
    expect(found.data[0]!.ancestors.map((a) => a.name)).toEqual(detailChain);
    // Both keep the deleted rung: Location.parentId is `must-target-live`, so
    // this state is a referential-liveness violation the Problems detector
    // reports — not something two render paths should paper over differently.
    expect(detailChain).toEqual(["Live Root", "Doomed Middle", "Live Inner"]);
  });

  it("stops walking up at the depth cap", async () => {
    const names = Array.from({ length: 13 }, (_, i) => `Level ${i}`);
    const chain = await makeChain(names);

    const found = await searchFor("Level 12");
    expect(found.data[0]!.id).toBe(chain.at(-1)!.id);
    // 10 rungs above the leaf, not the full 12.
    expect(found.data[0]!.ancestors).toHaveLength(10);
    expect(found.data[0]!.ancestors.at(-1)!.name).toBe("Level 11");
  });

  it("picks the first displayable image by sort order as the cover", async () => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Photographed Bin" }),
      ctx.actor,
    );
    const entityId = await idOf(created.id);

    const addImage = async (
      key: string,
      sortOrder: number,
      overrides: { contentType?: string; renderStatus?: "failed" } = {},
    ) => {
      const img = await insertAndReturn(ctx.db, image, {
        key,
        url: `https://example.com/${key}.png`,
        filename: `${key}.png`,
        contentType: overrides.contentType ?? "image/png",
        size: 100,
        status: "UPLOADED",
        ...(overrides.renderStatus
          ? { renderStatus: overrides.renderStatus }
          : {}),
      });
      await insertAndReturn(ctx.db, locationImage, {
        locationId: entityId,
        imageId: img.id,
        sortOrder,
      });
      return img;
    };

    // Sort order 0 is a PDF and 1 a failed render: neither can be drawn, so the
    // cover slot falls through to the first image that actually renders.
    await addImage("bin-manual", 0, { contentType: PDF_CONTENT_TYPE });
    await addImage("bin-broken", 1, { renderStatus: "failed" });
    const usable = await addImage("bin-photo", 2);

    const found = await searchFor("Photographed Bin");
    expect(found.data[0]!.coverImage?.id).toBe(usable.id);
  });

  it("leaves coverImage null when a location has no image", async () => {
    await createLocation(
      ctx.db,
      makeLocationInput({ name: "Bare Bin" }),
      ctx.actor,
    );

    const found = await searchFor("Bare Bin");
    expect(found.data[0]!.coverImage).toBeNull();
  });

  // The breadcrumb-only roster must not carry a `coverImage` key at all —
  // a `null` there would be indistinguishable from "this location has no
  // photo", and the whole point of the split is that picklists don't pay the
  // LocationImage⨝Image load or ship ImageOut they never draw.
  it("omits coverImage entirely from the breadcrumb-only roster", async () => {
    const [, leaf] = await makeChain(["Optioned Room", "Optioned Bin"]);
    const entityId = await idOf(leaf!.id);
    const img = await insertAndReturn(ctx.db, image, {
      key: "optioned-bin",
      url: "https://example.com/optioned-bin.png",
      filename: "optioned-bin.png",
      contentType: "image/png",
      size: 100,
      status: "UPLOADED",
    });
    await insertAndReturn(ctx.db, locationImage, {
      locationId: entityId,
      imageId: img.id,
    });

    const options = await locationOptions(
      ctx.db,
      { nameFilter: "Optioned Bin" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(options.data[0]!.ancestors.map((a) => a.name)).toEqual([
      "Optioned Room",
    ]);
    expect(options.data[0]).not.toHaveProperty("coverImage");

    // Same location, same page — the picker read still resolves the cover.
    const found = await searchFor("Optioned Bin");
    expect(found.data[0]!.coverImage?.id).toBe(img.id);
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

/**
 * The photo pass and the scan landing attach a new photo as the location's
 * COVER while keeping the old ones. `updateLocation` applies `imageOrder`
 * before `associatePendingImages`, so a pending id cannot be ordered in the
 * same call — the client sends a second, order-only update once the join row
 * exists (see `useLocationPhotoCapture`). These assert that sequence really
 * lands the new photo first.
 */
describe("attaching a photo as the new cover", () => {
  const ctx = withTestDb();

  const pendingImage = async (name: string) =>
    await insertAndReturn(ctx.db, image, {
      key: `cover-${name}`,
      url: `https://example.com/cover-${name}.png`,
      filename: `${name}.png`,
      contentType: "image/png",
      size: 100,
      status: "PENDING",
    });

  /** Attach `imageId` and make it the cover, exactly as the capture hook does. */
  const captureAsCover = async (
    shortcode: LocationShortcode,
    imageId: string,
  ) => {
    const id = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, shortcode, "location"))!,
    );
    const { location: attached } = await updateLocation(
      ctx.db,
      id,
      { pendingImageIds: [imageId] },
      ctx.actor,
    );
    const otherIds = attached.images
      .map((img) => img.id)
      .filter((existing) => existing !== imageId);
    if (otherIds.length > 0) {
      await updateLocation(
        ctx.db,
        id,
        { imageOrder: [imageId, ...otherIds] },
        ctx.actor,
      );
    }
    return await getLocationById(ctx.db, id);
  };

  it("puts a first photo on a location that had none", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Bare Shelf" }),
      ctx.actor,
    );
    const img = await pendingImage("first");

    const after = await captureAsCover(shelf.id, img.id);

    expect(after?.images.map((i) => i.id)).toEqual([img.id]);
    // The attach is what flips PENDING → UPLOADED; without it the row is culled.
    expect(after?.images[0]?.status).toBe("UPLOADED");
  });

  it("prepends a retake as the cover and keeps every earlier photo", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Stocked Shelf" }),
      ctx.actor,
    );
    const older = await pendingImage("older");
    const middle = await pendingImage("middle");
    await captureAsCover(shelf.id, older.id);
    await captureAsCover(shelf.id, middle.id);

    const newest = await pendingImage("newest");
    const after = await captureAsCover(shelf.id, newest.id);

    expect(after?.images[0]?.id).toBe(newest.id);
    expect(after?.images.map((i) => i.id)).toEqual([
      newest.id,
      middle.id,
      older.id,
    ]);
  });

  /**
   * Every location in production carries join rows still at the `sortOrder = 0`
   * default. That is the case where an incomplete `imageOrder` silently loses:
   * an id left out of the list keeps its old `0`, TIES the new cover, and the
   * relation's `createdAt` tiebreak hands the cover back to the older photo.
   * Ordering off the attach response (rather than a client-held snapshot) is
   * what keeps the list complete.
   */
  it("wins the cover on legacy rows that all share sortOrder 0", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Legacy Shelf" }),
      ctx.actor,
    );
    const locationId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, shelf.id, "location"))!,
    );

    const legacy = [];
    for (const name of ["legacy-a", "legacy-b", "legacy-c"]) {
      const img = await pendingImage(name);
      await insertAndReturn(ctx.db, locationImage, {
        locationId,
        imageId: img.id,
        sortOrder: 0,
      });
      legacy.push(img.id);
    }

    const newest = await pendingImage("legacy-newest");
    const after = await captureAsCover(shelf.id, newest.id);

    expect(after?.images[0]?.id).toBe(newest.id);
    expect(after?.images).toHaveLength(4);
    for (const id of legacy) {
      expect(after?.images.map((i) => i.id)).toContain(id);
    }
  });

  it("restores the previous cover when the new frame is discarded", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Retaken Shelf" }),
      ctx.actor,
    );
    const keeper = await pendingImage("keeper");
    await captureAsCover(shelf.id, keeper.id);

    const badFrame = await pendingImage("bad-frame");
    await captureAsCover(shelf.id, badFrame.id);

    const locationId = unsafeLocationId(
      (await resolveLiveShortcode(ctx.db, shelf.id, "location"))!,
    );
    await updateLocation(
      ctx.db,
      locationId,
      { removeImageIds: [badFrame.id] },
      ctx.actor,
    );

    const after = await getLocationById(ctx.db, locationId);
    expect(after?.images.map((i) => i.id)).toEqual([keeper.id]);
  });
});
