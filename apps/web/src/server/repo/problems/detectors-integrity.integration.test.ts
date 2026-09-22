import { entitySchema, type Entity } from "@cubby/schemas/entity";
import type { EdgeRole } from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { parseEntityId, userId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import {
  expenseAttribution,
  financialTransactionAllocation,
  gardenEntryImage,
  gardenEntryPlanting,
  imageDerivative,
  imageDescriptionCorrection,
  imageProcessingJob,
  imageSighting,
  importFinding,
  importHunt,
  importPreparedOrder,
  importRun,
  importRunApproval,
  importRunControlEvent,
  importRunEvidence,
  importRunMutation,
  importRunOperation,
  importRunOrderCandidate,
  importRunProgress,
  importRunTarget,
  importSourceClaim,
  ledgerParty,
  ledgerSourceClaim,
  locationImage,
  mailboxCursor,
  mealImage,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  merchantVendorRule,
  orderMail,
  orderMailAttachment,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productImage,
  productUnitMappings,
  projectDependency,
  projectImage,
  projectToolUsage,
  purchaseImage,
  purchasePaymentEvidence,
  purchaseProduct,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
  statementImport,
  statementRow,
  taskDependency,
  taskImage,
  user,
  wishCandidate,
} from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { makeCookbookExtraction } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  countDependencyCycles,
  findDependencyCycles,
  findReferentialLivenessViolations,
} from "./detectors-integrity";

/**
 * Regression suite for `findReferentialLivenessViolations` (detectors-integrity.ts)
 * — the audit that finds every LIVE row whose FK points at a SOFT-DELETED target,
 * across every `must-target-live` incoming edge in `ENTITY_EDGE_SEMANTICS`.
 *
 * The matrix below is driven from `INCOMING_EDGES` × `ENTITY_EDGE_SEMANTICS`
 * themselves (not a hand-copied edge list), so a newly-added `must-target-live`
 * edge fails the "fixture map covers exactly the derived edges" test loudly
 * instead of silently going unaudited. Per-edge fixture construction is
 * necessarily hand-written (every source table has its own extra NOT NULL
 * columns — a `task` row needs `trade`, a `productUnitMappings` row needs `a`/`b`
 * jsonb, etc.) but the coverage check, not the construction, is what has to stay
 * generic — see product.integration.test.ts's "PRODUCT_EDGE_ROLES backstop" for
 * the same tradeoff made the same way.
 *
 * Fixtures bypass the repo layer entirely and insert straight into the tables
 * via `insertAndReturn` / raw `UPDATE ... SET "deletedAt"`. That is deliberate,
 * not a shortcut: the real create/delete paths are exactly what this audit exists
 * to backstop (`deleteProducts` etc. actively REFUSE to leave a dangling
 * reference — see product.integration.test.ts's PRODUCT_HAS_INVENTORY/
 * PRODUCT_HAS_EXPENSES/PRODUCT_HAS_TASKS guards), so manufacturing the violation
 * this test is asserting on requires reaching around that protection, per the
 * task's own "direct UPDATE is correct when manufacturing a violation the real
 * path would prevent" guidance.
 */

let seq = 0;
/** A short, always-unique suffix — every fixture row that needs a unique
 * name/shortcode/key gets one so unrelated cases (which never share a
 * database — see `withTestDb`'s per-test truncate) never collide with each
 * other within a single multi-row test case either. */
const uniq = (label: string) => `${label}-${(seq++).toString(36)}`;

const softDelete = (db: Database, tableName: string, id: string) =>
  getDb(db).execute(
    sql`UPDATE ${sql.identifier(tableName)} SET "deletedAt" = now() WHERE id = ${id}`,
  );

// Minimal live-row factories, one per table that appears as a TARGET entity's
// table or as a SOURCE (incoming-edge) table below. Each supplies only the
// columns with no default and no fallback (NOT NULL, no `.default()` in
// schema.ts) plus whichever FK the calling edge cares about.

const mkImage = (db: Database) =>
  insertWithShortcode(db, "image", {
    key: uniq("test/img"),
    filename: "img.png",
    size: 1,
    contentType: "image/png",
  });

const mkCookbook = (db: Database) =>
  insertWithShortcode(db, "cookbook", {
    name: uniq("Cookbook"),
    author: [],
    subjects: [],
    sourceLabel: "test",
    rawJson: makeCookbookExtraction(),
  });

const mkRecipe = (db: Database) =>
  insertWithShortcode(db, "recipe", { name: uniq("Recipe") });

const mkIngredient = (db: Database) =>
  insertWithShortcode(db, "ingredient", { name: uniq("Ingredient") });

const mkMeal = (db: Database) =>
  insertWithShortcode(db, "meal", { date: "2026-01-01" });

const mkProduct = (db: Database) =>
  insertWithShortcode(db, "product", {
    name: uniq("Product"),
    manufacturer: "Test Mfr",
  });

const mkLocation = (db: Database) =>
  insertWithShortcode(db, "location", {
    name: uniq("Location"),
    type: "room",
  });

const mkPlanting = async (db: Database) => {
  const [crop, growingLocation] = await Promise.all([
    mkIngredient(db),
    mkLocation(db),
  ]);
  return insertWithShortcode(db, "planting", {
    ingredientId: crop.id,
    locationId: growingLocation.id,
    status: "growing",
  });
};

const mkGardenEntry = async (db: Database) => {
  const growingLocation = await mkLocation(db);
  return insertWithShortcode(db, "gardenEntry", {
    locationId: growingLocation.id,
    observedOn: "2026-01-01",
  });
};

const mkProject = (db: Database) =>
  insertWithShortcode(db, "project", { name: uniq("Project") });

const mkTask = (db: Database) =>
  insertWithShortcode(db, "task", { name: uniq("Task"), trade: "other" });

const mkVendor = (db: Database) =>
  insertWithShortcode(db, "vendor", { name: uniq("Vendor") });

const mkPurchase = async (db: Database) => {
  const v = await mkVendor(db);
  return insertWithShortcode(db, "purchase", {
    vendorId: v.id,
    date: "2024-01-15",
  });
};

const mkFinancialAccount = (db: Database) =>
  insertWithShortcode(db, "financialAccount", {
    name: uniq("Financial account"),
    identity: { kind: "cash" },
  });

const mkFinancialTransaction = async (db: Database) => {
  const account = await mkFinancialAccount(db);
  return insertWithShortcode(db, "financialTransaction", {
    accountId: account.id,
    kind: "purchase",
    status: "pending",
    amount: 1,
  });
};

const mkWish = (db: Database) =>
  insertWithShortcode(db, "wish", { name: uniq("Wish") });

const mkExpense = (db: Database) =>
  insertWithShortcode(db, "expense", {
    name: uniq("Expense"),
    costType: "materials",
    trade: "other",
    date: "2024-01-15",
  });

const mkLedgerParty = (db: Database) =>
  insertWithShortcode(db, "ledgerParty", {
    name: uniq("Ledger party"),
    kind: "member",
  });

const mkLedgerTransfer = async (db: Database) => {
  const [from, to] = await Promise.all([mkLedgerParty(db), mkLedgerParty(db)]);
  return insertWithShortcode(db, "ledgerTransfer", {
    fromPartyId: from.id,
    toPartyId: to.id,
    amount: 1,
    date: "2024-01-15",
  });
};

