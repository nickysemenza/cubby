import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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
  await seedBaseWorld(db.clientForRepository());
  const context = buildKernelContext(db, testUserId(userId));

  const kitchen = await createEntity(context, "location", {
    name: "Synthetic Kitchen",
  });
  const shelf = await createEntity(context, "location", {
    name: "Synthetic Pantry Shelf",
  });
  const ingredient = await createEntity(context, "ingredient", {
    name: "Synthetic Flour",
  });
  const product = await createEntity(context, "product", {
    name: "Synthetic Flour Bag",
    manufacturer: "Synthetic Mill",
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
    startDate: "2026-05-01",
    endDate: "2026-05-31",
  });
  const task = await createEntity(context, "task", {
    name: "Synthetic shelf liner",
    trade: "other",
  });
  const account = await createEntity(context, "financialAccount", {
    name: "Synthetic Checking",
  });
  const split = await seedSplitSettlement(pool, userId);
  const approvalRun = await seedPendingApprovalRun(pool, userId);
  return {
    ...split,
    ...approvalRun,
    LOCATION_ID: kitchen.id,
    SHELF_ID: shelf.id,
    INGREDIENT_ID: ingredient.id,
    PRODUCT_ID: product.id,
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
 * Two Purchases sharing one unallocated synthetic card charge: the financial settlement
 * slot's statement-match journey.
 */
export async function seedSplitSettlement(
  pool: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const db = buildScenarioDatabase(pool);
  const member = await pool.query<{ id: string }>(
    'SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL LIMIT 1',
    [userId, "member"],
  );
  const memberId = member.rows[0]?.id;
  if (!memberId) throw new Error("Synthetic member party is missing");
  const splitVendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic Split Vendor",
  });
  const splitFirst = await insertWithShortcode(db, "purchase", {
    vendorId: splitVendor.id,
    orderId: "SYN-SPLIT-1",
    date: "2026-09-10",
    statedTotal: 42.5,
  });
  const splitSecond = await insertWithShortcode(db, "purchase", {
    vendorId: splitVendor.id,
    orderId: "SYN-SPLIT-2",
    date: "2026-09-10",
    statedTotal: 48.5,
  });
  const card = await insertWithShortcode(db, "financialAccount", {
    name: "Synthetic Split Card",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
  });
  const charge = await insertWithShortcode(db, "financialTransaction", {
    accountId: card.id,
    kind: "purchase",
    status: "posted",
    amount: 91,
    merchant: "Synthetic Split Vendor",
    transactionDate: "2026-09-12",
    postedDate: "2026-09-12",
  });
  return {
    SPLIT_PURCHASE_ID: splitFirst.shortcode,
    SPLIT_PURCHASE_2_ID: splitSecond.shortcode,
    SPLIT_CHARGE_ID: charge.shortcode,
  };
}

/** A running import Run holding one approval that awaits the household's decision. */
export async function seedPendingApprovalRun(
  pool: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const db = buildScenarioDatabase(pool);
  const member = await pool.query<{ id: string }>(
    'SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL LIMIT 1',
    [userId, "member"],
  );
  const memberId = member.rows[0]?.id;
  if (!memberId) throw new Error("Synthetic member party is missing");
  const vendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic Approval Vendor",
    website: "https://shop.example.test",
    browserDomains: ["shop.example.test"],
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic approval account",
    vendorId: vendor.id,
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
  });
  const run = await startOrResumeRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    vendorAccountId: account.id,
    trigger: "manual",
  });
  const runRow = await pool.query<{ id: string }>(
    'SELECT id FROM "Run" WHERE shortcode = $1',
    [run.publicId],
  );
  const fingerprint = "a".repeat(64);
  // The decision command reads the paused operation's proposal; the approval row is what the
  // Run console lists while it waits.
  await pool.query(
    `INSERT INTO "RunOperation" ("runId", "operationId", kind, "inputFingerprint", state, result)
     VALUES ($1, 'synthetic-approval-1', 'synthetic.apply', $2, 'paused_approval', $3)`,
    [
      runRow.rows[0]?.id,
      fingerprint,
      JSON.stringify({
        approvalProposal: {
          operationKind: "synthetic.apply",
          args: { note: "synthetic" },
          targetFingerprint: fingerprint,
          evidenceFingerprint: fingerprint,
        },
      }),
    ],
  );
  const approval = await pool.query<{ id: string }>(
    `INSERT INTO "RunApproval" ("runId", "operationId", "operationKind", args, "argsFingerprint", "targetFingerprint", "evidenceFingerprint")
     VALUES ($1, 'synthetic-approval-1', 'synthetic.apply', '{"note":"synthetic"}', $2, $2, $2) RETURNING id`,
    [runRow.rows[0]?.id, fingerprint],
  );
  await pool.query('UPDATE "Run" SET status = $2 WHERE id = $1', [
    runRow.rows[0]?.id,
    "paused_approval",
  ]);
  return {
    APPROVAL_RUN_ID: run.publicId,
    APPROVAL_ID: approval.rows[0]?.id ?? "",
  };
}
