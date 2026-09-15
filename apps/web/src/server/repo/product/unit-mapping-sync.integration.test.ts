import type { ProductId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, asc, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productUnitMappings } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createProduct, updateProduct } from "~/server/repo/product";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/**
 * `syncProductUnitMappings` (update-helpers.ts) reconciles by row `id`: a
 * mapping resent WITH its id updates in place, one resent withOUT an id (or
 * simply absent from the payload) is hard-deleted and any id-less mapping is
 * inserted fresh. An MCP caller that only ever sees id-less rows (the old
 * `entity get/list product` projection) can never resend the id, so every
 * update looked like "delete everything, recreate everything" even when the
 * caller only meant to append one row — losing `createdAt`/`updatedAt` and the
 * audit trail on every untouched mapping. This pins the fix: resending an
 * existing mapping with its `id` must update that exact row, not replace it.
 */
describe("syncProductUnitMappings row identity", () => {
  const ctx = withTestDb();

  const liveMappingRows = (productId: ProductId) =>
    getDb(ctx.db)
      .query.productUnitMappings.findMany({
        where: and(
          eq(productUnitMappings.productId, productId),
          notDeleted(productUnitMappings),
        ),
        orderBy: [asc(productUnitMappings.createdAt)],
      })
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          a: row.a,
          b: row.b,
          source: row.source,
          createdAt: row.createdAt,
        })),
      );

  it("updates a resent mapping in place instead of delete+recreate", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Sync Probe",
        unitMappings: [
          {
            a: { value: 1, unit: "cup" },
            b: { value: 120, unit: "g" },
            source: null,
          },
          {
            a: { value: 8, unit: "oz" },
            b: { value: 10, unit: "dollar" },
            source: "manual",
          },
        ],
      }),
      TEST_ACTOR,
    );
    const uuid = await resolveLiveShortcode(ctx.db, created.id, "product");
    if (!uuid) throw new Error("Failed to resolve created product");
    const productId = parseEntityId("product", uuid);

    const before = await liveMappingRows(productId);
    expect(before).toHaveLength(2);
    const [cupToGram, ozToDollar] = before;

    // Resend both existing rows BY ID — one changed, one untouched — plus one
    // brand-new id-less mapping, the shape a `get` -> edit -> `update` MCP
    // round trip produces.
    const { product } = await updateProduct(
      ctx.db,
      productId,
      {
        unitMappings: [
          {
            id: cupToGram!.id,
            a: { value: 1, unit: "cup" },
            // Only this one row actually changes.
            b: { value: 125, unit: "g" },
            source: null,
          },
          {
            id: ozToDollar!.id,
            a: { value: 8, unit: "oz" },
            b: { value: 10, unit: "dollar" },
            source: "manual",
          },
          {
            a: { value: 1, unit: "lb" },
            b: { value: 16, unit: "oz" },
            source: "manual",
          },
        ],
      },
      TEST_ACTOR,
    );
    expect(product.id).toBe(created.id);

    const after = await liveMappingRows(productId);
    expect(after).toHaveLength(3);

    const afterCupToGram = after.find((row) => row.id === cupToGram!.id);
    const afterOzToDollar = after.find((row) => row.id === ozToDollar!.id);
    const afterNew = after.find(
      (row) => row.id !== cupToGram!.id && row.id !== ozToDollar!.id,
    );

    // Row identity survived the round trip — the whole point of resending ids.
    expect(afterCupToGram).toBeDefined();
    expect(afterOzToDollar).toBeDefined();
    expect(afterNew).toBeDefined();

    // createdAt is only preserved by an UPDATE; a delete+recreate would stamp
    // a fresh one, silently destroying the audit trail this test guards.
    expect(afterCupToGram!.createdAt).toEqual(cupToGram!.createdAt);
    expect(afterOzToDollar!.createdAt).toEqual(ozToDollar!.createdAt);

    // The one row that actually changed reflects its new value...
    expect(afterCupToGram!.b).toEqual({ value: 125, unit: "g" });
    // ...while the untouched row is byte-for-byte the same.
    expect(afterOzToDollar!.a).toEqual(ozToDollar!.a);
    expect(afterOzToDollar!.b).toEqual(ozToDollar!.b);
  });
});
