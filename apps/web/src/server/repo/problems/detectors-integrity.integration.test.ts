import type { Entity } from "@cubby/schemas/entity";
import type { EdgeRole, EdgeSemantics } from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import {
  unsafeCookbookId,
  unsafeFinancialAccountId,
  unsafeFinancialTransactionId,
  unsafeIngredientId,
  unsafeLedgerPartyId,
  unsafeLocationId,
  unsafeMealId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeRecipeId,
  unsafeTaskId,
  unsafeVendorId,
  unsafeWishId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import {
  expenseAttribution,
  financialTransactionAllocation,
  ledgerSourceClaim,
  locationImage,
  mealRecipe,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productImage,
  productUnitMappings,
  projectDependency,
  projectImage,
  projectToolUsage,
  purchaseImage,
  purchaseProduct,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
  statementImport,
  statementRow,
  taskDependency,
  wishCandidate,
} from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findReferentialLivenessViolations } from "./detectors-integrity";

/**
 * Regression suite for `findReferentialLivenessViolations` (detectors-integrity.ts)
 * — the audit that finds every LIVE row whose FK points at a SOFT-DELETED target,
 * across the 58 `must-target-live` incoming edges in `ENTITY_EDGE_SEMANTICS`.
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
    url: `https://example.com/${uniq("img")}.png`,
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
    rawJson: [],
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

const mkRecipeSection = async (db: Database) => {
  const r = await mkRecipe(db);
  return insertAndReturn(db, recipeSection, {
    recipeId: r.id,
    instructions: [],
  });
};

/** One live-row factory per entity that appears as a `targetEntity` among the
 * must-target-live edges below. */
const TARGET_FACTORIES: Partial<
  Record<Entity, (db: Database) => Promise<{ id: string }>>
> = {
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
  project: mkProject,
  task: mkTask,
  vendor: mkVendor,
  purchase: mkPurchase,
  financialAccount: mkFinancialAccount,
  financialTransaction: mkFinancialTransaction,
  wish: mkWish,
};

/** One factory per must-target-live edge: insert a live SOURCE row whose FK
 * (named by the edge key) points at `targetId`. Every other required column on
 * the source row is filled with an unrelated, always-live fixture. */
const SOURCE_FACTORIES: Record<
  string,
  (db: Database, targetId: string) => Promise<{ id: string }>
