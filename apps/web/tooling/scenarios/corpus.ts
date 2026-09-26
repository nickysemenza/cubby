import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { faker } from "@faker-js/faker";
import type { Pool } from "pg";

import * as schema from "~/server/db/schema";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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
  const products = [];
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
    products.push(product);
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

  console.log("[dev-db] Seeding projects...");
  const projectNames = ["Kitchen refresh", "Garage organization"];
  for (const name of projectNames) {
    await createFixtureWithContext(
      context,
      "project",
      projectCreateInput.parse({
        name,
        aliases: [],
        tags: [],
        notes: null,
        startDate: "2026-05-01",
        endDate: "2026-05-31",
      }),
    );
  }

  console.log("[dev-db] Seeding a vendor with purchases and expenses...");
  const vendor = await createFixtureWithContext(
    context,
    "vendor",
    vendorCreateInput.parse({
      name: "Synthetic Supply Co",
      aliases: [],
      tags: [],
      website: "https://example.com",
      orderUrlTemplate: null,
      notes: null,
    }),
  );
  for (const [index, name] of [
    "Kitchen restock",
    "Garage supplies",
  ].entries()) {
    const purchase = await createFixtureWithContext(
      context,
      "purchase",
      purchaseCreateInput.parse({
        vendorId: vendor.id,
        orderId: `${name} order`,
        date: "2026-05-15",
        statedTotal: 42.5,
        notes: null,
        pendingImageIds: [],
      }),
    );
    const product = products[index % products.length];
    await createFixtureWithContext(
      context,
      "expense",
      expenseCreateInput.parse({
        name: `${name} expense`,
        cost: 42.5,
        date: "2026-05-15",
        costType: "materials",
        trade: "other",
        productId: product?.id ?? null,
        productQuantity: product ? 1 : null,
        purchaseId: purchase.id,
      }),
    );
  }

  console.log("[dev-db] Seeding a member ledger party...");
  await insertWithShortcode(db, "ledgerParty", {
    name: "Household Member",
    kind: "member",
    userId: testUserId(userId),
  });

  console.log("[dev-db] Seeding a photo-inventory run...");
  await startPhotoInventoryRun(db, {
    actorUserId: testUserId(userId),
  });
}
