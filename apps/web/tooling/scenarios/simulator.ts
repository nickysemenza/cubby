import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { seedBaseWorld } from "../factories/base-world";
import { taxonomyShortcode } from "../product-category-fixtures";
import { createEntity } from "../factories/build";
import { buildKernelContext, buildScenarioDatabase } from "./context";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";

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
): Promise<string> {
  const db = buildScenarioDatabase(pool);
  await seedBaseWorld(db.clientForRepository());
  const context = buildKernelContext(db, testUserId(userId));
  const product = await createEntity(context, "product", {
    name,
    manufacturer: "Synthetic Works",
    model: null,
    categoryId: taxonomyShortcode("household"),
  });
  return product.id;
}
