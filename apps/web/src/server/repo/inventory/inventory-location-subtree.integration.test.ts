import type { LocationCreateInput } from "@cubby/schemas/location";
import { eq } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { location } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { inventoryentryList } from "~/server/repo/inventory/crud";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

type Filters = Parameters<typeof inventoryentryList>[1];

/**
 * `locationSubtreeFilter` selects a Location's whole subtree; the older
 * `locationIdFilter` stays exact because the Location detail page lists only
 * what is stocked directly there. Failure modes: the subtree filter returns
 * only direct rows, leaks rows under soft-deleted Locations, duplicates rows
 * for overlapping selections, widens for an unresolved code, or the exact
 * filter starts including descendants.
 */
describe("inventory list location filters", () => {
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
  const stockAt = async (name: string, where: { id: string }) => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      ctx.actor,
    );
    return createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: where.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
  };
  const listIds = async (filters: Filters) => {
    const { data } = await inventoryentryList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    return data.map((row) => row.id);
  };

  it("subtree filter includes descendants once each; exact filter stays direct-only", async () => {
    const garage = await place("Subtree garage", TEST_HOME_SHORTCODE, "room");
    const rack = await place("Subtree rack", garage.id);
    const bin = await place("Subtree bin", rack.id);
    const attic = await place("Subtree attic", TEST_HOME_SHORTCODE, "room");
    const direct = await stockAt("Direct widget", garage);
    const deep = await stockAt("Deep widget", bin);
    const outside = await stockAt("Outside widget", attic);

    const subtree = await listIds({ locationSubtreeFilter: garage.id });
    expect(subtree).toHaveLength(2);
    expect(new Set(subtree)).toEqual(new Set([direct.id, deep.id]));
    expect(subtree).not.toContain(outside.id);

    // Overlapping selections do not duplicate rows.
    const overlap = await listIds({
      locationSubtreeFilter: [garage.id, rack.id],
    });
    expect(overlap).toHaveLength(2);

    // The Location detail page relies on this staying direct-only.
    expect(await listIds({ locationIdFilter: garage.id })).toEqual([direct.id]);
  });

  it("excludes soft-deleted descendants and matches nothing for a deleted selection", async () => {
    const cellar = await place("Deleted cellar", TEST_HOME_SHORTCODE, "room");
    const live = await place("Deleted live shelf", cellar.id);
    const gone = await place("Deleted gone shelf", cellar.id);
    const kept = await stockAt("Kept widget", live);
    const lost = await stockAt("Lost widget", gone);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, gone.entityId));

    const ids = await listIds({ locationSubtreeFilter: cellar.id });
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(lost.id);

    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, cellar.entityId));
    expect(await listIds({ locationSubtreeFilter: cellar.id })).toEqual([]);
  });
});
