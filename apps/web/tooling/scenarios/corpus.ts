import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { seedBaseWorld } from "../factories/base-world";
import { type CreatableEntity, type EntityOverrides } from "../factories/build";
import { createEntity } from "../factories/create";
import { DEV_FAKER_SEED, fakerFromSeed } from "../factories/faker";
import { taxonomyShortcode } from "../product-category-fixtures";
import { buildKernelContext, buildScenarioDatabase } from "./context";

/**
 * A deterministic synthetic household corpus for local `dev` iteration: a
 * location tree, a product taxonomy, products, inventory, a financial
 * account, and a few tasks — everything a fixture-backed preview route or a
 * developer poking at the UI needs to see non-empty screens.
 *
 * Built from the shared factories with the fixed dev seed, so a reseed
 * produces the same household. Deliberately narrower than the full E2E fixture
 * set under tests/e2e/fixtures-*.ts: it skips recipes/cookbooks (need the
 * `@cubby/recipebridge` WASM build) and the more elaborate multi-step
 * Playwright-only scenarios (relationship review, wardrobe, inheritance,
 * etc.) rather than reimplementing their Page-driven flows headlessly.
 */
export async function seedCorpus(pool: Pool, userId: string): Promise<void> {
  const faker = fakerFromSeed(DEV_FAKER_SEED);
  const db = buildScenarioDatabase(pool);
  // testUserId() only brands the string (see @cubby/schemas/test-support) — it
  // is the real, database-backed dev user's id from better-auth sign-up, not
  // a fabricated one.
  const context = buildKernelContext(db, testUserId(userId));
  const create = <E extends CreatableEntity>(
    entity: E,
    overrides: EntityOverrides<E> = {},
  ) => createEntity(context, entity, overrides, { faker });

  console.log("[dev-db] Seeding household root and taxonomy...");
  await seedBaseWorld(db.clientForRepository());

  console.log("[dev-db] Seeding locations...");
  const locations = [];
  for (const name of ["Kitchen", "Pantry", "Garage"]) {
    locations.push(await create("location", { name }));
  }

  console.log("[dev-db] Seeding products and inventory...");
  const productCount = 8;
  const products = [];
  for (let index = 0; index < productCount; index += 1) {
    const product = await create("product", {
      name: faker.commerce.productName(),
      manufacturer: faker.company.name(),
      model: null,
      categoryId: taxonomyShortcode("food"),
    });
    products.push(product);
    const location = locations[index % locations.length];
    if (!location) continue;
    await create("inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: faker.number.int({ min: 1, max: 12 }), unit: "each" },
    });
  }

  console.log("[dev-db] Seeding a financial account and ledger party...");
  await create("financialAccount", { name: "Household Checking" });
  await create("ledgerParty", { name: faker.company.name() });

  console.log("[dev-db] Seeding tasks...");
  for (const name of [
    "Replace pantry shelf liner",
    "Service the garage door opener",
    "Restock cleaning supplies",
  ]) {
    await create("task", { name, trade: "other" });
  }

  console.log("[dev-db] Seeding projects...");
  for (const name of ["Kitchen refresh", "Garage organization"]) {
    await create("project", {
      name,
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
  }

  console.log("[dev-db] Seeding a vendor with purchases and expenses...");
  const vendor = await create("vendor", {
    name: "Synthetic Supply Co",
    website: "https://example.com",
  });
  for (const [index, name] of [
    "Kitchen restock",
    "Garage supplies",
  ].entries()) {
    const purchase = await create("purchase", {
      vendorId: vendor.id,
      orderId: `${name} order`,
      date: "2026-05-15",
      statedTotal: 42.5,
    });
    const product = products[index % products.length];
    await create("expense", {
      name: `${name} expense`,
      cost: 42.5,
      date: "2026-05-15",
      productId: product?.id ?? null,
      productQuantity: product ? 1 : null,
      purchaseId: purchase.id,
    });
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
