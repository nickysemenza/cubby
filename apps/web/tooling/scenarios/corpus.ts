import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import { taskCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { faker } from "@faker-js/faker";
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

/**
 * A deterministic (faker.seed(1) — the caller seeds it once, before calling
 * this) synthetic household corpus for local `dev:local` iteration: a
 * location tree, a product taxonomy, products, inventory, a financial
 * account, and a few tasks — everything a fixture-backed preview route or a
 * developer poking at the UI needs to see non-empty screens.
 *
 * Deliberately narrower than the full E2E fixture set in
 * tests/e2e/e2e-fixtures.ts: it skips recipes/cookbooks (need the
 * `@cubby/recipebridge` WASM build) and the more elaborate multi-step
 * Playwright-only scenarios (relationship review, wardrobe, inheritance,
 * etc.) rather than reimplementing their Page-driven flows headlessly.
 */
export async function seedCorpus(pool: Pool, userId: string): Promise<void> {
  const db = buildScenarioDatabase(pool);
  // testUserId() only brands the string (see @cubby/schemas/test-support) — it
  // is the real, database-backed dev user's id from better-auth sign-up, not
  // a fabricated one.
  const context = buildKernelContext(db, testUserId(userId));

  console.log("[dev-db] Seeding household root and taxonomy...");
  await pool.query(
    `INSERT INTO "Location" (shortcode, name, aliases, tags, type, "parentId")
     VALUES ('LOC-HM3E', 'Home', ARRAY[]::text[], ARRAY[]::text[], 'house', NULL)
     ON CONFLICT (shortcode) DO NOTHING`,
  );
  const client = db.clientForRepository();
  await client
    .insert(schema.productCategory)
    .values(taxonomyRootFixtures)
    .onConflictDoNothing();

  console.log("[dev-db] Seeding locations...");
  const roomNames = ["Kitchen", "Pantry", "Garage"];
  const locations = [];
  for (const name of roomNames) {
    locations.push(
      await createFixtureWithContext(
        context,
        "location",
        locationCreateInput.parse({
          name,
          aliases: [],
          tags: [],
          type: "room",
          parentId: null,
        }),
      ),
    );
  }

  console.log("[dev-db] Seeding products and inventory...");
  const productCount = 8;
  for (let index = 0; index < productCount; index += 1) {
    const product = await createFixtureWithContext(
      context,
      "product",
      productCreateInput.parse({
        name: faker.commerce.productName(),
        aliases: [],
        tags: [],
        upc: null,
        manufacturer: faker.company.name(),
        model: null,
        notes: null,
        expectedQuantity: null,
        ingredientId: null,
        categoryId: taxonomyShortcode("food"),
      }),
    );
    const location = locations[index % locations.length];
    if (!location) continue;
    await createFixtureWithContext(
      context,
      "inventory",
      inventoryCreatePayloadData.parse({
        productId: product.id,
        locationId: location.id,
        amount: {
          value: faker.number.int({ min: 1, max: 12 }),
          unit: "each",
        },
      }),
    );
  }

  console.log("[dev-db] Seeding a financial account and ledger party...");
  await createFixtureWithContext(
    context,
    "financialAccount",
    financialAccountCreateInput.parse({
      name: "Household Checking",
      identity: { kind: "cash" },
      provisional: false,
      sourceAliases: [],
      ledgerPartyId: null,
      notes: null,
    }),
  );
  await createFixtureWithContext(
    context,
    "ledgerParty",
    ledgerPartyCreateInput.parse({
      name: faker.company.name(),
      kind: "guest",
      aliases: [],
      tags: [],
      notes: null,
    }),
  );

  console.log("[dev-db] Seeding tasks...");
  const taskNames = [
    "Replace pantry shelf liner",
    "Service the garage door opener",
    "Restock cleaning supplies",
  ];
  for (const name of taskNames) {
    await createFixtureWithContext(
      context,
      "task",
      taskCreateInput.parse({ name, trade: "other" }),
    );
  }
}