> = {
  "ExpenseAttribution.expenseId": async (db, targetId) => {
    const party = await mkLedgerParty(db);
    return insertAndReturn(db, expenseAttribution, {
      expenseId: targetId as never,
      role: "funder",
      ledgerPartyId: party.id,
      weight: 1,
    });
  },
  "FinancialTransaction.ledgerTransferId": async (db, targetId) => {
    const account = await mkFinancialAccount(db);
    return insertWithShortcode(db, "financialTransaction", {
      accountId: account.id,
      ledgerTransferId: targetId as never,
      kind: "purchase",
      status: "pending",
      amount: 1,
    });
  },
  "LedgerSourceClaim.expenseId": async (db, targetId) =>
    insertAndReturn(db, ledgerSourceClaim, {
      expenseId: targetId as never,
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
      ledgerTransferId: targetId as never,
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
      ledgerPartyId: unsafeLedgerPartyId(targetId),
      weight: 1,
    });
  },
  "FinancialAccount.ledgerPartyId": (db, targetId) =>
    insertWithShortcode(db, "financialAccount", {
      name: uniq("Financial account"),
      identity: { kind: "cash" },
      ledgerPartyId: unsafeLedgerPartyId(targetId),
    }),
  "LedgerTransfer.fromPartyId": async (db, targetId) => {
    const to = await mkLedgerParty(db);
    return insertWithShortcode(db, "ledgerTransfer", {
      fromPartyId: unsafeLedgerPartyId(targetId),
      toPartyId: to.id,
      amount: 1,
      date: "2024-01-15",
    });
  },
  "LedgerTransfer.toPartyId": async (db, targetId) => {
    const from = await mkLedgerParty(db);
    return insertWithShortcode(db, "ledgerTransfer", {
      fromPartyId: from.id,
      toPartyId: unsafeLedgerPartyId(targetId),
      amount: 1,
      date: "2024-01-15",
    });
  },
  "WishCandidate.wishId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertAndReturn(db, wishCandidate, {
      wishId: unsafeWishId(targetId),
      productId: p.id,
    });
  },

  "WishCandidate.productId": async (db, targetId) => {
    const w = await mkWish(db);
    return insertAndReturn(db, wishCandidate, {
      wishId: w.id,
      productId: unsafeProductId(targetId),
    });
  },

  "Recipe.cookbookId": (db, targetId) =>
    insertWithShortcode(db, "recipe", {
      name: uniq("Recipe"),
      cookbookId: unsafeCookbookId(targetId),
    }),

  "Cookbook.coverImageId": (db, targetId) =>
    insertWithShortcode(db, "cookbook", {
      name: uniq("Cookbook"),
      author: [],
      subjects: [],
      sourceLabel: "test",
      rawJson: [],
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

  "RecipeSection.recipeId": (db, targetId) =>
    insertAndReturn(db, recipeSection, {
      recipeId: unsafeRecipeId(targetId),
      instructions: [],
    }),

  "MealRecipe.recipeId": async (db, targetId) => {
    const m = await mkMeal(db);
    return insertAndReturn(db, mealRecipe, {
      mealId: m.id,
      recipeId: unsafeRecipeId(targetId),
    });
  },

  "RecipeImage.recipeId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, recipeImage, {
      recipeId: unsafeRecipeId(targetId),
      imageId: img.id,
    });
  },

  "RecipeSectionIngredient.ingredientId": async (db, targetId) => {
    const section = await mkRecipeSection(db);
    return insertAndReturn(db, recipeSectionIngredient, {
      recipeSectionId: section.id,
      ingredientId: unsafeIngredientId(targetId),
      amounts: [],
    });
  },

  "Product.ingredientId": (db, targetId) =>
    insertWithShortcode(db, "product", {
      name: uniq("Product"),
      manufacturer: "Test Mfr",
      ingredientId: unsafeIngredientId(targetId),
    }),

  "MealRecipe.mealId": async (db, targetId) => {
    const r = await mkRecipe(db);
    return insertAndReturn(db, mealRecipe, {
      mealId: unsafeMealId(targetId),
      recipeId: r.id,
    });
  },

  "ProductExternalId.productId": (db, targetId) =>
    insertAndReturn(db, productExternalId, {
      productId: unsafeProductId(targetId),
      source: "amazon",
      externalId: uniq("B"),
    }),

  "ProductUnitMappings.productId": (db, targetId) =>
    insertAndReturn(db, productUnitMappings, {
      productId: unsafeProductId(targetId),
      a: { value: 1, unit: "cup" },
      b: { value: 120, unit: "g" },
    }),

  "InventoryEntry.productId": async (db, targetId) => {
    const l = await mkLocation(db);
    return insertWithShortcode(db, "inventory", {
      productId: unsafeProductId(targetId),
      locationId: l.id,
      amount: { value: 1, unit: "each" },
    });
  },

  "ProductImage.productId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, productImage, {
      productId: unsafeProductId(targetId),
      imageId: img.id,
    });
  },

  "Expense.productId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      productId: unsafeProductId(targetId),
    }),

  "Task.subjectProductId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      subjectProductId: unsafeProductId(targetId),
    }),

  "ProjectToolUsage.productId": async (db, targetId) => {
    const p = await mkProject(db);
    return insertAndReturn(db, projectToolUsage, {
      projectId: p.id,
      productId: unsafeProductId(targetId),
    });
  },

  "PurchaseProduct.productId": async (db, targetId) => {
    const p = await mkPurchase(db);
    return insertAndReturn(db, purchaseProduct, {
      purchaseId: p.id,
      productId: unsafeProductId(targetId),
    });
  },

  "InventoryEntry.locationId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertWithShortcode(db, "inventory", {
      productId: p.id,
      locationId: unsafeLocationId(targetId),
      amount: { value: 1, unit: "each" },
    });
  },

  "LocationImage.locationId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, locationImage, {
      locationId: unsafeLocationId(targetId),
      imageId: img.id,
    });
  },

  // Unconstrained at the DB level (no `.references()` — see schema.ts), but
  // still audited: see the file-level doc comment on detectors-integrity.ts.
  "Location.parentId": (db, targetId) =>
    insertWithShortcode(db, "location", {
      name: uniq("Location"),
      type: "bin",
      parentId: unsafeLocationId(targetId),
    }),

  // A location that IS a product carries no `type` — the SKU is its form
  // factor — so this fixture deliberately leaves the column null.
  "Location.productId": (db, targetId) =>
    insertWithShortcode(db, "location", {
      name: uniq("Location"),
      type: null,
      productId: unsafeProductId(targetId),
    }),

  "Cookbook.productId": (db, targetId) =>
    insertWithShortcode(db, "cookbook", {
      name: uniq("Cookbook"),
      author: [],
      subjects: [],
      sourceLabel: "test",
      rawJson: [],
      productId: unsafeProductId(targetId),
    }),

  "Project.parentProjectId": (db, targetId) =>
    insertWithShortcode(db, "project", {
      name: uniq("Project"),
      parentProjectId: unsafeProjectId(targetId),
    }),

  "ProjectDependency.projectId": async (db, targetId) => {
    const other = await mkProject(db);
    return insertAndReturn(db, projectDependency, {
      projectId: unsafeProjectId(targetId),
      blockedByProjectId: other.id,
    });
  },

  "ProjectDependency.blockedByProjectId": async (db, targetId) => {
    const other = await mkProject(db);
    return insertAndReturn(db, projectDependency, {
      projectId: other.id,
      blockedByProjectId: unsafeProjectId(targetId),
    });
  },

  "Task.projectId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      projectId: unsafeProjectId(targetId),
    }),

  "Expense.projectId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      projectId: unsafeProjectId(targetId),
    }),

  "ProjectImage.projectId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, projectImage, {
      projectId: unsafeProjectId(targetId),
      imageId: img.id,
    });
  },

  "ProjectToolUsage.projectId": async (db, targetId) => {
    const p = await mkProduct(db);
    return insertAndReturn(db, projectToolUsage, {
      projectId: unsafeProjectId(targetId),
      productId: p.id,
    });
  },

  "Task.parentTaskId": (db, targetId) =>
    insertWithShortcode(db, "task", {
      name: uniq("Task"),
      trade: "other",
      parentTaskId: unsafeTaskId(targetId),
    }),

  "TaskDependency.taskId": async (db, targetId) => {
    const other = await mkTask(db);
    return insertAndReturn(db, taskDependency, {
      taskId: unsafeTaskId(targetId),
      blockedByTaskId: other.id,
    });
  },

  "TaskDependency.blockedByTaskId": async (db, targetId) => {
    const other = await mkTask(db);
    return insertAndReturn(db, taskDependency, {
      taskId: other.id,
      blockedByTaskId: unsafeTaskId(targetId),
    });
  },

  "Purchase.vendorId": (db, targetId) =>
    insertWithShortcode(db, "purchase", {
      vendorId: unsafeVendorId(targetId),
      date: "2024-01-15",
    }),

  "Expense.purchaseId": (db, targetId) =>
    insertWithShortcode(db, "expense", {
      name: uniq("Expense"),
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      purchaseId: unsafePurchaseId(targetId),
    }),

  "PurchaseImage.purchaseId": async (db, targetId) => {
    const img = await mkImage(db);
    return insertAndReturn(db, purchaseImage, {
      purchaseId: unsafePurchaseId(targetId),
      imageId: img.id,
    });
  },

  "PurchaseProduct.purchaseId": async (db, targetId) => {
    const prod = await mkProduct(db);
    return insertAndReturn(db, purchaseProduct, {
      purchaseId: unsafePurchaseId(targetId),
      productId: prod.id,
    });
  },

  "FinancialTransaction.accountId": (db, targetId) =>
    insertWithShortcode(db, "financialTransaction", {
      accountId: unsafeFinancialAccountId(targetId),
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
      accountId: unsafeFinancialAccountId(targetId),
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
      purchaseId: unsafePurchaseId(targetId),
      amount: 1,
    });
  },

  "FinancialTransactionAllocation.transactionId": async (db, targetId) => {
    const purch = await mkPurchase(db);
    return insertAndReturn(db, financialTransactionAllocation, {
      transactionId: unsafeFinancialTransactionId(targetId),
      purchaseId: purch.id,
      amount: 1,
    });
  },

  "ProductComponent.parentProductId": async (db, targetId) => {
    const component = await mkProduct(db);
    return insertAndReturn(db, productComponent, {
      parentProductId: unsafeProductId(targetId),
      componentProductId: component.id,
    });
  },

  "ProductComponent.componentProductId": async (db, targetId) => {
    const kit = await mkProduct(db);
    return insertAndReturn(db, productComponent, {
      parentProductId: kit.id,
      componentProductId: unsafeProductId(targetId),
    });
  },

  "ProductConversionCoverage.productId": async (db, targetId) => {
    await getDb(db)
      .insert(productConversionCoverage)
      .values({
        productId: unsafeProductId(targetId),
        coverageTier: "complete",
        status: "ready",
        engineVersion: "liveness-fixture",
        computedAt: new Date(),
      });
    return { id: targetId };
  },
};

