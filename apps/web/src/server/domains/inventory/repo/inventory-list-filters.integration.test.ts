import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { inventoryEntry, location } from "~/server/db/schema";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { inventoryentryList } from "./crud";

type Filters = Parameters<typeof inventoryentryList>[1];

/**
 * Inventory filters compile from the declaration (#2410). Failure modes: a
 * related-path text filter reads the wrong table or misses soft deletes, the
 * stored placement/product filters stop narrowing, the verified range drops
 * its household-day bounds or presence key, the Unknown-location flag inverts,
 * or an entry whose Location is deleted reappears.
 */
describe("inventory list declared filters", () => {
  const ctx = withTestDb();

  const world = async () => {
    const garage = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Parity garage",
        type: "room",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const rack = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Parity rack",
        type: "shelf",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const unknown = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Unknown",
        type: "room",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const gone = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Parity gone shelf",
        type: "shelf",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const drill = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Parity drill",
        manufacturer: "Acme Tools",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    const flour = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Parity flour",
        manufacturer: "Mill Co",
        categoryId: taxonomyShortcode("food"),
      }),
      ctx.actor,
    );
    const stock = (
      product: { id: string },
      where: { id: string },
      placement: "stock" | "installed" = "stock",
    ) =>
      createInventoryFixture(
        ctx.db,
        {
          productId: product.id,
          locationId: where.id,
          amount: { value: 1, unit: "each" },
          placement,
        },
        ctx.actor,
      );
    const drillOnRack = await stock(drill, rack);
    const drillInGarage = await stock(drill, garage);
    const flourInstalled = await stock(flour, garage, "installed");
    const flourUnknown = await stock(flour, unknown);
    const drillGone = await stock(drill, gone);
    // Noon UTC on 2026-03-10 is that household day in every US zone.
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date("2026-03-10T12:00:00Z") })
      .where(eq(inventoryEntry.id, drillOnRack.entityId));
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, gone.entityId));
    return {
      garage,
      drill,
      drillOnRack,
      drillInGarage,
      flourInstalled,
      flourUnknown,
      drillGone,
    };
  };

  const listIds = async (filters: Filters) => {
    const { data, count } = await inventoryentryList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(count).toBe(data.length);
    return new Set(data.map((row) => row.id));
  };

  it("narrows by each declared filter and never returns an entry at a deleted Location", async () => {
    const w = await world();
    const cases: Array<[Filters, Array<{ id: string }>]> = [
      [{ productNameFilter: "parity drill" }, [w.drillOnRack, w.drillInGarage]],
      [{ locationNameFilter: "parity rack" }, [w.drillOnRack]],
      [{ manufacturerFilter: "mill" }, [w.flourInstalled, w.flourUnknown]],
      [{ categoryFeatureFilter: ["food"] }, [w.flourInstalled, w.flourUnknown]],
      [
        { productNameFilter: "parity", placementFilter: ["installed"] },
        [w.flourInstalled],
      ],
      [{ productIdFilter: [w.drill.id] }, [w.drillOnRack, w.drillInGarage]],
      [
        { productNameFilter: "parity", verifiedPresenceFilter: "has" },
        [w.drillOnRack],
      ],
      [
        { productNameFilter: "parity", verifiedPresenceFilter: "none" },
        [w.drillInGarage, w.flourInstalled, w.flourUnknown],
      ],
      [
        { verifiedFrom: "2026-03-10", verifiedTo: "2026-03-10" },
        [w.drillOnRack],
      ],
      [{ verifiedFrom: "2026-03-11" }, []],
      [{ verifiedTo: "2026-03-09" }, []],
      [{ productNameFilter: "parity", locationRole: true }, [w.flourUnknown]],
      [
        { productNameFilter: "parity", locationRole: false },
        [w.drillOnRack, w.drillInGarage, w.flourInstalled],
      ],
    ];
    const mismatches = [];
    for (const [filters, expected] of cases) {
      const actual = [...(await listIds(filters))].sort();
      const wanted = expected.map(({ id }) => id).sort();
      if (actual.join() !== wanted.join())
        mismatches.push({ filters, actual, wanted });
    }
    expect(mismatches).toEqual([]);
  });
});