const mkUser = (db: Database) =>
  insertAndReturn(db, user, {
    id: uniq("user"),
    name: "Liveness fixture",
    email: `${uniq("liveness")}@example.test`,
  });

const mkVendorAccount = async (db: Database) => {
  const [vendor, party] = await Promise.all([mkVendor(db), mkLedgerParty(db)]);
  return insertWithShortcode(db, "vendorAccount", {
    label: uniq("Vendor account"),
    vendorId: vendor.id,
    ledgerPartyId: party.id,
  });
};

const mkDevice = (db: Database) =>
  insertWithShortcode(db, "device", {
    installationId: uniq("installation"),
    name: uniq("Device"),
    platform: "ios",
  });

const mkImageSighting = async (
  db: Database,
  values: Partial<
    Pick<
      typeof imageSighting.$inferInsert,
      "imageId" | "ledgerPartyId" | "deviceId"
    >
  >,
) =>
  insertWithShortcode(db, "imageSighting", {
    imageId: values.imageId ?? (await mkImage(db)).id,
    ledgerPartyId: values.ledgerPartyId ?? (await mkLedgerParty(db)).id,
    deviceId: values.deviceId ?? (await mkDevice(db)).id,
    assetKey: uniq("asset"),
    localIdentifier: uniq("local"),
    sourceType: "userLibrary",
    matchKind: "import",
    observedAt: new Date(),
  });

const mkImportRun = async (
  db: Database,
  values: Partial<
    Pick<
      typeof importRun.$inferInsert,
      "ledgerPartyId" | "vendorAccountId" | "vendorId" | "predecessorRunId"
    >
  > = {},
) => {
  const party = values.ledgerPartyId ?? (await mkLedgerParty(db)).id;
  const [partySnapshot, actor] = await Promise.all([
    getDb(db)
      .select({
        shortcode: ledgerParty.shortcode,
        name: ledgerParty.name,
        kind: ledgerParty.kind,
      })
      .from(ledgerParty)
      .where(eq(ledgerParty.id, party))
      .then((rows) => rows[0]),
    mkUser(db),
  ]);
  if (!partySnapshot) throw new Error("Import run party fixture was not found");
  return insertAndReturn(db, importRun, {
    shortcode: generateShortcode("importRun"),
    ledgerPartyId: party,
    actorUserId: userId.parse(actor.id),
    actorName: actor.name,
    actorEmail: actor.email,
    actorLedgerPartyShortcode: partySnapshot.shortcode,
    actorLedgerPartyName: partySnapshot.name,
    actorLedgerPartyKind: partySnapshot.kind,
    vendorAccountId: values.vendorAccountId,
    vendorId: values.vendorId,
    predecessorRunId: values.predecessorRunId,
    trigger: "manual",
  });
};

const mkImportPreparedOrder = async (
  db: Database,
  values: Partial<
    Pick<
      typeof importPreparedOrder.$inferInsert,
      "primaryDocumentImageId" | "screenshotImageId" | "runId"
    >
  >,
) => {
  const run = values.runId ? { id: values.runId } : await mkImportRun(db);
  return insertAndReturn(db, importPreparedOrder, {
    runId: run.id,
    prepareOperationId: uniq("prepare-operation"),
    itemOperationId: uniq("item-operation"),
    stableOrderId: uniq("stable-order"),
    sourceKind: "browser_order",
    sourceExternalKey: uniq("source"),
    sourceChecksum: uniq("source-checksum"),
    evidenceChecksum: uniq("evidence-checksum"),
    extractionRevision: "fixture-v1",
    extraction: {},
    targetFingerprint: uniq("target-fingerprint"),
    evidenceFingerprint: uniq("evidence-fingerprint"),
    ...values,
  });
};

const mkImportRunTarget = async (
  db: Database,
  values: Partial<
    Pick<
      typeof importRunTarget.$inferInsert,
      "purchaseId" | "productId" | "imageId" | "vendorAccountId" | "runId"
    >
  >,
) => {
  const run = values.runId ? { id: values.runId } : await mkImportRun(db);
  return insertAndReturn(db, importRunTarget, {
    runId: run.id,
    purchaseId: values.purchaseId,
    productId: values.productId,
    imageId: values.imageId,
    vendorAccountId: values.vendorAccountId,
    targetFingerprint: uniq("target-fingerprint"),
  });
};

const mkImportSourceClaim = async (
  db: Database,
  values: Partial<
    Pick<
      typeof importSourceClaim.$inferInsert,
      | "ledgerPartyId"
      | "vendorAccountId"
      | "purchaseId"
      | "firstRunId"
      | "lastRunId"
    >
  > = {},
) => {
  const party = values.ledgerPartyId ?? (await mkLedgerParty(db)).id;
  const run = await mkImportRun(db);
  return insertAndReturn(db, importSourceClaim, {
    ledgerPartyId: party,
    vendorAccountId: values.vendorAccountId,
    purchaseId: values.purchaseId,
    kind: "browser_order",
    externalKey: uniq("source"),
    checksum: uniq("checksum"),
    firstRunId: values.firstRunId ?? run.id,
    lastRunId: values.lastRunId ?? run.id,
    outputFingerprint: uniq("output"),
  });
};

const mkImportHunt = async (
  db: Database,
  values: Partial<
    Pick<
      typeof importHunt.$inferInsert,
      | "ledgerPartyId"
      | "financialTransactionId"
      | "vendorId"
      | "vendorAccountId"
      | "receiptImageId"
      | "receiptRunId"
    >
  > = {},
) => {
  const party = values.ledgerPartyId ?? (await mkLedgerParty(db)).id;
  const transaction =
    values.financialTransactionId ?? (await mkFinancialTransaction(db)).id;
  return insertAndReturn(db, importHunt, {
    ledgerPartyId: party,
    financialTransactionId: transaction,
    vendorId: values.vendorId,
    vendorAccountId: values.vendorAccountId,
    receiptImageId: values.receiptImageId,
    receiptRunId: values.receiptRunId,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-02",
  });
};

const mkOrderMail = async (
  db: Database,
  values: Partial<
    Pick<typeof orderMail.$inferInsert, "ledgerPartyId" | "vendorId">
  > = {},
) => {
  const party = values.ledgerPartyId ?? (await mkLedgerParty(db)).id;
  return insertAndReturn(db, orderMail, {
    ledgerPartyId: party,
    vendorId: values.vendorId,
    messageId: uniq("message"),
    sender: "orders@example.test",
    subject: "Liveness fixture order",
    receivedAt: new Date("2026-01-01T12:00:00Z"),
    rawChecksum: uniq("mail-checksum"),
  });
};

const mkRecipeSection = async (db: Database) => {
  const r = await mkRecipe(db);
  return insertAndReturn(db, recipeSection, {
    recipeId: r.id,
    instructions: [],
  });
};

/** One live-row factory per entity that appears as a `targetEntity` among the
 * must-target-live edges below. */
