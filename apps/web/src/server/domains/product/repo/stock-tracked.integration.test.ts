import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import type { ProductCategoryShortcode } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  auditLog,
  inventoryEntry,
  product as productTable,
} from "~/server/db/schema";
import {
  createProductCategory,
  updateProductCategory,
} from "~/server/domains/product-category/repo/product-category";
import {
  getProductByShortcode,
  listProductsRead,
  productList,
  setProductsStockTracked,
} from "~/server/domains/product/repo/crud";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

describe("setProductsStockTracked", () => {
  const ctx = withTestDb();

  it("returns mixed selections, audits only changes, and leaves inventory untouched", async () => {
    const changed = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Bulk stock decision pending",
        stockTracked: false,
      }),
      ctx.actor,
    );
    const unchanged = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Bulk stock decision already set",
        stockTracked: true,
      }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Bulk stock decision shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryFixture(
      ctx.db,
      {
        productId: changed.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const inventoryBefore = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, entry.entityId),
    });
    if (!inventoryBefore) throw new Error("inventory fixture missing");

    const ids = [changed.id, unchanged.id];
    const result = await setProductsStockTracked(
      ctx.db,
      { ids, stockTracked: true },
      ctx.actor,
    );
    expect(new Set(result.map((product) => product.id))).toEqual(new Set(ids));
    expect(
      (
        await setProductsStockTracked(
          ctx.db,
          { ids, stockTracked: true },
          ctx.actor,
        )
      ).map((product) => product.id),
    ).toHaveLength(2);

    const audits = await getDb(ctx.db)
      .select({ entityId: auditLog.entityId, action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "product"),
          inArray(auditLog.entityId, [changed.entityId, unchanged.entityId]),
          eq(auditLog.action, "update"),
        ),
      );
    expect(
      audits.filter((audit) => audit.entityId === changed.entityId),
    ).toHaveLength(1);
    expect(
      audits.filter((audit) => audit.entityId === unchanged.entityId),
    ).toHaveLength(0);

    const inventoryAfter = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, entry.entityId),
    });
    expect(inventoryAfter?.updatedAt).toEqual(inventoryBefore.updatedAt);
  });

  it("clears a nullable stock-tracking decision", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Bulk stock decision clear",
        stockTracked: true,
      }),
      ctx.actor,
    );

    await setProductsStockTracked(
      ctx.db,
      { ids: [product.id], stockTracked: null },
      ctx.actor,
    );

    const refreshed = await getDb(ctx.db).query.product.findFirst({
      where: eq(productTable.id, product.entityId),
    });
    expect(refreshed?.stockTracked).toBeNull();
  });
});

const stockTrackingRead = z.object({
  stockTracked: z.boolean().nullable(),
  fieldResolutions: z.object({ stockTracked: fieldResolutionSchema }),
});

// Failure modes: a category default overrides the Product's own decision; an
// undecided Product ignores its category; detail, list and deferred reads
// disagree; the undecided worklist filters the stored column instead of the
// effective value, so a Product decided by its category never leaves it.
describe("effective Product stock tracking", () => {
  const ctx = withTestDb();

  const category = (
    name: string,
    stockTracked: boolean | null,
    parentId: ProductCategoryShortcode | null = null,
  ) =>
    createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name,
        aliases: [],
        description: null,
        parentId,
        sortOrder: 0,
        feature: null,
        stockTracked,
      },
      ctx.actor,
    );

  it("lets a Product decision win, inherits the category's otherwise, and filters undecided on the effective value", async () => {
    const untracked = await category("Synthetic pantry staples", false);
    const nested = await category(
      "Synthetic dry goods",
      null,
      untracked.output.id,
    );
    const undecidedCategory = await category("Synthetic odds and ends", null);
    const make =
      (name: string, categoryId: ProductCategoryShortcode | null) =>
      (stockTracked: boolean | null) =>
        createProduct(
          ctx.db,
          makeProductInput({ name, categoryId, stockTracked }),
          ctx.actor,
        );
    const inherited = await make("Synthetic rice", nested.output.id)(null);
    const overridden = await make(
      "Synthetic grain mill",
      nested.output.id,
    )(true);
    const undecided = await make(
      "Synthetic spare part",
      undecidedCategory.output.id,
    )(null);
    const uncategorized = await make("Synthetic loose item", null)(null);
    const ids = [inherited.id, overridden.id, undecided.id, uncategorized.id];

    const read = async (id: (typeof ids)[number]) => {
      const detail = stockTrackingRead.parse(
        await getProductByShortcode(ctx.db, id),
      );
      const list = await productList(ctx.db, { ids: [id] }, [], {
        pageIndex: 0,
        pageSize: 10,
      });
      expect(stockTrackingRead.parse(list.data[0])).toEqual(detail);
      const deferred = await listProductsRead(
        ctx.db,
        { ids: [id] },
        [],
        { pageIndex: 0, pageSize: 10 },
        undefined,
        "page",
        undefined,
        { kind: "enrichment", groups: ["derived"] },
      );
      expect(
        stockTrackingRead
          .pick({ fieldResolutions: true })
          .parse(deferred.data[0]),
      ).toEqual({ fieldResolutions: detail.fieldResolutions });
      return detail;
    };

    expect(await read(inherited.id)).toMatchObject({
      stockTracked: null,
      fieldResolutions: {
        stockTracked: {
          mode: "inherit",
          storedValue: null,
          value: false,
          fallbackValue: false,
          sourceEntity: {
            entityKind: "productCategory",
            entityId: untracked.output.id,
          },
          canReset: false,
        },
      },
    });
    expect(await read(overridden.id)).toMatchObject({
      stockTracked: true,
      fieldResolutions: {
        stockTracked: {
          mode: "explicit",
          storedValue: true,
          value: true,
          fallbackValue: false,
          fallbackSource: {
            entityKind: "productCategory",
            entityId: untracked.output.id,
          },
          evaluation: [
            expect.objectContaining({
              entityId: nested.output.id,
              value: null,
              assigned: false,
            }),
            expect.objectContaining({
              entityId: untracked.output.id,
              value: false,
              assigned: true,
            }),
          ],
          matchesFallback: false,
          canReset: true,
        },
      },
    });
    for (const id of [undecided.id, uncategorized.id])
      expect((await read(id)).fieldResolutions.stockTracked).toMatchObject({
        mode: "inherit",
        value: null,
        fallbackValue: null,
        sourceEntity: null,
      });

    const filtered = async (stockTrackedPresenceFilter: "has" | "none") =>
      new Set(
        (
          await productList(ctx.db, { ids, stockTrackedPresenceFilter }, [], {
            pageIndex: 0,
            pageSize: 10,
          })
        ).data.map((row) => row.id),
      );
    expect(await filtered("none")).toEqual(
      new Set([undecided.id, uncategorized.id]),
    );
    expect(await filtered("has")).toEqual(
      new Set([inherited.id, overridden.id]),
    );

    // Deciding the category moves its undecided members out of the worklist.
    await updateProductCategory(
      ctx.db,
      undecidedCategory.output.id,
      { stockTracked: true },
      ctx.actor,
    );
    expect(await filtered("none")).toEqual(new Set([uncategorized.id]));
  });
});
