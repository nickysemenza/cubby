import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productExternalId } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";

describe("purchase import learned product identifiers", () => {
  const ctx = withTestDb();

  it("keeps one primary and learns later retailer identifiers as secondaries", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example imported product" }),
      ctx.actor,
    );

    await withTransaction(ctx.db, async (tx) => {
      await learnPurchaseProductExternalId(tx, {
        productId: product.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SKU-ONE",
      });
      await learnPurchaseProductExternalId(tx, {
        productId: product.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SKU-TWO",
      });
    });

    const rows = await getDb(ctx.db)
      .select({
        externalId: productExternalId.externalId,
        isPrimary: productExternalId.isPrimary,
      })
      .from(productExternalId)
      .where(
        and(
          eq(productExternalId.productId, product.entityId),
          eq(productExternalId.source, "example-vendor"),
          eq(productExternalId.kind, "retailer_sku"),
          notDeleted(productExternalId),
        ),
      )
      .orderBy(productExternalId.externalId);

    expect(rows).toEqual([
      { externalId: "SKU-ONE", isPrimary: true },
      { externalId: "SKU-TWO", isPrimary: false },
    ]);
  });

  it("replays an exact identifier and refuses a different product owner", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "First product" }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Second product" }),
      ctx.actor,
    );

    await withTransaction(ctx.db, (tx) =>
      learnPurchaseProductExternalId(tx, {
        productId: first.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SHARED-SKU",
      }),
    );

    await expect(
      withTransaction(ctx.db, (tx) =>
        learnPurchaseProductExternalId(tx, {
          productId: first.entityId,
          source: "example-vendor",
          kind: "retailer_sku",
          externalId: "SHARED-SKU",
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      withTransaction(ctx.db, (tx) =>
        learnPurchaseProductExternalId(tx, {
          productId: second.entityId,
          source: "example-vendor",
          kind: "retailer_sku",
          externalId: "SHARED-SKU",
        }),
      ),
    ).rejects.toBeInstanceOf(PurchaseProductExternalIdCollisionError);
  });
});
