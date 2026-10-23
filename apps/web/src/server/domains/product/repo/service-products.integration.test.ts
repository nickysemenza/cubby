import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { expense, product } from "~/server/db/schema";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  productPricingSummary,
  productStockSummary,
} from "~/server/generic/entity-report/repo/summary";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import {
  createProductIdentityFixture,
  createInventoryFixture,
  createLocationFixture,
  makeLocationInput,
  makeExpenseInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { listProductsRead, productList } from "./crud";
import { loadProductOwnershipTimelines } from "./ownership";
import { loadExactEffectivePrices, loadProductPriceSum } from "./pricing";
import {
  attachProductComponents,
  listProductComponents,
} from "./product-components";
import {
  loadProductPickerQuantities,
  loadProductQuantitySummaries,
} from "./quantity-ledger";
import { getProductWithFood } from "./write/product-writes";

describe("category-based service Products", () => {
  const ctx = withTestDb();

  it.each(["services", "software"] as const)(
    "keeps %s bills out of stock and valuation while retaining variable charges",
    async (feature) => {
      const rootId = taxonomyShortcode(feature);
      const child = await createRepoEntity(ctx, "productCategory", {
        name: "Synthetic service child",
        feature: null,
        parentId: rootId,
      });
      const service = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic metered service",
          categoryId: child.output.id,
          price: 123,
        }),
        ctx.actor,
      );
      for (const [date, cost, quantity] of [
        ["2026-01-01", 40, 10],
        ["2026-02-01", 90, 30],
        ["2026-03-01", -10, -1],
      ] as const) {
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            productId: service.id,
            date,
            cost,
            productQuantity: quantity,
          }),
        );
      }
      const detail = await getProductWithFood(
        ctx.db,
        { findFood: async () => null },
        service.entityId,
      );
      expect(detail.category?.feature).toBe(feature);
      expect(detail.price).toBe(123); // Stored intent survives; it does not value a service.
      expect(detail.pricing.effectivePrice).toBeNull();
      expect(detail.pricing.cost).toMatchObject({
        amount: 65,
        label: "$65.00 / charge",
        chargeCount: 2,
        latestCharge: 90,
      });
      expect(detail.unitPriceDetailLabel).toContain("Not applicable");
      expect(detail.fieldResolutions?.price?.source).toBe(
        "not applicable to services",
      );
      expect(detail.quantityLedger.acquiredUnits).toBe(0);
      expect(detail.onHandUnits).toBeNull();
      expect(detail.quantityVariance).toBeNull();
      expect(detail.stockStatusItems).toEqual([]);
      expect(detail.ownershipEvidence).toEqual({
        state: "uncertain",
        acquiredAt: null,
        exitedAt: null,
        confidenceLostAt: null,
      });

      const selected = await listProductsRead(
        ctx.db,
        { ids: [service.id] },
        [],
        { pageIndex: 0, pageSize: 1 },
        "page",
        undefined,
        selectedListProjection("product", [
          "pricing",
          "onHandUnits",
          "stockStatusItems",
          "ledgerExpectedQuantityLabel",
        ]),
      );
      expect(selected.data[0]).toMatchObject({
        pricing: {
          effectivePrice: null,
          cost: { amount: 65, chargeCount: 2, latestCharge: 90 },
        },
        onHandUnits: null,
        stockStatusItems: [],
        ledgerExpectedQuantityLabel: null,
      });
      const valued = [{ id: service.entityId, price: 123 }];
      expect(
        (await loadExactEffectivePrices(ctx.db, valued)).get(service.entityId),
      ).toBeNull();
      expect(
        await loadProductPriceSum(ctx.db, eq(product.id, service.entityId)),
      ).toBe(0);
      const priced = await productList(
        ctx.db,
        { ids: [service.id], pricePresenceFilter: "has" },
        [],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(priced.data).toEqual([]);
      // Scalar sorts have no GROUP BY; their service guard must aggregate too.
      const sorted = await productList(
        ctx.db,
        { ids: [service.id] },
        [
          { orderBy: "price", direction: "asc" },
          { orderBy: "ledgerExpectedQuantity", direction: "asc" },
          { orderBy: "quantityVariance", direction: "asc" },
        ],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(sorted.data.map((row) => row.id)).toEqual([service.id]);
      const physical = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic physical item", price: 70 }),
        ctx.actor,
      );
      const mixed = await productList(
        ctx.db,
        { ids: [service.id, physical.id] },
        [{ orderBy: "price", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(mixed.data.map((row) => row.id)).toEqual([
        service.id,
        physical.id,
      ]);
      expect(
        mixed.data.find((row) => row.id === physical.id)?.pricing.cost?.amount,
      ).toBe(70);
      const quality = (
        await loadDataQualities(ctx.db, "product", [service.entityId])
      ).get(service.entityId)!;
      expect(quality.gaps.map((gap) => gap.check)).not.toContain(
        "product_external_id",
      );
      expect(quality.gaps.map((gap) => gap.check)).not.toContain(
        "product_orphaned",
      );
      const charges = await productPricingSummary(ctx.db, service.id);
      expect(charges).toContainEqual({
        kind: "stats",
        figures: [
          { label: "Charges", value: 2, format: "count" },
          { label: "Credits", value: 1, format: "count" },
          { label: "Average charge", value: 65, format: "money" },
          { label: "Total spent", value: 120, format: "money" },
        ],
      });
      expect(JSON.stringify(charges)).toContain("Latest dated charge");
      expect(JSON.stringify(charges)).toContain("$90.00");
      expect(
        JSON.stringify(await productStockSummary(ctx.db, service.id)),
      ).toContain("Stock is not applicable");
      const originals = await getDb(ctx.db)
        .select({ cost: expense.cost, quantity: expense.productQuantity })
        .from(expense)
        .where(eq(expense.productId, service.entityId));
      expect(originals).toHaveLength(3);
      expect(originals).toContainEqual({ cost: 90, quantity: 30 });
    },
  );

  it("excludes planned/deleted charges and keeps unknown evidence explicit beyond the history page", async () => {
    const service = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic subscription history",
        categoryId: taxonomyShortcode("software"),
      }),
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: service.id,
        date: "2026-01-01",
        cost: 25,
        productQuantity: 1,
      }),
    );
    // Newer credits push the latest bill out of the bounded history page.
    for (let i = 0; i < 13; i++)
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          productId: service.id,
          date: "2026-02-01",
          cost: -1,
          productQuantity: -1,
        }),
      );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: service.id,
        date: null,
        cost: null,
        productQuantity: null,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: service.id,
        date: "2026-03-01",
        cost: 500,
        future: true,
        productQuantity: null,
      }),
    );
    const removed = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: service.id,
        date: "2026-04-01",
        cost: 700,
      }),
    );
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, removed.entityId));
    const report = await productPricingSummary(ctx.db, service.id);
    const figures = report.flatMap((block) =>
      block.kind === "stats" ? block.figures : [],
    );
    expect(figures).toEqual([
      { label: "Charges", value: 1, format: "count" },
      { label: "Credits", value: 13, format: "count" },
      { label: "Average charge", value: 25, format: "money" },
      { label: "Total spent", value: 12, format: "money" },
    ]);
    expect(JSON.stringify(report)).toContain("$25.00");
    expect(JSON.stringify(report)).toContain(
      "1 unpriced Expenses; 1 without dates",
    );
    expect(JSON.stringify(report)).not.toContain("$500.00");
    expect(JSON.stringify(report)).not.toContain("$700.00");
  });

  it("does not infer service stock or ownership from retained inventory and renewal quantities", async () => {
    const service = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic retained subscription",
        categoryId: taxonomyShortcode("software"),
      }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic retained shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: service.entityId,
        locationId: shelf.entityId,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: service.id,
        cost: 20,
        date: "2026-01-01",
        productQuantity: 1,
      }),
    );
    const picker = (
      await loadProductPickerQuantities(ctx.db, [service.entityId])
    ).get(service.entityId)!;
    expect(picker.onHand).toEqual({ state: "none" });
    const summary = (
      await loadProductQuantitySummaries(ctx.db, [service.entityId])
    ).get(service.entityId)!;
    expect(summary.onHandUnits).toBeNull();
    expect(summary.quantityVariance).toBeNull();
    const timeline = (
      await loadProductOwnershipTimelines(getDb(ctx.db), [service.entityId])
    ).get(service.entityId)!;
    expect(timeline).toEqual({
      acquiredAt: null,
      intervals: [],
      confidenceLostAt: null,
    });
    const kit = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic hardware and subscription kit" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: service.entityId, quantity: 1 }],
      ctx.actor,
    );
    const components = await listProductComponents(ctx.db, kit.entityId);
    expect(components[0]?.onHandUnits).toBeNull();
  });
});