// Derive the must-target-live edge list from INCOMING_EDGES × ENTITY_EDGE_SEMANTICS
// directly (not a hand-copied list), so a newly added/removed/reclassified edge
// changes what this suite tests without anyone touching this file.

interface DerivedEdgeSpec {
  edgeKey: string;
  targetEntity: Entity;
  role: EdgeRole;
  sourceTableName: string;
  /** False only for the two source tables with no `deletedAt` column at all
   * (ProjectDependency, TaskDependency — see schema.ts: both omit
   * `...softDeletedAt()`). The "soft-deleted source" matrix case doesn't apply
   * to them, so it's skipped for those edges rather than attempted and failing
   * to compile a `deletedAt` update against a column that doesn't exist. */
  sourceSoftDeletable: boolean;
}

const HARD_DELETE_ONLY_SOURCE_TABLES = new Set([
  "ProjectDependency",
  "ProductConversionCoverage",
  "TaskDependency",
]);

function deriveMustTargetLiveEdges(): DerivedEdgeSpec[] {
  const specs: DerivedEdgeSpec[] = [];
  for (const [targetEntity, edgeMap] of Object.entries(INCOMING_EDGES) as [
    Entity,
    Record<string, unknown>,
  ][]) {
    const semanticsMap = ENTITY_EDGE_SEMANTICS[targetEntity] as Record<
      string,
      EdgeSemantics
    >;
    for (const edgeKey of Object.keys(edgeMap)) {
      const semantics = semanticsMap[edgeKey];
      if (!semantics) {
        throw new Error(
          `No ENTITY_EDGE_SEMANTICS entry for "${edgeKey}" (target "${targetEntity}").`,
        );
      }
      if (semantics.liveness.kind !== "must-target-live") continue; // Ingredient.recipeId
      const sourceTableName = edgeKey.split(".")[0]!;
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

  it("derives 58 must-target-live edges from INCOMING_EDGES × ENTITY_EDGE_SEMANTICS", () => {
    // Mirrors EXPECTED_EDGE_COUNT in detectors-integrity.ts — an independent
    // spot check computed from the same two source-of-truth maps, not from the
    // detector's own (unexported) derivation.
    expect(derivedMustTargetLiveEdges).toHaveLength(58);
  });

  it("the hand-written fixture map covers exactly the derived edges (a new edge fails here, not silently)", () => {
    expect(Object.keys(SOURCE_FACTORIES).sort()).toEqual(
      derivedMustTargetLiveEdges.map((s) => s.edgeKey).sort(),
    );
    for (const spec of derivedMustTargetLiveEdges) {
      expect(
        TARGET_FACTORIES[spec.targetEntity],
        `no TARGET_FACTORIES entry for "${spec.targetEntity}" (edge "${spec.edgeKey}")`,
      ).toBeDefined();
    }
  });

  it("tracks the exact hard-delete-only source tables", () => {
    const skipped = new Set(
      derivedMustTargetLiveEdges
        .filter((s) => !s.sourceSoftDeletable)
        .map((s) => s.sourceTableName),
    );
    expect(skipped).toEqual(HARD_DELETE_ONLY_SOURCE_TABLES);
  });

  it("audits Location.parentId even though it is unconstrained at the DB level", () => {
    expect(derivedMustTargetLiveEdges.map((s) => s.edgeKey)).toContain(
      "Location.parentId",
    );
  });

  it("reports every derived edge when a live source points at a soft-deleted target", async () => {
    // Authoritative owner for the old per-edge "reports exactly one" cases:
    // make one violation for every derived edge, then prove the detector returns
    // that complete edge/source/target map in one scan. This retains the exact
    // 50-edge regression guard without paying for 50 database resets and audits.
    const expected = [] as Array<{
      edgeKey: string;
      role: EdgeRole;
      targetEntity: Entity;
      targetId: string;
      sourceTable: string;
      sourceId: string;
    }>;

    for (const spec of derivedMustTargetLiveEdges) {
      const target = await TARGET_FACTORIES[spec.targetEntity]!(ctx.db);
      const source = await SOURCE_FACTORIES[spec.edgeKey]!(ctx.db, target.id);
      await softDelete(
        ctx.db,
        entityManifest[spec.targetEntity].dbTable!,
        target.id,
      );
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
      const target = await TARGET_FACTORIES[spec.targetEntity]!(ctx.db);
      const source = await SOURCE_FACTORIES[spec.edgeKey]!(ctx.db, target.id);
      await softDelete(
        ctx.db,
        entityManifest[spec.targetEntity].dbTable!,
        target.id,
      );
      await softDelete(ctx.db, spec.sourceTableName, source.id);
    }

    expect(await findReferentialLivenessViolations(ctx.db)).toEqual([]);
  });

  it("returns no violations for every derived edge while both sides are live", async () => {
    // Authoritative owner for the old per-edge live-source/live-target cases.
    for (const spec of derivedMustTargetLiveEdges) {
      const target = await TARGET_FACTORIES[spec.targetEntity]!(ctx.db);
      await SOURCE_FACTORIES[spec.edgeKey]!(ctx.db, target.id);
    }

    expect(await findReferentialLivenessViolations(ctx.db)).toEqual([]);
  });

  // The one deliberate exemption — see ENTITY_EDGE_SEMANTICS.recipe["Ingredient.recipeId"]
  // and the detectors-integrity.ts file-level doc comment. This is the single
  // most important assertion in this file: it's what stops the detector from
  // flagging intended sub-recipe behavior (a parent recipe's ingredient line
  // still naming a deleted sub-recipe, so staleness/recompute can resolve the
  // tombstone) as a referential-integrity bug.
  it("does NOT report a live Ingredient tombstone pointing at a soft-deleted sub-recipe", async () => {
    const subRecipe = await mkRecipe(ctx.db);
    // The "recipe-as-ingredient" pointer row `recipeRelations.pointerIngredient`
    // describes: a live Ingredient whose recipeId names the sub-recipe.
    await insertWithShortcode(ctx.db, "ingredient", {
      name: uniq("Sub-recipe pointer"),
      recipeId: subRecipe.id,
    });
    await softDelete(ctx.db, "Recipe", subRecipe.id);

    expect(await findReferentialLivenessViolations(ctx.db)).toEqual([]);
  });

  it("returns zero violations for a normal, fully-live database", async () => {
    // A representative slice of the graph, correctly linked end to end and
    // never soft-deleted: vendor → purchase → expense, project → task,
    // cookbook → recipe → section → ingredient line, product → inventory, and
    // a meal planning a recipe. If any wiring above were wrong (e.g. a
    // mis-copied column), this would be the test most likely to catch it as a
    // false-positive violation.
    const vendorRow = await mkVendor(ctx.db);
    const purchaseRow = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendorRow.id,
      date: "2024-01-15",
    });
    const projectRow = await mkProject(ctx.db);
    await insertWithShortcode(ctx.db, "expense", {
      name: "Clean expense",
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      projectId: projectRow.id,
      purchaseId: purchaseRow.id,
    });
    await insertWithShortcode(ctx.db, "task", {
      name: "Clean task",
      trade: "other",
      projectId: projectRow.id,
    });

    const cookbookRow = await mkCookbook(ctx.db);
    const recipeRow = await insertWithShortcode(ctx.db, "recipe", {
      name: "Clean recipe",
      cookbookId: cookbookRow.id,
    });
    const sectionRow = await insertAndReturn(ctx.db, recipeSection, {
      recipeId: recipeRow.id,
      instructions: [],
    });
    const ingredientRow = await mkIngredient(ctx.db);
    await insertAndReturn(ctx.db, recipeSectionIngredient, {
      recipeSectionId: sectionRow.id,
      ingredientId: ingredientRow.id,
      amounts: [{ value: 1, unit: "cup" }],
    });

    const productRow = await insertWithShortcode(ctx.db, "product", {
      name: uniq("Product"),
      manufacturer: "Test Mfr",
      ingredientId: ingredientRow.id,
    });
    const locationRow = await mkLocation(ctx.db);
    await insertWithShortcode(ctx.db, "inventory", {
      productId: productRow.id,
      locationId: locationRow.id,
      amount: { value: 1, unit: "each" },
    });

    const mealRow = await mkMeal(ctx.db);
    await insertAndReturn(ctx.db, mealRecipe, {
      mealId: mealRow.id,
      recipeId: recipeRow.id,
    });

    expect(await findReferentialLivenessViolations(ctx.db)).toEqual([]);
  });
});
