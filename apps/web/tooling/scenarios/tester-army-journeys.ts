import { testUserId } from "@cubby/schemas/testing";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { purchaseValidationResearchRunInput } from "@cubby/schemas/run-fields";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { ledgerParty } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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

  // Picker regressions: a missing joined label must resolve to a name; the
  // current selection must be revealed below the first screen of candidates.
  const pickerProject = await createEntity(c, "project", {
    name: JOURNEY_NAMES.pickerProject,
    status: "in_progress",
    costEstimate: 5000,
  });
  const pickerReplacement = await createEntity(c, "project", {
    name: JOURNEY_NAMES.pickerReplacement,
    status: "done",
  });
  const pickerVendor = await createEntity(c, "vendor", {
    name: JOURNEY_NAMES.pickerVendor,
  });
  for (let index = 0; index < 20; index++) {
    await createEntity(c, "project", {
      name: `Synthetic Picker Project ${String(index).padStart(2, "0")}`,
      status: index % 2 === 0 ? "done" : "planning",
      ...(index % 2 === 0 ? { costEstimate: 20 + index } : {}),
    });
    const alternative = await createEntity(c, "vendor", {
      name: `Synthetic Picker Vendor ${String(index).padStart(2, "0")}`,
    });
    for (let order = 0; order < 3; order++)
      await createEntity(c, "purchase", {
        vendorId: alternative.id,
        orderId: `SYN-PICKER-${index}-${order}`,
      });
  }
  for (const id of ["record-picker-desktop", "record-picker-phone"]) {
    const purchase = await createEntity(c, "purchase", {
      vendorId: pickerVendor.id,
      orderId: `SYN-${id}`,
      defaultProjectId: pickerProject.id,
    });
    seed[id] = {
      purchase: purchase.id,
      project: pickerProject.id,
      replacement: pickerReplacement.id,
      vendor: pickerVendor.id,
    };
  }

  const [emailOwner] = await db
    .clientForRepository()
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(eq(ledgerParty.userId, testUserId(userId)))
    .limit(1);
  if (!emailOwner) throw new Error("Synthetic Email member is missing");
  const reviewEmail = await insertWithShortcode(db, "email", {
    ledgerPartyId: emailOwner.id,
    mailboxId: "synthetic-review-mailbox",
    messageId: "synthetic-navigation-receipt",
    sender: "receipts@example.test",
    subject: "Synthetic Email navigation receipt",
    receivedAt: new Date("2026-05-15T12:00:00Z"),
    checksum: "a".repeat(64),
    classification: "related",
    classificationStage: "rule",
    classificationReason: "Synthetic purchase confirmation",
    classificationVersion: "synthetic-navigation-v1",
    executionPolicy: "classification_only",
    status: "completed",
  });
  seed["email-navigation"] = { email: reviewEmail.shortcode };

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
  const deleteChild = await createEntity(c, "task", {
    name: "Synthetic dependent checklist item",
    parentTaskId: deleteTask.id,
    trade: "other",
  });
  seed["hero-delete-task"] = {
    task: deleteTask.id,
    child: deleteChild.id,
    project: deleteProject.id,
  };

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
  // Photo runs render grouping review; validation runs render progress and findings.
  const consoleRun = await startPhotoInventoryRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    actorUserId: testUserId(userId),
  });
  const consolePurchase = await createEntity(c, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-CONSOLE-1",
    date: "2026-06-06",
  });
  const runRow = await pool.query<{ id: string }>(
    'SELECT id FROM "Run" WHERE shortcode = $1',
    [consoleRun.publicId],
  );
  const runUuid = runRow.rows[0]?.id;
  const purchaseRow = await pool.query<{ id: string }>(
    'SELECT id FROM "Purchase" WHERE shortcode = $1',
    [consolePurchase.id],
  );
  await pool.query(
    `UPDATE "Run" SET purpose = 'purchase_validation', input = $2::jsonb WHERE id = $1`,
    [
      runUuid,
      JSON.stringify(
        purchaseValidationResearchRunInput.parse({
          kind: "purchase_validation_research",
          instructionRevision: 1,
          purchases: [
            {
              purchaseId: purchaseRow.rows[0]?.id,
              contextFingerprint: "b".repeat(64),
              selectedSource: null,
            },
          ],
        }),
      ),
    ],
  );
  await pool.query(
    `UPDATE "Run" SET "liveProgress" = jsonb_build_object(
       'eventId', 'synthetic-progress-1', 'generation', 'legacy', 'sequence', 1,
       'phase', 'Reading synthetic orders', 'currentItem', 'Synthetic order 7',
       'detail', 'Synthetic progress detail', 'awaitingApproval', false,
       'createdAt', '2026-06-06T12:00:00.000Z'),
       "progressEventIds" = '["synthetic-progress-1"]'::jsonb,
       "heartbeatAt" = '2026-06-06T12:00:00Z' WHERE id = $1`,
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
  await pool.query(
    'UPDATE "Run" SET "progressHistory" = jsonb_build_array("liveProgress") WHERE id = $1',
    [runUuid],
  );
  seed["run-console"] = { run: consoleRun.publicId };

  return seed;
}
