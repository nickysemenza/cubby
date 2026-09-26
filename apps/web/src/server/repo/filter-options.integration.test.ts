import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getFilterOptions } from "./filter-options";
import { createIngredient } from "./ingredient";
import { createPurchase } from "./purchase";
import { findOrCreateVendor, getVendorByID } from "./vendor";

describe("entity reference filter options", () => {
  const ctx = withTestDb();

  it("searches live shortcode entities and hydrates selected values outside the page query", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Selected winter squash" },
      TEST_ACTOR,
    );
    await createIngredient(
      ctx.db,
      { name: "Unrelated summer herb" },
      TEST_ACTOR,
    );

    const searched = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "winter squash",
      selectedIds: [],
      limit: 25,
      include: [],
    });
    expect(searched.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);

    const hydrated = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "no page match",
      selectedIds: [crop.id],
      limit: 25,
      include: [],
    });
    expect(hydrated.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);
  });

  // The vendor picker ranks its roster by live purchase count and shows each
  // vendor's logo; both used to come from a dedicated `vendor.options` read.
  it("projects counts and logos, ordering a counted roster by usage", async () => {
    const vendorCode = async (name: string) =>
      (await getVendorByID(ctx.db, await findOrCreateVendor(ctx.db, name))).id;
    const quiet = await vendorCode("Aardvark hardware");
    const busy = await vendorCode("Zephyr lumber");
    for (const orderId of ["ORDER-A", "ORDER-B"])
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId: busy,
          date: "2026-08-01",
          orderId,
        }),
        TEST_ACTOR,
      );

    const roster = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "vendor",
      search: "",
      selectedIds: [],
      limit: 1000,
      include: ["count", "logo"],
    });
    expect(
      roster.items.map(({ id, count, logo }) => ({ id, count, logo })),
    ).toEqual([
      { id: busy, count: 2, logo: null },
      { id: quiet, count: 0, logo: null },
    ]);

    await expect(
      getFilterOptions(ctx.db, {
        source: "entity",
        entity: "ingredient",
        search: "",
        selectedIds: [],
        limit: 25,
        include: ["count"],
      }),
    ).rejects.toThrow("Filter option counts are not defined for ingredient");
  });
});
