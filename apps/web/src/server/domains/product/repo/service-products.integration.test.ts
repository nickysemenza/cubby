import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { expense, product } from "~/server/db/schema";
import { updateProductCategory } from "~/server/domains/product-category/repo/product-category";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  productPricingSummary,
  productStockSummary,
} from "~/server/generic/entity-report/repo/summary";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  createInventoryFixture,
  createLocationFixture,
  makeLocationInput,
  makeExpenseInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { listProductsRead, productList, updateProduct } from "./crud";
import { loadProductOwnershipTimelines } from "./ownership";
import {
  loadExactEffectivePrices,
  loadProductPriceSum,
  storedEffectivePrice,
} from "./pricing";
import {
  attachProductComponents,
  listProductComponents,
} from "./product-components";
import {
  loadProductQuantityLedgers,
  loadProductDetailQuantityLedgers,
  loadProductPickerQuantities,
  loadProductQuantitySummaries,
} from "./quantity-ledger";
import { serviceProductIdSql } from "./service-category";
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
      const read = await executeEntity(
        entityKernelContextSchema.parse(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
        { action: "get", entity: "product", id: service.id, missing: "error" },
      );
      const canonical = entityFieldEnvelopeSchemas.product.detail.parse(
        read.item,
      );
      expect(canonical.fields.price).toMatchObject({
        current: {
          assignment: { kind: "value", value: 123 },
          controls: { kind: "readonly", reason: "not_allowed" },
        },
        result: {
          kind: "live",
          decision: { outcome: { kind: "empty", reason: "not_applicable" } },
        },
      });
      expect(canonical.pricing).not.toHaveProperty("cost");
      expect(canonical.pricing).not.toHaveProperty("effectivePrice");
      expect(canonical.pricing).not.toHaveProperty("derivedPrice");
      expect(canonical.pricing).not.toHaveProperty("source");
      expect(canonical.fields.cost.result).toEqual({ kind: "missing" });
      expect(
        storedEffectivePrice(new Map(), {
          id: service.entityId,
          price: 123,
          category: detail.category,
        }),
      ).toBeNull();
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
      // Sort compares published charges with the immediately available own item price.
      await drainStoredDerived(ctx.db);
      const published = entityFieldEnvelopeSchemas.product.detail.parse(
        (
          await executeEntity(
            entityKernelContextSchema.parse(
              createTestRequestContext(ctx.db, {
                auth: { userId: ctx.actor.userId },
              }),
            ),
            {
              action: "get",
              entity: "product",
              id: service.id,
              missing: "error",
            },
          )
        ).item,
      );
      expect(published.fields.cost).toMatchObject({
        current: {
          assignment: null,
          controls: { kind: "readonly", reason: "computed" },
        },
        result: {
          kind: "cached",
          freshness: "fresh",
          decision: {
            outcome: {
              kind: "value",
              value: {
                kind: "service_charge",
                amount: 65,
                chargeCount: 2,
                latestCharge: 90,
              },
            },
            provenance: { kind: "computed" },
          },
        },
      });
      expect(published.fields.price.result).toMatchObject({
        kind: "live",
        decision: { outcome: { kind: "empty", reason: "not_applicable" } },
      });
      const mixed = await productList(
        ctx.db,
        { ids: [service.id, physical.id] },
        [{ orderBy: "cost", direction: "asc" }],
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

      // An unsuccessful refresh retains one complete published tuple for display and sorting.
      await getDb(ctx.db).execute(sql`UPDATE "Expense" SET cost = 190
        WHERE "productId" = ${service.entityId} AND cost = 90`);
      await getDb(ctx.db).execute(sql`UPDATE "DerivedDirty"
        SET "lastError" = 'Synthetic Cost refresh failure', "readyAt" = now() + interval '1 hour'
        WHERE target = 'product.cost' AND ref = ${service.entityId}`);
      const readCanonical = async () =>
        entityFieldEnvelopeSchemas.product.detail.parse(
          (
            await executeEntity(
              entityKernelContextSchema.parse(
                createTestRequestContext(ctx.db, {
                  auth: { userId: ctx.actor.userId },
                }),
              ),
              {
                action: "get",
                entity: "product",
                id: service.id,
                missing: "error",
              },
            )
          ).item,
        );
      const failed = await readCanonical();
      expect(failed.fields.cost.result).toMatchObject({
        kind: "cached",
        freshness: "stale",
        computedAt:
          published.fields.cost.result.kind === "cached"
            ? published.fields.cost.result.computedAt
            : null,
        decision: {
          outcome: {
            kind: "value",
            value: { amount: 65, chargeCount: 2, latestCharge: 90 },
          },
        },
      });
      expect(failed.fields.cost.work).toMatchObject({
        kind: "failed",
        error: "Synthetic Cost refresh failure",
      });
      const staleSort = await productList(
        ctx.db,
        { ids: [service.id, physical.id] },
        [{ orderBy: "cost", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(staleSort.data.map((row) => row.id)).toEqual([
        service.id,
        physical.id,
      ]);
      await getDb(ctx.db)
        .execute(sql`UPDATE "DerivedDirty" SET "readyAt" = now()
        WHERE target = 'product.cost' AND ref = ${service.entityId}`);
      await drainStoredDerived(ctx.db);
      const refreshed = await readCanonical();
      expect(refreshed.fields.cost.result).toMatchObject({
        kind: "cached",
        freshness: "fresh",
        decision: {
          outcome: {
            kind: "value",
            value: { amount: 115, chargeCount: 2, latestCharge: 190 },
          },
        },
      });
      const refreshedSort = await productList(
        ctx.db,
        { ids: [service.id, physical.id] },
        [{ orderBy: "cost", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(refreshedSort.data.map((row) => row.id)).toEqual([
        physical.id,
        service.id,
      ]);

      // A date edit changes latest-charge evidence even when the average is unchanged.
      await getDb(ctx.db).execute(sql`UPDATE "Expense" SET date = '2026-04-01'
        WHERE "productId" = ${service.entityId} AND cost = 40`);
      expect((await readCanonical()).fields.cost.result).toMatchObject({
        kind: "cached",
        freshness: "stale",
      });
      await drainStoredDerived(ctx.db);
      expect((await readCanonical()).fields.cost.result).toMatchObject({
        kind: "cached",
        freshness: "fresh",
        decision: {
          outcome: {
            kind: "value",
            value: { amount: 115, chargeCount: 2, latestCharge: 40 },
          },
        },
      });
    },
  );

  it("distinguishes empty service Cost from missing work through category changes", async () => {
    const service = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic changing Cost applicability",
        categoryId: taxonomyShortcode("services"),
        price: 123,
      }),
      ctx.actor,
    );
    const read = async () =>
      entityFieldEnvelopeSchemas.product.detail.parse(
        (
          await executeEntity(
            entityKernelContextSchema.parse(
              createTestRequestContext(ctx.db, {
                auth: { userId: ctx.actor.userId },
              }),
            ),
            {
              action: "get",
              entity: "product",
              id: service.id,
              missing: "error",
            },
          )
        ).item,
      );
    expect((await read()).fields.cost.result).toEqual({ kind: "missing" });
    await drainStoredDerived(ctx.db);
    expect((await read()).fields.cost.result).toMatchObject({
      kind: "cached",
      freshness: "fresh",
      decision: {
        outcome: { kind: "empty", reason: "unset" },
        provenance: { kind: "computed" },
      },
    });
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({ productId: service.id, cost: 40, date: "2026-01-01" }),
    );
    await drainStoredDerived(ctx.db);
    expect((await read()).fields.cost.result).toMatchObject({
      kind: "cached",
      decision: {
        outcome: {
          kind: "value",
          value: {
            kind: "service_charge",
            amount: 40,
            chargeCount: 1,
            latestCharge: 40,
          },
        },
      },
    });

    await updateProduct(
      ctx.db,
      service.entityId,
      { categoryId: taxonomyId("tools") },
      ctx.actor,
    );
    const physical = await read();
    expect(physical.fields.price.current.assignment).toMatchObject({
      kind: "value",
      value: 123,
    });
    expect(physical.fields.cost.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: { kind: "item", amount: 123 } },
        provenance: { kind: "own" },
      },
    });
    await drainStoredDerived(ctx.db);
    const physicalCost = await getDb(ctx.db).execute(
      sql`SELECT value FROM "DerivedValue" WHERE "entityId" = ${service.entityId} AND key = 'cost'`,
    );
    expect(physicalCost.rows).toEqual([]);

    await updateProduct(
      ctx.db,
      service.entityId,
      { categoryId: taxonomyId("services") },
      ctx.actor,
    );
    const restored = await read();
    expect(restored.fields.price.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "not_applicable" } },
    });
    expect(restored.fields.cost.result).toEqual({ kind: "missing" });
    expect(restored.fields.cost.work).toEqual({ kind: "pending" });
    const valued = await productList(
      ctx.db,
      { ids: [service.id], pricePresenceFilter: "has" },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(valued.data).toEqual([]);
    await drainStoredDerived(ctx.db);
    expect((await read()).fields.cost.result).toMatchObject({
      kind: "cached",
      freshness: "fresh",
      decision: {
        outcome: {
          kind: "value",
          value: {
            kind: "service_charge",
            amount: 40,
            chargeCount: 1,
            latestCharge: 40,
          },
        },
      },
    });
  });

  it("keeps direct service kit charges out of physical quantities and prices while honoring an explicit override", async () => {
    await updateProductCategory(
      ctx.db,
      taxonomyShortcode("tools"),
      {
        parentId: taxonomyShortcode("services"),
      },
      ctx.actor,
    );
    const service = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic service kit",
        categoryId: taxonomyShortcode("services"),
        price: 123,
      }),
      ctx.actor,
    );
    const physical = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic override kit",
        categoryId: taxonomyShortcode("tools"),
        price: null,
      }),
      ctx.actor,
    );
    const part = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic kit component",
        price: null,
      }),
      ctx.actor,
    );
    for (const kit of [service, physical]) {
      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: part.entityId, quantity: 4 }],
        ctx.actor,
      );
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          name: "Synthetic kit acquisition",
          productId: kit.id,
          cost: kit === service ? 200 : 24,
          productQuantity: 2,
        }),
      );
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          name: "Synthetic kit exit",
          productId: kit.id,
          cost: kit === service ? -100 : -12,
          productQuantity: -1,
        }),
      );
    }
    const ids = [service.entityId, physical.entityId, part.entityId];
    const batch = await loadProductQuantityLedgers(ctx.db, ids);
    const detail = await loadProductDetailQuantityLedgers(ctx.db, ids);
    for (const id of ids) expect(detail.get(id)).toEqual(batch.get(id));
    expect(batch.has(service.entityId)).toBe(false);
    const serviceDetail = await getProductWithFood(
      ctx.db,
      { findFood: async () => null },
      service.entityId,
    );
    expect(serviceDetail.quantityLedger).toMatchObject({
      acquiredUnits: 0,
      exitedUnits: 0,
      expectedQuantity: 0,
    });
    expect(serviceDetail.pricing.effectivePrice).toBeNull();
    expect(batch.get(physical.entityId)).toMatchObject({
      acquiredUnits: 2,
      exitedUnits: 1,
      expectedQuantity: 1,
    });
    expect(batch.get(part.entityId)).toMatchObject({
      acquiredUnits: 8,
      exitedUnits: 4,
      expectedQuantity: 4,
    });
    const prices = await loadExactEffectivePrices(ctx.db, [
      { id: service.entityId, price: 123 },
      { id: physical.entityId, price: null },
      { id: part.entityId, price: null },
    ]);
    expect(prices.get(service.entityId)).toBeNull();
    expect(prices.get(physical.entityId)).toBe(12);
    expect(prices.get(part.entityId)).toBe(3);
    // Native payload liveness remains required even when its category matches.
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, service.entityId));
    const deleted = await getDb(ctx.db).execute(
      sql`SELECT ${serviceProductIdSql(sql`${service.entityId}::uuid`)} AS service`,
    );
    expect(deleted.rows[0]?.service).toBe(false);
  });

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
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
