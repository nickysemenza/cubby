import { resolveDatabaseRuntime } from "~/server/db/database-runtime";
import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { writeOutcomeReceipts } from "~/server/domains/purchase-import/service/run-outcome.fixtures";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { getDb } from "~/server/db/helpers";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { seedBaseWorld } from "../factories/base-world";
import { createEntity } from "../factories/create";
import { taxonomyShortcode } from "../product-category-fixtures";
import { buildKernelContext, buildScenarioDatabase } from "./context";

/**
 * A synthetic household for the native QA lane (`test:e2e:sim -- --qa`): enough
 * linked records that each generic detail, report and sheet has real data to
 * draw. Everything is invented; ids returned are exported to the journeys as
 * `-e KEY=value` variables.
 */
export async function seedNativeQa(
  pool: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const db = buildScenarioDatabase(pool);
  await seedBaseWorld(resolveDatabaseRuntime(db).client);
  const context = buildKernelContext(db, testUserId(userId));

  const kitchen = await createEntity(context, "location", {
    name: "Synthetic Kitchen",
  });
  const shelf = await createEntity(context, "location", {
    name: "Synthetic Pantry Shelf",
  });
  // The shelf's child: choosing it as the shelf's parent is a server-rejected cycle, the
  // deterministic save failure `qa-save-error.ad` drives.
  await createEntity(context, "location", {
    name: "Synthetic Spice Drawer",
    parentId: shelf.id,
  });
  const ingredient = await createEntity(context, "ingredient", {
    name: "Synthetic Flour",
  });
  const keyboardProduct = await createEntity(context, "product", {
    name: "Synthetic Identifier Keyboard Sample",
  });
  const brand = await createEntity(context, "vendor", {
    name: "Synthetic Mill",
  });
  const product = await createEntity(context, "product", {
    name: "Synthetic Flour Bag",
    brandId: brand.id,
    model: null,
    categoryId: taxonomyShortcode("food"),
    ingredientId: ingredient.id,
    price: 4.5,
    unitMappings: [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 120, unit: "g" },
        source: "Synthetic label",
      },
      {
        a: { value: 100, unit: "g" },
        b: { value: 364, unit: "kcal" },
        source: "Synthetic label",
      },
    ],
  });
  const inventory = await createEntity(context, "inventory", {
    productId: product.id,
    locationId: kitchen.id,
    amount: { value: 6, unit: "each" },
  });
  const shelfInventory = await createEntity(context, "inventory", {
    productId: product.id,
    locationId: shelf.id,
    amount: { value: 3, unit: "each" },
  });
  const recipe = await createEntity(context, "recipe", {
    name: "Synthetic Pancakes",
    meta: null,
    sections: [
      {
        ingredients: [
          {
            type: "ingredient",
            ingredientId: ingredient.id,
            recipeId: null,
            amounts: [{ value: 250, unit: "g" }],
          },
        ],
        instructions: [
          { instruction: "Whisk the flour with 2 cups of water." },
          { instruction: "Rest the batter for 10 minutes, then cook." },
        ],
      },
    ],
  });
  const vendor = await createEntity(context, "vendor", {
    name: "Synthetic Supply Co",
    website: "https://example.com",
  });
  const purchase = await createEntity(context, "purchase", {
    vendorId: vendor.id,
    orderId: "Synthetic Order 1",
    date: "2026-05-15",
    statedTotal: 42.5,
  });
  const expense = await createEntity(context, "expense", {
    name: "Synthetic flour expense",
    cost: 42.5,
    date: "2026-05-15",
    productId: product.id,
    productQuantity: 1,
    purchaseId: purchase.id,
    trade: "other",
  });
  const project = await createEntity(context, "project", {
    name: "Synthetic Kitchen Refresh",
    dates: { start: "2026-05-01", end: "2026-05-31" },
  });
  const task = await createEntity(context, "task", {
    name: "Synthetic shelf liner",
    trade: "other",
  });
  const account = await createEntity(context, "financialAccount", {
    name: "Synthetic Checking",
  });
  const pausedRun = await seedPausedRun(pool, userId);
  const researchMember = await pool.query<{
    id: string;
    shortcode: string;
    name: string;
  }>(
    'SELECT id, shortcode, name FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL LIMIT 1',
    [userId, "member"],
  );
  const member = researchMember.rows[0];
  if (!member) throw new Error("Synthetic research member is missing");
  const researchProduct = await pool.query<{ id: string }>(
    'SELECT id FROM "Product" WHERE shortcode = $1',
    [product.id],
  );
  const productId = researchProduct.rows[0]?.id;
  if (!productId) throw new Error("Synthetic research Product is missing");
  const research = await insertWithShortcode(db, "run", {
    purpose: "product_enrichment",
    trigger: "manual",
    status: "completed",
    ledgerPartyId: parseEntityId("ledgerParty", member.id),
    actorUserId: testUserId(userId),
    actorName: "Synthetic member",
    actorEmail: "member@example.test",
    actorLedgerPartyShortcode: member.shortcode,
    actorLedgerPartyName: member.name,
    actorLedgerPartyKind: "member",
  });
  await writeOutcomeReceipts(db, [
    {
      runId: research.id,
      entityKind: "product",
      entityId: parseEntityId("product", productId),
      workKey: "synthetic-product-research",
      targetFingerprint: "synthetic-product-fingerprint",
      state: "completed",
      outcome: "partially_verified",
      completedAt: new Date("2026-09-20T12:00:00Z"),
      warning: "Exact model remains unsupported",
      diff: {},
    },
  ]);
  const garden = await seedScopedPlantingPicker(pool, context);
  return {
    ...pausedRun,
    ...garden,
    LOCATION_ID: kitchen.id,
    SHELF_ID: shelf.id,
    INGREDIENT_ID: ingredient.id,
    PRODUCT_ID: product.id,
    KEYBOARD_PRODUCT_ID: keyboardProduct.id,
    PRODUCT_RESEARCH_RUN_ID: research.shortcode,
    INVENTORY_ID: inventory.id,
    SHELF_INVENTORY_ID: shelfInventory.id,
    RECIPE_ID: recipe.id,
    VENDOR_ID: vendor.id,
    PURCHASE_ID: purchase.id,
    EXPENSE_ID: expense.id,
    PROJECT_ID: project.id,
    TASK_ID: task.id,
    ACCOUNT_ID: account.id,
  };
}

