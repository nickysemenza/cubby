import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { seedBaseWorld } from "../factories/base-world";
import { createEntity } from "../factories/create";
import { taxonomyShortcode } from "../product-category-fixtures";
import { buildKernelContext, buildScenarioDatabase } from "./context";
import { JOURNEY_NAMES } from "../tester-army/names";

/**
 * One synthetic household serving every Tester Army journey. Each journey owns
 * its records, so journeys can run in any order and destructive ones (delete,
 * split, move) never disturb another journey's start state. Everything is
 * invented; the returned codes are handed to the journeys, never hard-coded.
 */
export type JourneySeed = Record<string, Record<string, string>>;

export async function seedJourneyWorld(
  pool: Pool,
  userId: string,
): Promise<JourneySeed> {
  const db = buildScenarioDatabase(pool);
  await seedBaseWorld(db.clientForRepository());
  const c = buildKernelContext(db, testUserId(userId));
  const category = taxonomyShortcode("household");
  const vendor = await createEntity(c, "vendor", {
    name: "Synthetic Journey Vendor",
  });
  const product = (name: string) =>
    createEntity(c, "product", {
      name,
      manufacturer: "Synthetic Works",
      model: null,
      categoryId: category,
    });

  const seed: JourneySeed = {};

  const rename = await product(JOURNEY_NAMES.productName);
  seed["product-rename"] = { product: rename.id };

  // Receive: expense linked to a product, awaiting arrival.
  const receivePurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-RECEIVE-1",
    date: "2026-05-15",
  });
  const receiveProduct = await product("Synthetic Receivable Widget");
  const receiveShelf = await createEntity(c, "location", {
    name: JOURNEY_NAMES.receiveShelf,
  });
  const receiveExpense = await createEntity(c, "expense", {
    name: "Synthetic receivable widget",
    cost: 30,
    date: "2026-05-15",
    productId: receiveProduct.id,
    productQuantity: 3,
    purchaseId: receivePurchase.id,
    trade: "other",
  });
  seed["receive-purchase"] = {
    expense: receiveExpense.id,
    product: receiveProduct.id,
    location: receiveShelf.id,
    purchase: receivePurchase.id,
  };

  const addProduct = await product("Synthetic Stockable Lamp");
  const inventoryShelf = await createEntity(c, "location", {
    name: JOURNEY_NAMES.inventoryShelf,
  });
  seed["hero-add-inventory"] = {
    product: addProduct.id,
    location: inventoryShelf.id,
  };

  const saleProduct = await product("Synthetic Saleable Chair");
  seed["hero-record-sale"] = { product: saleProduct.id };

  const statusProject = await createEntity(c, "project", {
    name: "Synthetic Status Project",
  });
  seed["hero-set-status"] = { project: statusProject.id };

  const wish = await createEntity(c, "wish", {
    name: "Synthetic Wish Lantern",
  });
  seed["hero-mark-purchased"] = { wish: wish.id };

  const deleteProject = await createEntity(c, "project", {
    name: "Synthetic Delete Project",
  });
  const deleteTask = await createEntity(c, "task", {
    name: "Synthetic doomed task",
    projectId: deleteProject.id,
    trade: "other",
  });
  seed["hero-delete-task"] = { task: deleteTask.id };

  // Tags and collections: a collection assignment lives in `tags` as collection:<slug>.
  const tagged = await createEntity(c, "product", {
    name: "Synthetic Tagged Kettle",
    manufacturer: "Synthetic Works",
    model: null,
    categoryId: category,
    tags: ["synthetic-old-tag", "collection:synthetic-shelf"],
  });
  seed["field-product-tags"] = { product: tagged.id };

  const account = await createEntity(c, "financialAccount", {
    name: "Synthetic Alias Account",
  });
  seed["field-source-alias"] = { account: account.id };

  const claimExpense = await createEntity(c, "expense", {
    name: "Synthetic claim expense",
    cost: 10,
    trade: "other",
    sourceClaims: [
      {
        source: "synthetic-provider",
        providerId: "synthetic-row-1",
        normalizedEvidence: {
          amount: 10,
          occurredOn: "2026-08-20",
          description: "Synthetic claim evidence",
          context: null,
          disambiguator: null,
        },
        reconciliation: { decision: "amounts_match" },
      },
    ],
  });
  const claim = await pool.query<{ id: string; sourceKey: string }>(
    `SELECT c.id::text AS id, c."sourceKey" AS "sourceKey" FROM "LedgerSourceClaim" c
     JOIN "Expense" e ON e.id = c."expenseId" WHERE e.shortcode = $1`,
    [claimExpense.id],
  );
  const claimRow = claim.rows[0];
  if (!claimRow) throw new Error("Synthetic source claim was not seeded");
  seed["field-source-claim"] = {
    expense: claimExpense.id,
    claimId: claimRow.id,
    sourceKey: claimRow.sourceKey,
  };

  const ingredient = await createEntity(c, "ingredient", {
    name: "Synthetic Line Flour",
  });
  const recipe = await createEntity(c, "recipe", {
    name: "Synthetic Line Pancakes",
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
        instructions: [{ instruction: "Whisk the flour with water." }],
      },
    ],
  });
  seed["field-recipe-line"] = { recipe: recipe.id };

  // Finance.
  const splitPurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-SPLIT-A",
    date: "2026-06-01",
  });
  const splitExpense = await createEntity(c, "expense", {
    name: "Synthetic splittable",
    cost: 10.01,
    date: "2026-06-01",
    purchaseId: splitPurchase.id,
    trade: "other",
  });
  seed["finance-split-expense"] = {
    expense: splitExpense.id,
    purchase: splitPurchase.id,
  };

  const blankPurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-SPLIT-B",
    date: "2026-06-02",
  });
  const blankExpense = await createEntity(c, "expense", {
    name: "Synthetic costless",
    date: "2026-06-02",
    purchaseId: blankPurchase.id,
    trade: "other",
  });
  seed["finance-split-unknown-cost"] = {
    expense: blankExpense.id,
    purchase: blankPurchase.id,
  };

  const targetPurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-ATTACH-TARGET",
    date: "2026-06-03",
  });
  const otherPurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-ATTACH-OTHER",
    date: "2026-06-03",
  });
  const movable = await createEntity(c, "expense", {
    name: "Synthetic movable expense",
    cost: 12,
    date: "2026-06-03",
    purchaseId: otherPurchase.id,
    trade: "other",
  });
  seed["finance-attach-expenses"] = {
    purchase: targetPurchase.id,
    otherPurchase: otherPurchase.id,
    expense: movable.id,
  };

  const attachPurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-ATTACH-PRODUCT",
    date: "2026-06-04",
  });
  const attachable = await product("Synthetic Attachable Sieve");
  seed["finance-attach-products"] = {
    purchase: attachPurchase.id,
    product: attachable.id,
  };

  // Task board: two projects and an Inbox task.
  const lanesA = await createEntity(c, "project", {
    name: JOURNEY_NAMES.boardProjectA,
  });
  await createEntity(c, "project", { name: JOURNEY_NAMES.boardProjectB });
  const inboxTask = await createEntity(c, "task", {
    name: "Synthetic inbox card",
    trade: "other",
  });
  await createEntity(c, "task", {
    name: "Synthetic lane A card",
    projectId: lanesA.id,
    trade: "other",
  });
  seed["board-move-card"] = { task: inboxTask.id };

  const labeled = await createEntity(c, "product", {
    name: "Synthetic Labeled Crackers",
    manufacturer: "Synthetic Works",
    model: null,
    categoryId: taxonomyShortcode("food"),
    labelNutrition: {
      servingGrams: 30,
      nutrients: { kcal: 120, protein: 3 },
      source: "Synthetic label",
    },
  });
  seed["field-label-nutrition"] = { product: labeled.id };

  const externalIdProduct = await product("Synthetic Catalog Whisk");
  seed["field-external-ids"] = { product: externalIdProduct.id };

  const refAccount = await createEntity(c, "financialAccount", {
    name: "Synthetic Ref Account",
  });
  const refTransaction = await createEntity(c, "financialTransaction", {
    accountId: refAccount.id,
    kind: "purchase",
    status: "posted",
    amount: 21,
    merchant: "Synthetic Ref Merchant",
    transactionDate: "2026-06-05",
    postedDate: "2026-06-05",
  });
  seed["field-source-refs"] = { transaction: refTransaction.id };

  const member = await pool.query<{ id: string }>(
    'SELECT id FROM "LedgerParty" WHERE "userId" = $1 AND kind = $2 AND "deletedAt" IS NULL LIMIT 1',
    [userId, "member"],
  );
  const memberId = member.rows[0]?.id;
  if (!memberId) throw new Error("Synthetic member party is missing");
  const runVendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic Run Vendor",
    website: "https://shop.example.test",
    browserDomains: ["shop.example.test"],
  });
  const runAccount = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic run account",
    vendorId: runVendor.id,
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
  });
  const validatePurchase = await createEntity(c, "purchase", {
    vendorId: runVendor.shortcode,
    vendorAccountId: runAccount.shortcode,
    orderId: "SYN-VALIDATE-1",
    date: "2026-06-06",
  });
  seed["related-purchase-validate"] = { purchase: validatePurchase.id };

  const consoleRun = await startOrResumeRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    vendorAccountId: runAccount.id,
    trigger: "manual",
  });
  const runRow = await pool.query<{ id: string }>(
    'SELECT id FROM "Run" WHERE shortcode = $1',
    [consoleRun.publicId],
  );
  const runUuid = runRow.rows[0]?.id;
  const purchaseRow = await pool.query<{ id: string }>(
    'SELECT id FROM "Purchase" WHERE shortcode = $1',
    [validatePurchase.id],
  );
  await pool.query(
    `INSERT INTO "RunProgress" ("runId", "eventId", phase, "currentItem", detail)
     VALUES ($1, 'synthetic-progress-1', 'Reading synthetic orders', 'Synthetic order 7', 'Synthetic progress detail')`,
    [runUuid],
  );
  await pool.query(
    `INSERT INTO "RunFinding" ("runId", "ledgerPartyId", "entityId", "entityKind", kind, summary, "evidenceFingerprint")
     VALUES ($1, $2, $3, 'purchase', 'synthetic_note', 'Synthetic finding to resolve', $4)`,
    [runUuid, memberId, purchaseRow.rows[0]?.id, "b".repeat(64)],
  );
  await pool.query('UPDATE "Run" SET status = $2 WHERE id = $1', [
    runUuid,
    "running",
  ]);
  seed["run-console"] = { run: consoleRun.publicId };

  return seed;
}
