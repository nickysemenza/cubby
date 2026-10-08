import { calendarRangeInput } from "@cubby/schemas/calendar";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getCalendarRange } from "./calendar";
import { getCollectionDetail } from "./collection";
import { createExpense } from "./expense/crud";
import {
  attachProductComponents,
  listKitMembership,
} from "./product-components";
import { loadProductMatchSides } from "./product-match";
import {
  getProductMovementTimeline,
  toEntityTimeline,
} from "./product/movement-timeline";
import {
  attachPurchaseProducts,
  listProductPurchases,
} from "./purchase-products";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor } from "./vendor";

describe("undated Purchase readers", () => {
  const ctx = withTestDb();

  it("retains undated Product and kit history without inventing chronology or calendar positions", async () => {
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic undated kit",
        tags: ["collection:undated-history"],
      }),
      ctx.actor,
    );
    const component = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic kit component" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: component.entityId, quantity: 1 }],
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Synthetic undated vendor",
    );
    const undated = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: null,
      orderId: "UNDATED",
    });
    await attachPurchaseProducts(ctx.db, undated.id, [kit.entityId], ctx.actor);

    expect(await listProductPurchases(ctx.db, kit.entityId)).toMatchObject([
      { purchaseId: undated.shortcode, date: null },
    ]);
    expect(
      (await listKitMembership(ctx.db, component.entityId))[0]?.purchase,
    ).toMatchObject({ purchaseId: undated.shortcode, date: null });
    expect(
      (await loadProductMatchSides(ctx.db, [kit.entityId])).get(kit.entityId)
        ?.purchase,
    ).toMatchObject({ id: undated.shortcode, date: null });
    const timelineInput = {
      ids: [kit.id],
      filters: {},
      order: "desc",
      pagination: { pageIndex: 0, pageSize: 20 },
    } as const;
    const history = await getProductMovementTimeline(ctx.db, timelineInput);
    expect(history.groups).toMatchObject([
      { date: null, purchase: { id: undated.shortcode, date: null } },
    ]);
    expect(
      (
        await getProductMovementTimeline(ctx.db, {
          ...timelineInput,
          from: "2026-03-01",
          to: "2026-03-31",
        })
      ).groups,
    ).toEqual([]);

    const dated = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-03-04",
      orderId: "DATED",
    });
    await attachPurchaseProducts(ctx.db, dated.id, [kit.entityId], ctx.actor);
    expect(
      (await listProductPurchases(ctx.db, kit.entityId)).map(
        (row) => row.purchaseId,
      ),
    ).toEqual([dated.shortcode, undated.shortcode]);
    const collection = await getCollectionDetail(
      ctx.db,
      "undated-history",
      undefined,
      { pageIndex: 0, pageSize: 20 },
    );
    expect(
      collection?.products[0]?.purchases.map((row) => ({
        id: row.id,
        date: row.date,
      })),
    ).toEqual([
      { id: dated.shortcode, date: "2026-03-04" },
      { id: undated.shortcode, date: null },
    ]);
    expect(
      (await listKitMembership(ctx.db, component.entityId))[0]?.purchase
        ?.purchaseId,
    ).toBe(dated.shortcode);
    expect(
      (await loadProductMatchSides(ctx.db, [kit.entityId])).get(kit.entityId)
        ?.purchase?.id,
    ).toBe(dated.shortcode);
    expect(
      toEntityTimeline(history).groups[0]?.events[0]?.detail,
    ).not.toContain("Purchase date null");
  });

  it("positions only a known Expense date even when its Purchase date is unknown", async () => {
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Synthetic calendar vendor",
    );
    const parent = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: null,
      orderId: "CALENDAR",
    });
    const dated = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Known ledger date",
        date: "2026-03-04",
        purchaseId: parent.shortcode,
      }),
      ctx.actor,
    );
    const undated = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Unknown ledger date",
        date: null,
        cost: null,
        purchaseId: parent.shortcode,
      }),
      ctx.actor,
    );
    const calendar = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-03-01",
        endDateExclusive: "2026-03-08",
        kinds: ["expense"],
      }),
    );
    expect(calendar.days["2026-03-04"]?.itemIds).toContain(dated.output.id);
    expect(
      Object.values(calendar.days).flatMap((day) => day.itemIds),
    ).not.toContain(undated.output.id);
  });
});