const TARGET_FACTORIES = {
  productCategory: (db: Database) =>
    insertWithShortcode(db, "productCategory", { name: uniq("Category") }),
  cookbook: mkCookbook,
  expense: mkExpense,
  image: mkImage,
  recipe: mkRecipe,
  ingredient: mkIngredient,
  meal: mkMeal,
  ledgerParty: mkLedgerParty,
  ledgerTransfer: mkLedgerTransfer,
  product: mkProduct,
  location: mkLocation,
  planting: mkPlanting,
  gardenEntry: mkGardenEntry,
  project: mkProject,
  task: mkTask,
  vendor: mkVendor,
  vendorAccount: mkVendorAccount,
  purchase: mkPurchase,
  financialAccount: mkFinancialAccount,
  financialTransaction: mkFinancialTransaction,
  wish: mkWish,
  importRun: mkImportRun,
  device: mkDevice,
} satisfies Partial<Record<Entity, (db: Database) => Promise<{ id: string }>>>;

/** One factory per must-target-live edge: insert a live SOURCE row whose FK
 * (named by the edge key) points at `targetId`. Every other required column on
 * the source row is filled with an unrelated, always-live fixture. */
const SOURCE_FACTORIES = {
  "ProductCategory.parentId": (db, targetId) =>
    insertWithShortcode(db, "productCategory", {
      name: uniq("Child category"),
      parentId: parseEntityId("productCategory", targetId),
    }),
  "Product.categoryId": (db, targetId) =>
    insertWithShortcode(db, "product", {
      name: uniq("Classified product"),
      manufacturer: "Test Mfr",
      categoryId: parseEntityId("productCategory", targetId),
    }),
  "ImageDerivative.imageId": (db, targetId) =>
    insertAndReturn(db, imageDerivative, {
      imageId: parseEntityId("image", targetId),
      purpose: "transparent",
      status: "pending",
      key: uniq("test/derivative"),
      sourceContentHash: uniq("source-hash"),
      processorRevision: 1,
    }),
  "ImageProcessingJob.imageId": (db, targetId) =>
    insertAndReturn(db, imageProcessingJob, {
      imageId: parseEntityId("image", targetId),
      kind: "subject_lift",
      state: "pending",
      sourceContentHash: uniq("source-hash"),
      processorRevision: 1,
    }),
  "ImageDescriptionCorrection.imageId": (db, targetId) =>
    insertAndReturn(db, imageDescriptionCorrection, {
      imageId: parseEntityId("image", targetId),
      description: "Confirmed liveness fixture description",
    }),
  "ImportPreparedOrder.primaryDocumentImageId": (db, targetId) =>
    mkImportPreparedOrder(db, { primaryDocumentImageId: targetId }),
  "ImportPreparedOrder.screenshotImageId": (db, targetId) =>
    mkImportPreparedOrder(db, { screenshotImageId: targetId }),
  "ImportRunTarget.imageId": (db, targetId) =>
    mkImportRunTarget(db, { imageId: parseEntityId("image", targetId) }),
  "ImportHunt.receiptImageId": (db, targetId) =>
    mkImportHunt(db, { receiptImageId: targetId }),
  "OrderMailAttachment.imageId": async (db, targetId) => {
    const mail = await mkOrderMail(db);
    return insertAndReturn(db, orderMailAttachment, {
      orderMailId: mail.id,
      providerAttachmentId: uniq("attachment"),
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      checksum: uniq("attachment-checksum"),
      imageId: targetId,
    });
  },
  "VendorAccount.ledgerPartyId": async (db, targetId) => {
    const vendor = await mkVendor(db);
    return insertWithShortcode(db, "vendorAccount", {
      label: uniq("Vendor account"),
      vendorId: vendor.id,
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    });
  },
  "ImportRun.ledgerPartyId": (db, targetId) =>
    mkImportRun(db, { ledgerPartyId: parseEntityId("ledgerParty", targetId) }),
  "ImportSourceClaim.ledgerPartyId": (db, targetId) =>
    mkImportSourceClaim(db, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "ImportFinding.ledgerPartyId": (db, targetId) =>
    insertAndReturn(db, importFinding, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
      targetType: "purchase",
      targetId,
      kind: "liveness-fixture",
      summary: "Liveness fixture",
      evidenceFingerprint: uniq("finding"),
    }),
  "ImportHunt.ledgerPartyId": (db, targetId) =>
    mkImportHunt(db, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "MerchantVendorRule.ledgerPartyId": async (db, targetId) => {
    const [vendor, actor] = await Promise.all([mkVendor(db), mkUser(db)]);
    return insertAndReturn(db, merchantVendorRule, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
      normalizedMerchant: uniq("merchant"),
      vendorId: vendor.id,
      confirmedByUserId: actor.id,
    });
  },
  "MailboxCursor.ledgerPartyId": (db, targetId) =>
    insertAndReturn(db, mailboxCursor, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "OrderMail.ledgerPartyId": (db, targetId) =>
    mkOrderMail(db, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "VendorAccount.vendorId": async (db, targetId) => {
    const party = await mkLedgerParty(db);
    return insertWithShortcode(db, "vendorAccount", {
      label: uniq("Vendor account"),
      vendorId: parseEntityId("vendor", targetId),
      ledgerPartyId: party.id,
    });
  },
  "ImportRun.vendorId": (db, targetId) =>
    mkImportRun(db, { vendorId: parseEntityId("vendor", targetId) }),
  "ImportHunt.vendorId": (db, targetId) =>
    mkImportHunt(db, { vendorId: parseEntityId("vendor", targetId) }),
  "MerchantVendorRule.vendorId": async (db, targetId) => {
    const [party, actor] = await Promise.all([mkLedgerParty(db), mkUser(db)]);
    return insertAndReturn(db, merchantVendorRule, {
      ledgerPartyId: party.id,
      normalizedMerchant: uniq("merchant"),
      vendorId: parseEntityId("vendor", targetId),
      confirmedByUserId: actor.id,
    });
  },
  "OrderMail.vendorId": (db, targetId) =>
    mkOrderMail(db, { vendorId: parseEntityId("vendor", targetId) }),
  "ImportSourceClaim.purchaseId": (db, targetId) =>
    mkImportSourceClaim(db, {
      purchaseId: parseEntityId("purchase", targetId),
    }),
  "PurchasePaymentEvidence.purchaseId": async (db, targetId) => {
    const claim = await mkImportSourceClaim(db);
    return insertAndReturn(db, purchasePaymentEvidence, {
      purchaseId: parseEntityId("purchase", targetId),
      sourceClaimId: claim.id,
      amount: 1,
      evidenceIndex: 0,
    });
  },
  "ImportHunt.financialTransactionId": (db, targetId) =>
    mkImportHunt(db, {
      financialTransactionId: parseEntityId("financialTransaction", targetId),
    }),
  "Purchase.vendorAccountId": async (db, targetId) => {
    const vendor = await mkVendor(db);
    return insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: parseEntityId("vendorAccount", targetId),
      date: "2024-01-15",
    });
  },
  "ImportRun.vendorAccountId": (db, targetId) =>
    mkImportRun(db, {
      vendorAccountId: parseEntityId("vendorAccount", targetId),
    }),
  "ImportRunTarget.productId": (db, targetId) =>
    mkImportRunTarget(db, { productId: parseEntityId("product", targetId) }),
  "ImportRunTarget.vendorAccountId": (db, targetId) =>
    mkProduct(db).then((product) =>
      mkImportRunTarget(db, {
        productId: product.id,
        vendorAccountId: parseEntityId("vendorAccount", targetId),
      }),
    ),
  "ImportSourceClaim.vendorAccountId": (db, targetId) =>
    mkImportSourceClaim(db, { vendorAccountId: targetId }),
  "ImportHunt.vendorAccountId": (db, targetId) =>
    mkImportHunt(db, { vendorAccountId: targetId }),
  "ExpenseAttribution.expenseId": async (db, targetId) => {
    const party = await mkLedgerParty(db);
    return insertAndReturn(db, expenseAttribution, {
      expenseId: parseEntityId("expense", targetId),
      role: "funder",
      ledgerPartyId: party.id,
      weight: 1,
    });
  },
  "FinancialTransaction.ledgerTransferId": async (db, targetId) => {
    const account = await mkFinancialAccount(db);
    return insertWithShortcode(db, "financialTransaction", {
      accountId: account.id,
      ledgerTransferId: parseEntityId("ledgerTransfer", targetId),
      kind: "purchase",
      status: "pending",
      amount: 1,
    });
  },
  "LedgerSourceClaim.expenseId": async (db, targetId) =>
    insertAndReturn(db, ledgerSourceClaim, {
      expenseId: parseEntityId("expense", targetId),
      source: "synthetic-integrity",
      sourceKey: uniq("claim"),
      sourceKeyVersion: 1,
      normalizedEvidence: {
        amount: 1,
        occurredOn: null,
        description: null,
        context: null,
        disambiguator: null,
      },
      targetAmountAtClaim: 1,
      reconciliationDecision: "amounts_match",
    }),
  "LedgerSourceClaim.ledgerTransferId": async (db, targetId) =>
    insertAndReturn(db, ledgerSourceClaim, {
      ledgerTransferId: parseEntityId("ledgerTransfer", targetId),
      source: "synthetic-integrity",
      sourceKey: uniq("claim"),
      sourceKeyVersion: 1,
      normalizedEvidence: {
        amount: 1,
        occurredOn: null,
        description: null,
        context: null,
        disambiguator: null,
      },
      targetAmountAtClaim: 1,
      reconciliationDecision: "amounts_match",
    }),
  "ExpenseAttribution.ledgerPartyId": async (db, targetId) => {
    const expense = await insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
    });
    return insertAndReturn(db, expenseAttribution, {
      expenseId: expense.id,
      role: "funder",
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
      weight: 1,
    });
  },
  "FinancialAccount.ledgerPartyId": (db, targetId) =>
    insertWithShortcode(db, "financialAccount", {
      name: uniq("Financial account"),
      identity: { kind: "cash" },
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "InventoryEntry.ownerLedgerPartyId": async (db, targetId) => {
    const [product, location] = await Promise.all([
      mkProduct(db),
      mkLocation(db),
    ]);
    return insertWithShortcode(db, "inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "each" },
      ownershipMode: "person",
      ownerLedgerPartyId: parseEntityId("ledgerParty", targetId),
    });
  },
  "LedgerTransfer.fromPartyId": async (db, targetId) => {
    const to = await mkLedgerParty(db);
    return insertWithShortcode(db, "ledgerTransfer", {
      fromPartyId: parseEntityId("ledgerParty", targetId),
      toPartyId: to.id,
      amount: 1,
      date: "2024-01-15",
    });
  },
  "LedgerTransfer.toPartyId": async (db, targetId) => {
    const from = await mkLedgerParty(db);
    return insertWithShortcode(db, "ledgerTransfer", {
      fromPartyId: from.id,
      toPartyId: parseEntityId("ledgerParty", targetId),
      amount: 1,
      date: "2024-01-15",
    });
  },
  "WishCandidate.wishId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertAndReturn(db, wishCandidate, {
      wishId: parseEntityId("wish", targetId),
      productId: p.id,
    });
  },

  "WishCandidate.productId": async (db, targetId) => {
    const w = await mkWish(db);
    return insertAndReturn(db, wishCandidate, {
      wishId: w.id,
      productId: parseEntityId("product", targetId),
    });
  },

  "Recipe.cookbookId": (db, targetId) =>
    insertWithShortcode(db, "recipe", {
      name: uniq("Recipe"),
      cookbookId: parseEntityId("cookbook", targetId),
    }),

  "Recipe.forkedFromRecipeId": (db, targetId) =>
    insertWithShortcode(db, "recipe", {
      name: uniq("Recipe"),
      forkedFromRecipeId: parseEntityId("recipe", targetId),
    }),

  "Cookbook.coverImageId": (db, targetId) =>
    insertWithShortcode(db, "cookbook", {
      name: uniq("Cookbook"),
      author: [],
      subjects: [],
      sourceLabel: "test",
      rawJson: makeCookbookExtraction(),
      coverImageId: targetId,
    }),

  "Vendor.logoImageId": (db, targetId) =>
    insertWithShortcode(db, "vendor", {
      name: uniq("Vendor"),
      logoImageId: targetId,
    }),

  "ProductImage.imageId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertAndReturn(db, productImage, {
      productId: p.id,
      imageId: targetId,
    });
  },

  "LocationImage.imageId": async (db, targetId) => {
    const l = await mkLocation(db);
    return insertAndReturn(db, locationImage, {
      locationId: l.id,
      imageId: targetId,
    });
  },

  "RecipeImage.imageId": async (db, targetId) => {
    const r = await mkRecipe(db);
    return insertAndReturn(db, recipeImage, {
      recipeId: r.id,
      imageId: targetId,
    });
  },

  "ProjectImage.imageId": async (db, targetId) => {
    const p = await mkProject(db);
    return insertAndReturn(db, projectImage, {
      projectId: p.id,
      imageId: targetId,
    });
  },

  "PurchaseImage.imageId": async (db, targetId) => {
    const p = await mkPurchase(db);
    return insertAndReturn(db, purchaseImage, {
      purchaseId: p.id,
      imageId: targetId,
    });
  },

  "GardenEntryImage.imageId": async (db, targetId) => {
    const entry = await mkGardenEntry(db);
    return insertAndReturn(db, gardenEntryImage, {
      gardenEntryId: entry.id,
      imageId: targetId,
    });
  },

  "MealImage.imageId": async (db, targetId) => {
    const m = await mkMeal(db);
    return insertAndReturn(db, mealImage, {
      mealId: m.id,
      imageId: targetId,
    });
  },

  "TaskImage.imageId": async (db, targetId) => {
    const t = await mkTask(db);
    return insertAndReturn(db, taskImage, {
      taskId: t.id,
      imageId: targetId,
    });
  },

  "RecipeSection.recipeId": (db, targetId) =>
    insertAndReturn(db, recipeSection, {
      recipeId: parseEntityId("recipe", targetId),
      instructions: [],
    }),

  "MealRecipe.recipeId": async (db, targetId) => {
    const m = await mkMeal(db);
    return insertAndReturn(db, mealRecipe, {
      mealId: m.id,
      recipeId: parseEntityId("recipe", targetId),
    });
  },

  "RecipeImage.recipeId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, recipeImage, {
      recipeId: parseEntityId("recipe", targetId),
      imageId: img.id,
    });
  },

  "RecipeSectionIngredient.ingredientId": async (db, targetId) => {
    const section = await mkRecipeSection(db);
    return insertAndReturn(db, recipeSectionIngredient, {
      recipeSectionId: section.id,
      ingredientId: parseEntityId("ingredient", targetId),
      amounts: [],
    });
  },

  "MealFoodEntry.ingredientId": async (db, targetId) => {
    const [meal, party] = await Promise.all([mkMeal(db), mkLedgerParty(db)]);
    return insertAndReturn(db, mealFoodEntry, {
      mealId: meal.id,
      ledgerPartyId: party.id,
      sourceKind: "ingredient",
      ingredientId: parseEntityId("ingredient", targetId),
      amount: { value: 1, unit: "g" },
    });
  },

  "Product.ingredientId": (db, targetId) =>
    insertWithShortcode(db, "product", {
      name: uniq("Product"),
      manufacturer: "Test Mfr",
      ingredientId: parseEntityId("ingredient", targetId),
    }),

  "Product.growsIngredientId": (db, targetId) =>
    insertWithShortcode(db, "product", {
      name: uniq("Garden source"),
      manufacturer: "Test Mfr",
      growsIngredientId: parseEntityId("ingredient", targetId),
    }),

  "Planting.sourceProductId": async (db, targetId) => {
    const crop = await mkIngredient(db);
    return insertWithShortcode(db, "planting", {
      ingredientId: crop.id,
      sourceProductId: parseEntityId("product", targetId),
      status: "planned",
    });
  },

  "Planting.taskId": async (db, targetId) => {
    const crop = await mkIngredient(db);
    return insertWithShortcode(db, "planting", {
      ingredientId: crop.id,
      taskId: parseEntityId("task", targetId),
      status: "planned",
    });
  },

  "Planting.ingredientId": async (db, targetId) => {
    const growingLocation = await mkLocation(db);
    return insertWithShortcode(db, "planting", {
      ingredientId: parseEntityId("ingredient", targetId),
      locationId: growingLocation.id,
      status: "growing",
    });
  },

  "MealRecipe.mealId": async (db, targetId) => {
    const r = await mkRecipe(db);
    return insertAndReturn(db, mealRecipe, {
      mealId: parseEntityId("meal", targetId),
      recipeId: r.id,
    });
  },

  "MealFoodEntry.mealId": async (db, targetId) => {
    const [party, product] = await Promise.all([
      mkLedgerParty(db),
      mkProduct(db),
    ]);
    return insertAndReturn(db, mealFoodEntry, {
      mealId: parseEntityId("meal", targetId),
      ledgerPartyId: party.id,
      sourceKind: "product",
      productId: product.id,
      grams: 1,
    });
  },

  "MealRecipePortion.mealId": async (db, targetId) => {
    const [sourceMeal, recipe, party] = await Promise.all([
      mkMeal(db),
      mkRecipe(db),
      mkLedgerParty(db),
    ]);
    const preparation = await insertAndReturn(db, mealRecipe, {
      mealId: sourceMeal.id,
      recipeId: recipe.id,
    });
    return insertAndReturn(db, mealRecipePortion, {
      mealRecipeId: preparation.id,
      mealId: parseEntityId("meal", targetId),
      ledgerPartyId: party.id,
      grams: 1,
    });
  },

  "MealRecipePortion.ledgerPartyId": async (db, targetId) => {
    const [meal, recipe] = await Promise.all([mkMeal(db), mkRecipe(db)]);
    const preparation = await insertAndReturn(db, mealRecipe, {
      mealId: meal.id,
      recipeId: recipe.id,
    });
    return insertAndReturn(db, mealRecipePortion, {
      mealRecipeId: preparation.id,
      mealId: meal.id,
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
      grams: 1,
    });
  },

  "MealFoodEntry.ledgerPartyId": async (db, targetId) => {
    const [meal, product] = await Promise.all([mkMeal(db), mkProduct(db)]);
    return insertAndReturn(db, mealFoodEntry, {
      mealId: meal.id,
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
      sourceKind: "product",
      productId: product.id,
      grams: 1,
    });
  },

  "ProductExternalId.productId": (db, targetId) =>
    insertAndReturn(db, productExternalId, {
      productId: parseEntityId("product", targetId),
      source: "amazon",
      externalId: uniq("B"),
    }),

  "ProductUnitMappings.productId": (db, targetId) =>
    insertAndReturn(db, productUnitMappings, {
      productId: parseEntityId("product", targetId),
      a: { value: 1, unit: "cup" },
      b: { value: 120, unit: "g" },
    }),

  "InventoryEntry.productId": async (db, targetId) => {
    const l = await mkLocation(db);
    return insertWithShortcode(db, "inventory", {
      productId: parseEntityId("product", targetId),
      locationId: l.id,
      amount: { value: 1, unit: "each" },
    });
  },

  "ProductImage.productId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, productImage, {
      productId: parseEntityId("product", targetId),
      imageId: img.id,
    });
  },

  "Expense.productId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      productId: parseEntityId("product", targetId),
    }),

  "Task.subjectProductId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      subjectProductId: parseEntityId("product", targetId),
    }),

  "ProjectToolUsage.productId": async (db, targetId) => {
    const p = await mkProject(db);
    return insertAndReturn(db, projectToolUsage, {
      projectId: p.id,
      productId: parseEntityId("product", targetId),
    });
  },

  "PurchaseProduct.productId": async (db, targetId) => {
    const p = await mkPurchase(db);
    return insertAndReturn(db, purchaseProduct, {
      purchaseId: p.id,
      productId: parseEntityId("product", targetId),
    });
  },

  "MealFoodEntry.productId": async (db, targetId) => {
    const [meal, party] = await Promise.all([mkMeal(db), mkLedgerParty(db)]);
    return insertAndReturn(db, mealFoodEntry, {
      mealId: meal.id,
      ledgerPartyId: party.id,
      sourceKind: "product",
      productId: parseEntityId("product", targetId),
      grams: 1,
    });
  },

  "InventoryEntry.locationId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertWithShortcode(db, "inventory", {
      productId: p.id,
      locationId: parseEntityId("location", targetId),
      amount: { value: 1, unit: "each" },
    });
  },

  "Planting.locationId": async (db, targetId) => {
    const crop = await mkIngredient(db);
    return insertWithShortcode(db, "planting", {
      ingredientId: crop.id,
      locationId: parseEntityId("location", targetId),
      status: "growing",
    });
  },

  "GardenEntry.locationId": (db, targetId) =>
    insertWithShortcode(db, "gardenEntry", {
      locationId: parseEntityId("location", targetId),
      observedOn: "2026-01-01",
    }),

  "LocationImage.locationId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, locationImage, {
      locationId: parseEntityId("location", targetId),
      imageId: img.id,
    });
  },

  // Unconstrained at the DB level (no `.references()` — see schema.ts), but
  // still audited: see the file-level doc comment on detectors-integrity.ts.
  "Location.parentId": (db, targetId) =>
    insertWithShortcode(db, "location", {
      name: uniq("Location"),
      type: "bin",
      parentId: parseEntityId("location", targetId),
    }),

  "Location.productId": (db, targetId) =>
    insertWithShortcode(db, "location", {
      name: uniq("Location"),
      type: null,
      productId: parseEntityId("product", targetId),
    }),

  "Cookbook.productId": (db, targetId) =>
    insertWithShortcode(db, "cookbook", {
      name: uniq("Cookbook"),
      author: [],
      subjects: [],
      sourceLabel: "test",
      rawJson: makeCookbookExtraction(),
      productId: parseEntityId("product", targetId),
    }),

  "Project.parentProjectId": (db, targetId) =>
    insertWithShortcode(db, "project", {
      name: uniq("Project"),
      parentProjectId: parseEntityId("project", targetId),
    }),

  "ProjectDependency.projectId": async (db, targetId) => {
    const other = await mkProject(db);
    return insertAndReturn(db, projectDependency, {
      projectId: parseEntityId("project", targetId),
      blockedByProjectId: other.id,
    });
  },

  "ProjectDependency.blockedByProjectId": async (db, targetId) => {
    const other = await mkProject(db);
    return insertAndReturn(db, projectDependency, {
      projectId: other.id,
      blockedByProjectId: parseEntityId("project", targetId),
    });
  },

  "Task.projectId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      projectId: parseEntityId("project", targetId),
    }),

  "Expense.projectId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      projectId: parseEntityId("project", targetId),
    }),

  "ProjectImage.projectId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, projectImage, {
      projectId: parseEntityId("project", targetId),
      imageId: img.id,
    });
  },

  "ProjectToolUsage.projectId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertAndReturn(db, projectToolUsage, {
      projectId: parseEntityId("project", targetId),
      productId: p.id,
    });
  },

  "Task.parentTaskId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      parentTaskId: parseEntityId("task", targetId),
    }),

  "GardenEntryPlanting.plantingId": async (db, targetId) => {
    const entry = await mkGardenEntry(db);
    return insertAndReturn(db, gardenEntryPlanting, {
      gardenEntryId: parseEntityId("gardenEntry", entry.id),
      plantingId: parseEntityId("planting", targetId),
    });
  },

  "GardenEntryPlanting.gardenEntryId": async (db, targetId) => {
    const planted = await mkPlanting(db);
    return insertAndReturn(db, gardenEntryPlanting, {
      gardenEntryId: parseEntityId("gardenEntry", targetId),
      plantingId: parseEntityId("planting", planted.id),
    });
  },

  "GardenEntryImage.gardenEntryId": async (db, targetId) => {
    const photo = await mkImage(db);
    return insertAndReturn(db, gardenEntryImage, {
      gardenEntryId: parseEntityId("gardenEntry", targetId),
      imageId: photo.id,
    });
  },

  "MealImage.mealId": async (db, targetId) => {
    const photo = await mkImage(db);
    return insertAndReturn(db, mealImage, {
      mealId: parseEntityId("meal", targetId),
      imageId: photo.id,
    });
  },

  "TaskImage.taskId": async (db, targetId) => {
    const photo = await mkImage(db);
    return insertAndReturn(db, taskImage, {
      taskId: parseEntityId("task", targetId),
      imageId: photo.id,
    });
  },

  "TaskDependency.taskId": async (db, targetId) => {
    const other = await mkTask(db);
    return insertAndReturn(db, taskDependency, {
      taskId: parseEntityId("task", targetId),
      blockedByTaskId: other.id,
    });
  },

  "TaskDependency.blockedByTaskId": async (db, targetId) => {
    const other = await mkTask(db);
    return insertAndReturn(db, taskDependency, {
      taskId: other.id,
      blockedByTaskId: parseEntityId("task", targetId),
    });
  },

  "Purchase.vendorId": (db, targetId) =>
    insertWithShortcode(db, "purchase", {
      vendorId: parseEntityId("vendor", targetId),
      date: "2024-01-15",
    }),

  "Purchase.defaultProjectId": async (db, targetId) => {
    const vendor = await mkVendor(db);
    return insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      defaultProjectId: parseEntityId("project", targetId),
      date: "2024-01-15",
    });
  },

  "Expense.purchaseId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      purchaseId: parseEntityId("purchase", targetId),
    }),

  "PurchaseImage.purchaseId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, purchaseImage, {
      purchaseId: parseEntityId("purchase", targetId),
      imageId: img.id,
    });
  },

  "PurchaseProduct.purchaseId": async (db, targetId) => {
    const prod = await mkProduct(db);
    return insertAndReturn(db, purchaseProduct, {
      purchaseId: parseEntityId("purchase", targetId),
      productId: prod.id,
    });
  },

  "FinancialTransaction.accountId": (db, targetId) =>
    insertWithShortcode(db, "financialTransaction", {
      accountId: parseEntityId("financialAccount", targetId),
      kind: "purchase",
      status: "pending",
      amount: 1,
    }),

  "StatementRow.accountId": async (db, targetId) => {
    const batch = await insertAndReturn(db, statementImport, {
      source: "monarch",
      label: "liveness-fixture.csv",
      fingerprint: `fp-${targetId}`,
    });
    return insertAndReturn(db, statementRow, {
      batchId: batch.id,
      source: "monarch",
      externalId: `v1:${targetId.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      accountDescriptor: "Liveness Fixture Card",
      statementDate: "2026-01-01",
      amount: 1,
      providerAmount: -1,
      rawDescription: "LIVENESS FIXTURE",
      accountId: parseEntityId("financialAccount", targetId),
    });
  },

  "FinancialTransactionAllocation.purchaseId": async (db, targetId) => {
    const account = await mkFinancialAccount(db);
    const txn = await insertWithShortcode(db, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "pending",
      amount: 1,
    });
    return insertAndReturn(db, financialTransactionAllocation, {
      transactionId: txn.id,
      purchaseId: parseEntityId("purchase", targetId),
      amount: 1,
    });
  },

  "FinancialTransactionAllocation.transactionId": async (db, targetId) => {
    const purch = await mkPurchase(db);
    return insertAndReturn(db, financialTransactionAllocation, {
      transactionId: parseEntityId("financialTransaction", targetId),
      purchaseId: purch.id,
      amount: 1,
    });
  },

  "ProductComponent.parentProductId": async (db, targetId) => {
    const component = await mkProduct(db);
    return insertAndReturn(db, productComponent, {
      parentProductId: parseEntityId("product", targetId),
      componentProductId: component.id,
    });
  },

  "ProductComponent.componentProductId": async (db, targetId) => {
    const kit = await mkProduct(db);
    return insertAndReturn(db, productComponent, {
      parentProductId: kit.id,
      componentProductId: parseEntityId("product", targetId),
    });
  },

  "ProductConversionCoverage.productId": async (db, targetId) => {
    await getDb(db)
      .insert(productConversionCoverage)
      .values({
        productId: parseEntityId("product", targetId),
        coverageTier: "complete",
        status: "ready",
        engineVersion: "liveness-fixture",
        computedAt: new Date(),
      });
    return { id: targetId };
  },

  "Purchase.importRunId": async (db, targetId) => {
    const vendor = await mkVendor(db);
    return insertWithShortcode(db, "purchase", {
      vendorId: vendor.id,
      importRunId: parseEntityId("importRun", targetId),
      date: "2024-01-15",
    });
  },
  "ImportRun.predecessorRunId": (db, targetId) =>
    mkImportRun(db, {
      predecessorRunId: parseEntityId("importRun", targetId),
    }),
  "ImportRunTarget.runId": async (db, targetId) => {
    const product = await mkProduct(db);
    return mkImportRunTarget(db, {
      runId: parseEntityId("importRun", targetId),
      productId: product.id,
    });
  },
  "ImportRunOrderCandidate.runId": (db, targetId) =>
    insertAndReturn(db, importRunOrderCandidate, {
      runId: parseEntityId("importRun", targetId),
      orderId: uniq("order"),
    }),
  "ImportRunEvidence.runId": async (db, targetId) => {
    const product = await mkProduct(db);
    const evidenceTarget = await mkImportRunTarget(db, {
      productId: product.id,
    });
    return insertAndReturn(db, importRunEvidence, {
      runId: parseEntityId("importRun", targetId),
      targetId: evidenceTarget.id,
      kind: "manual_upload",
      objectKey: uniq("test/evidence-object"),
      checksum: uniq("evidence-checksum"),
      mediaType: "application/pdf",
    });
  },
  "ImportRunMutation.runId": (db, targetId) =>
    insertAndReturn(db, importRunMutation, {
      runId: parseEntityId("importRun", targetId),
      targetType: "purchase",
      targetId: crypto.randomUUID(),
      mutationKind: "liveness-fixture",
      postFingerprint: uniq("post-fingerprint"),
    }),
  "ImportRunOperation.runId": (db, targetId) =>
    insertAndReturn(db, importRunOperation, {
      runId: parseEntityId("importRun", targetId),
      operationId: uniq("operation"),
      kind: "liveness-fixture",
      inputFingerprint: uniq("input-fingerprint"),
    }),
  "ImportRunProgress.runId": (db, targetId) =>
    insertAndReturn(db, importRunProgress, {
      runId: parseEntityId("importRun", targetId),
      eventId: uniq("progress-event"),
      phase: "liveness-fixture",
    }),
  "ImportRunControlEvent.runId": (db, targetId) =>
    insertAndReturn(db, importRunControlEvent, {
      runId: parseEntityId("importRun", targetId),
      action: "prompt",
      controllerUserId: userId.parse(uniq("controller-user")),
      controllerName: "Liveness fixture controller",
      controllerEmail: `${uniq("controller")}@example.test`,
      controllerLedgerPartyId: parseEntityId(
        "ledgerParty",
        crypto.randomUUID(),
      ),
      controllerLedgerPartyShortcode: uniq("LPY-fixture"),
      controllerLedgerPartyName: "Liveness fixture party",
      controllerLedgerPartyKind: "member",
    }),
  "ImportPreparedOrder.runId": (db, targetId) =>
    mkImportPreparedOrder(db, {
      runId: parseEntityId("importRun", targetId),
    }),
  "ImportRunApproval.runId": (db, targetId) =>
    insertAndReturn(db, importRunApproval, {
      runId: parseEntityId("importRun", targetId),
      operationId: uniq("approval-operation"),
      operationKind: "liveness-fixture",
      args: {},
      argsFingerprint: uniq("args-fingerprint"),
      targetFingerprint: uniq("target-fingerprint"),
      evidenceFingerprint: uniq("evidence-fingerprint"),
    }),
  "ImportSourceClaim.firstRunId": (db, targetId) =>
    mkImportSourceClaim(db, {
      firstRunId: parseEntityId("importRun", targetId),
    }),
  "ImportSourceClaim.lastRunId": (db, targetId) =>
    mkImportSourceClaim(db, {
      lastRunId: parseEntityId("importRun", targetId),
    }),
  "ImportFinding.importRunId": async (db, targetId) => {
    const party = await mkLedgerParty(db);
    return insertAndReturn(db, importFinding, {
      importRunId: parseEntityId("importRun", targetId),
      ledgerPartyId: party.id,
      targetType: "purchase",
      targetId: crypto.randomUUID(),
      kind: "liveness-fixture",
      summary: "Liveness fixture",
      evidenceFingerprint: uniq("finding"),
    });
  },
  "ImportHunt.receiptRunId": (db, targetId) =>
    mkImportHunt(db, {
      receiptRunId: parseEntityId("importRun", targetId),
    }),
  "Device.ledgerPartyId": (db, targetId) =>
    insertWithShortcode(db, "device", {
      installationId: uniq("installation"),
      name: uniq("Device"),
      platform: "ios",
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "Device.productId": (db, targetId) =>
    insertWithShortcode(db, "device", {
      installationId: uniq("installation"),
      name: uniq("Device"),
      platform: "ios",
      productId: parseEntityId("product", targetId),
    }),
  "ImageSighting.imageId": (db, targetId) =>
    mkImageSighting(db, { imageId: parseEntityId("image", targetId) }),
  "ImageSighting.ledgerPartyId": (db, targetId) =>
    mkImageSighting(db, {
      ledgerPartyId: parseEntityId("ledgerParty", targetId),
    }),
  "ImageSighting.deviceId": (db, targetId) =>
    mkImageSighting(db, { deviceId: parseEntityId("device", targetId) }),
  "Image.capturedByPartyId": (db, targetId) =>
    insertWithShortcode(db, "image", {
      key: uniq("test/img"),
      filename: "img.png",
      size: 1,
      contentType: "image/png",
      capturedByPartyId: parseEntityId("ledgerParty", targetId),
    }),
} satisfies Record<
  string,
  (db: Database, targetId: string) => Promise<{ id: string }>
>;

type TargetFactory = (db: Database) => Promise<{ id: string }>;
type SourceFactory = (
  db: Database,
  targetId: string,
) => Promise<{ id: string }>;

function targetFactoryFor(entity: Entity): TargetFactory {
  const factory = Object.entries(TARGET_FACTORIES).find(
    ([key]) => key === entity,
  )?.[1];
  if (!factory) throw new Error(`No target factory for ${entity}`);
  return factory;
}

function sourceFactoryFor(edgeKey: string): SourceFactory {
  const factory = Object.entries(SOURCE_FACTORIES).find(
    ([key]) => key === edgeKey,
  )?.[1];
  if (!factory) throw new Error(`No source factory for ${edgeKey}`);
  return factory;
}

// Derive the must-target-live edge list from INCOMING_EDGES × ENTITY_EDGE_SEMANTICS
// directly (not a hand-copied list), so a newly added/removed/reclassified edge
// changes what this suite tests without anyone touching this file.

interface DerivedEdgeSpec {
  edgeKey: string;
  targetEntity: Entity;
  role: EdgeRole;
  sourceTableName: string;
  /** False for source tables with no `deletedAt` column. The "soft-deleted
   * source" matrix case doesn't apply to them, so it is skipped rather than
   * attempting an update against a column that does not exist. */
  sourceSoftDeletable: boolean;
}

interface ExpectedViolation {
  edgeKey: string;
  role: EdgeRole;
  targetEntity: Entity;
  targetId: string;
  sourceTable: string;
  sourceId: string;
}

function entityTableName(entity: Entity): string {
  const tableName = entityManifest[entity].dbTable;
  if (!tableName) throw new Error(`Entity ${entity} has no database table`);
  return tableName;
}

const HARD_DELETE_ONLY_SOURCE_TABLES = new Set([
  "ImportFinding",
  "ImportHunt",
  "ImportPreparedOrder",
  "ImportRun",
  "ImportRunApproval",
  "ImportRunControlEvent",
  "ImportRunEvidence",
  "ImportRunMutation",
  "ImportRunOperation",
  "ImportRunOrderCandidate",
  "ImportRunProgress",
  "ImportRunTarget",
  "ImportSourceClaim",
  "ImageProcessingJob",
  "MailboxCursor",
  "MerchantVendorRule",
  "OrderMail",
  "OrderMailAttachment",
  "ProjectDependency",
  "ProductConversionCoverage",
  "PurchasePaymentEvidence",
  "TaskDependency",
]);

function deriveMustTargetLiveEdges(): DerivedEdgeSpec[] {
  const specs: DerivedEdgeSpec[] = [];
  for (const [rawTargetEntity, edgeMap] of Object.entries(INCOMING_EDGES)) {
    const targetEntity = entitySchema.parse(rawTargetEntity);
    for (const edgeKey of Object.keys(edgeMap)) {
      const semantics = Object.entries(
        ENTITY_EDGE_SEMANTICS[targetEntity],
      ).find(([key]) => key === edgeKey)?.[1];
      if (!semantics) {
        throw new Error(
          `No ENTITY_EDGE_SEMANTICS entry for "${edgeKey}" (target "${targetEntity}").`,
        );
      }
      if (semantics.liveness.kind !== "must-target-live") continue; // Ingredient.recipeId
      const [sourceTableName] = edgeKey.split(".");
      if (!sourceTableName) {
        throw new Error(`Incoming edge is missing a source table: ${edgeKey}`);
      }
      specs.push({
        edgeKey,
        targetEntity,
        role: semantics.role,
        sourceTableName,
        sourceSoftDeletable:
          !HARD_DELETE_ONLY_SOURCE_TABLES.has(sourceTableName),
      });
    }
  }
  return specs;
}

const derivedMustTargetLiveEdges = deriveMustTargetLiveEdges();

describe("findReferentialLivenessViolations", () => {
  const ctx = withTestDb();

  it("derives 134 must-target-live edges from INCOMING_EDGES × ENTITY_EDGE_SEMANTICS", () => {
    // Mirrors EXPECTED_EDGE_COUNT in detectors-integrity.ts — an independent
    // spot check computed from the same two source-of-truth maps, not from the
    // detector's own (unexported) derivation.
    expect(derivedMustTargetLiveEdges).toHaveLength(134);
  });

  it("the hand-written fixture map covers exactly the derived edges (a new edge fails here, not silently)", () => {
    expect(Object.keys(SOURCE_FACTORIES).sort()).toEqual(
      derivedMustTargetLiveEdges.map((s) => s.edgeKey).sort(),
    );
    for (const spec of derivedMustTargetLiveEdges) {
      expect(
        Object.keys(TARGET_FACTORIES).includes(spec.targetEntity),
        `no TARGET_FACTORIES entry for "${spec.targetEntity}" (edge "${spec.edgeKey}")`,
      ).toBe(true);
    }
  });

  it("reports every derived edge when a live source points at a soft-deleted target", async () => {
    // Authoritative owner for the old per-edge "reports exactly one" cases:
    // make one violation for every derived edge, then prove the detector returns
    // that complete edge/source/target map in one scan. This retains complete
    // edge coverage without paying for one database reset per edge.
    const expected: ExpectedViolation[] = [];

    for (const spec of derivedMustTargetLiveEdges) {
      const target = await targetFactoryFor(spec.targetEntity)(ctx.db);
      const source = await sourceFactoryFor(spec.edgeKey)(ctx.db, target.id);
      await softDelete(ctx.db, entityTableName(spec.targetEntity), target.id);
      expected.push({
        edgeKey: spec.edgeKey,
        role: spec.role,
        targetEntity: spec.targetEntity,
        targetId: target.id,
        sourceTable: spec.sourceTableName,
        sourceId: source.id,
      });
    }

    const violations = await findReferentialLivenessViolations(ctx.db);
    expect(violations).toHaveLength(expected.length);
    for (const violation of violations) {
      expect(violation.description).toContain(violation.sourceTable);
    }
    expect(
      violations.map(({ description: _description, ...identity }) => identity),
    ).toEqual(expect.arrayContaining(expected));
  });

  it("ignores every soft-deleted source even when its target is soft-deleted", async () => {
    // Authoritative owner for the old per-edge soft-source cases. Hard-delete
    // source tables remain deliberately absent: the structural guard above
    // proves this matrix is exactly the set where a deletedAt guard exists.
    for (const spec of derivedMustTargetLiveEdges.filter(
      (edge) => edge.sourceSoftDeletable,
    )) {
      const target = await targetFactoryFor(spec.targetEntity)(ctx.db);
      const source = await sourceFactoryFor(spec.edgeKey)(ctx.db, target.id);
      await softDelete(ctx.db, entityTableName(spec.targetEntity), target.id);
      await softDelete(ctx.db, spec.sourceTableName, source.id);
    }

    expect(await findReferentialLivenessViolations(ctx.db)).toEqual([]);
  });

  // The one deliberate exemption — see ENTITY_EDGE_SEMANTICS.recipe["Ingredient.recipeId"]
  // and the detectors-integrity.ts file-level doc comment. This is the single
  // most important assertion in this file: it's what stops the detector from
  // flagging intended sub-recipe behavior (a parent recipe's ingredient line
  // still naming a deleted sub-recipe, so staleness/recompute can resolve the
  // tombstone) as a referential-integrity bug.
});

describe("findDependencyCycles", () => {
  const ctx = withTestDb();

  it("reports out-of-band Project and Task cycles by public shortcode", async () => {
    const projectA = await mkProject(ctx.db);
    const projectB = await mkProject(ctx.db);
    await insertAndReturn(ctx.db, projectDependency, {
      projectId: projectA.id,
      blockedByProjectId: projectB.id,
    });
    await insertAndReturn(ctx.db, projectDependency, {
      projectId: projectB.id,
      blockedByProjectId: projectA.id,
    });

    const taskA = await mkTask(ctx.db);
    const taskB = await mkTask(ctx.db);
    const taskC = await mkTask(ctx.db);
    await insertAndReturn(ctx.db, taskDependency, {
      taskId: taskA.id,
      blockedByTaskId: taskB.id,
    });
    await insertAndReturn(ctx.db, taskDependency, {
      taskId: taskB.id,
      blockedByTaskId: taskC.id,
    });
    await insertAndReturn(ctx.db, taskDependency, {
      taskId: taskC.id,
      blockedByTaskId: taskA.id,
    });

    const cycles = await findDependencyCycles(ctx.db);
    expect(cycles).toHaveLength(2);
    expect(await countDependencyCycles(ctx.db)).toBe(2);
    const projectCycle = cycles.find((cycle) => cycle.entity === "project");
    const taskCycle = cycles.find((cycle) => cycle.entity === "task");
    expect(projectCycle?.path[0]).toBe(projectCycle?.path.at(-1));
    expect(new Set(projectCycle?.path)).toEqual(
      new Set([projectA.shortcode, projectB.shortcode]),
    );
    expect(taskCycle?.path[0]).toBe(taskCycle?.path.at(-1));
    expect(new Set(taskCycle?.path)).toEqual(
      new Set([taskA.shortcode, taskB.shortcode, taskC.shortcode]),
    );
  });
});
