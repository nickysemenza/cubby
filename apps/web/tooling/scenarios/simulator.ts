import { productCreateInput } from "@cubby/schemas/product";
import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import * as schema from "~/server/db/schema";

import {
  taxonomyRootFixtures,
  taxonomyShortcode,
} from "../product-category-fixtures";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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

/** One named product makes the native read/write contract unambiguous. */
export async function seedSimulatorScenario(
  pool: Pool,
  userId: string,
  name = SIM_PRODUCT_NAME,
): Promise<string> {
  await pool.query(
    `INSERT INTO "Location" (shortcode, name, aliases, tags, type, "parentId")
     VALUES ('LOC-HM3E', 'Home', ARRAY[]::text[], ARRAY[]::text[], 'house', NULL)
     ON CONFLICT (shortcode) DO NOTHING`,
  );
  const db = buildScenarioDatabase(pool);
  await db
    .clientForRepository()
    .insert(schema.productCategory)
    .values(taxonomyRootFixtures)
    .onConflictDoNothing();
  const context = buildKernelContext(db, testUserId(userId));
  const product = await createFixtureWithContext(
    context,
    "product",
    productCreateInput.parse({
      name,
      aliases: [],
      tags: [],
      upc: null,
      manufacturer: "Synthetic Works",
      model: null,
      notes: null,
      expectedQuantity: null,
      ingredientId: null,
      categoryId: taxonomyShortcode("household"),
    }),
  );
  return product.id;
}
