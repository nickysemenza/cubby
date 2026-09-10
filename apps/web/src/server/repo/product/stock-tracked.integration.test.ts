import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  inventoryEntry,
  product as productTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { setProductsStockTracked } from "~/server/repo/product";

import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "../repo.fixtures";

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
          eq(auditLog.entityType, "product"),
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
