import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { seedBaseWorld } from "../factories/base-world";
import { taxonomyShortcode } from "../product-category-fixtures";
import { createEntity } from "../factories/create";
import { buildKernelContext, buildScenarioDatabase } from "./context";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

export const SIM_PRODUCT_NAME = "Synthetic Atlas Lantern";
export const SIM_PRODUCT_UPDATED_NAME = "Synthetic Atlas Lantern Updated";

export async function seedSimulatorPhotoActor(pool: Pool, userId: string) {
  const existing = await pool.query(
    'SELECT 1 FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL LIMIT 1',
    [userId, "member"],
  );
  if (existing.rowCount) return;
  await insertWithShortcode(buildScenarioDatabase(pool), "ledgerParty", {
    name: "Synthetic Simulator Member",
    kind: "member",
    userId: testUserId(userId),
  });
}

/** A synthetic run for native navigation and review presentation checks. */
export async function seedSimulatorLayoutRun(
  pool: Pool,
  userId: string,
): Promise<string> {
  await seedSimulatorPhotoActor(pool, userId);
  const run = await startPhotoInventoryRun(buildScenarioDatabase(pool), {
    actorUserId: testUserId(userId),
  });
  return run.publicId;
}

/** One named product makes the native read/write contract unambiguous. */
export async function seedSimulatorScenario(
  pool: Pool,
  userId: string,
  name = SIM_PRODUCT_NAME,
  price: number | null = null,
): Promise<string> {
  const db = buildScenarioDatabase(pool);
  await seedBaseWorld(db.clientForRepository());
  const context = buildKernelContext(db, testUserId(userId));
  const product = await createEntity(context, "product", {
    name,
    price,
    manufacturer: "Synthetic Works",
    model: null,
    categoryId: taxonomyShortcode("household"),
  });
  return product.id;
}

/** Mixed evidence exercises both inverse relation presentations without client classification. */
export async function seedSimulatorProductClarity(
  pool: Pool,
  userId: string,
): Promise<{ productId: string; purchaseId: string }> {
  const productId = await seedSimulatorScenario(
    pool,
    userId,
    SIM_PRODUCT_NAME,
    40,
  );
  const db = buildScenarioDatabase(pool);
  const context = buildKernelContext(db, testUserId(userId));
  const vendor = await createEntity(context, "vendor", {
    name: "Synthetic Evidence Vendor",
  });
  const purchase = await createEntity(context, "purchase", {
    vendorId: vendor.id,
    orderId: "Synthetic Evidence Order",
    date: "2026-01-05",
  });
  for (const line of [
    { name: "Synthetic acquisition", cost: 25, productQuantity: 1 },
    { name: "Synthetic price adjustment", cost: -5, productQuantity: 0 },
    {
      name: "Synthetic planned acquisition",
      cost: 30,
      productQuantity: 1,
      future: true,
    },
  ]) {
    await createEntity(context, "expense", {
      date: "2026-01-05",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      productId,
      purchaseId: purchase.id,
      ...line,
    });
  }
  const internalPurchase = await resolveLiveShortcode(
    db,
    purchase.id,
    "purchase",
  );
  const internalProduct = await resolveLiveShortcode(db, productId, "product");
  if (internalPurchase === null || internalProduct === null)
    throw new Error("Synthetic product evidence fixture is missing");
  await attachPurchaseProducts(
    db,
    internalPurchase,
    [internalProduct],
    context.actorContext,
  );
  return { productId, purchaseId: purchase.id };
}