/**
 * A Garden Entry on the north bed whose planting picker is scoped by its location and date. The
 * south bed holds more active plantings than one picker page (25), so the journey must page to
 * reach `PAGE_TWO_PLANTING`. The seed reads the list's default order (newest first, then the
 * shortcode tiebreak) instead of assuming which planting lands on which page.
 */
async function seedScopedPlantingPicker(
  pool: Pool,
  context: ReturnType<typeof buildKernelContext>,
): Promise<Record<string, string>> {
  const north = await createEntity(context, "location", {
    name: "Synthetic Bed North",
  });
  const south = await createEntity(context, "location", {
    name: "Synthetic Bed South",
  });
  const plant = async (name: string, locationId: string) => {
    const created = await createEntity(context, "plant", { name });
    return createEntity(context, "planting", {
      plantId: created.id,
      locationId,
      status: "growing",
      season: { start: "2026-05-01", end: null },
    });
  };
  const northPlanting = await plant("Synthetic Pea", north.id);
  for (let index = 1; index <= 26; index += 1)
    await plant(`Synthetic Bean ${String(index).padStart(2, "0")}`, south.id);
  const entry = await createEntity(context, "gardenEntry", {
    locationId: north.id,
    observedOn: "2026-06-01",
    kind: "note",
    notes: "Synthetic picker check",
    plantingIds: [],
  });
  const southBeans = await pool.query<{ shortcode: string; name: string }>(
    `SELECT p.shortcode, pl.name FROM "Planting" p
     JOIN "Plant" pl ON pl.id = p."plantId"
     JOIN "Location" l ON l.id = p."locationId"
     WHERE l.shortcode = $1 AND p."deletedAt" IS NULL AND pl.name LIKE 'Synthetic Bean %'
     ORDER BY p."createdAt" DESC, p.shortcode`,
    [south.id],
  );
  const first = southBeans.rows[0];
  const last = southBeans.rows.at(-1);
  if (!first || !last || southBeans.rows.length !== 26)
    throw new Error(
      `Expected 26 south plantings, found ${southBeans.rows.length}`,
    );
  return {
    GARDEN_ENTRY_ID: entry.id,
    NORTH_PLANTING_ID: northPlanting.id,
    SOUTH_BED_ID: south.id,
    PAGE_ONE_PLANTING: first.name,
    PAGE_ONE_PLANTING_ID: first.shortcode,
    PAGE_TWO_PLANTING: last.name,
    PAGE_TWO_PLANTING_ID: last.shortcode,
  };
}

/** A running Run on a fresh photo inventory (`notes` keeps seeds apart). */
export async function startSyntheticRun(
  pool: Pool,
  userId: string,
  name: string,
) {
  return startPhotoInventoryRun(buildScenarioDatabase(pool), {
    actorUserId: testUserId(userId),
    notes: `Synthetic ${name} run`,
  });
}

/** A member-paused import Run with one recorded operation in its transcript. */
export async function seedPausedRun(
  pool: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const db = buildScenarioDatabase(pool);
  const run = await startSyntheticRun(pool, userId, "Paused");
  await insertOperation(getDb(db), {
    runId: run.id,
    operationId: "synthetic-operation-1",
    kind: "synthetic.apply",
    inputFingerprint: "a".repeat(64),
    state: "completed",
    result: { note: "synthetic" },
  });
  await pool.query('UPDATE "Run" SET status = $2 WHERE shortcode = $1', [
    run.publicId,
    "paused",
  ]);
  return { PAUSED_RUN_ID: run.publicId };
}
