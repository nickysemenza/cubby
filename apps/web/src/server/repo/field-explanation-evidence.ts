import type { Entity } from "@cubby/schemas/entity";
import { parseShortcodeFor } from "@cubby/shared";
import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  image,
  ingredient,
  meal,
  mealRecipe,
  product,
  productComponent,
  purchase,
  purchaseImage,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  vendor,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";

const SOURCE_LIMIT = 25;
const QUERY_LIMIT = SOURCE_LIMIT + 1;
const RAW_PREVIEW_DEPTH = 4;
const RAW_PREVIEW_FIELDS = 25;

const evidenceJson = z.json();
const evidencePrimitive = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const evidenceArray = z.array(evidenceJson);
const evidenceRecord = z.record(z.string(), evidenceJson);
type FieldExplanationEvidenceValue = z.infer<typeof evidenceJson>;

type FieldCountEvidenceSource = {
  label: string;
  entity: { entityType: Entity; entityId: string } | null;
  value: FieldExplanationEvidenceValue;
};

type FieldCountEvidence = {
  sources: FieldCountEvidenceSource[];
  truncated: boolean;
};

type EvidenceDatabase = Database | DrizzleTransaction;
type EvidenceLoader = (
  db: EvidenceDatabase,
  shortcode: string,
) => Promise<FieldCountEvidence>;

/** Keep the displayed value and its separately loaded evidence on one MVCC snapshot. */
export async function withFieldExplanationSnapshot<T>(
  db: Database,
  fn: (snapshotDb: Database) => Promise<T>,
): Promise<T> {
  return getDb(db).transaction((tx) => fn(databaseForTransaction(tx)), {
    isolationLevel: "repeatable read",
  });
}

function sourcesFromRows<Row>(
  rows: Row[],
  source: (row: Row) => FieldCountEvidenceSource,
): FieldCountEvidence {
  return {
    sources: rows.slice(0, SOURCE_LIMIT).map(source),
    truncated: rows.length > SOURCE_LIMIT,
  };
}

async function loadProductComponentEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const owner = alias(product, "fieldExplanationComponentOwner");
  const component = alias(product, "fieldExplanationComponentTarget");
  const rows = await unwrapDb(db)
    .select({
      shortcode: component.shortcode,
      name: component.name,
      quantity: productComponent.quantity,
      deletedAt: component.deletedAt,
    })
    .from(productComponent)
    .innerJoin(owner, eq(owner.id, productComponent.parentProductId))
    // The canonical scalar counts a live edge even if its target was deleted.
    .innerJoin(component, eq(component.id, productComponent.componentProductId))
    .where(
      and(
        eq(owner.shortcode, shortcode),
        notDeleted(owner),
        notDeleted(productComponent),
      ),
    )
    .orderBy(asc(component.name), asc(productComponent.id))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Component relationship",
    entity: {
      entityType: "product",
      entityId: parseShortcodeFor("product", row.shortcode),
    },
    value: {
      name: row.name,
      quantity: row.quantity,
      targetDeleted: row.deletedAt !== null,
    },
  }));
}

const expenseSource = (row: {
  shortcode: string;
  name: string;
  cost: number | null;
  date: string | null;
  lineKind: string;
  future: boolean;
  productQuantity: number | null;
}): FieldCountEvidenceSource => ({
  label: "Expense line",
  entity: {
    entityType: "expense",
    entityId: parseShortcodeFor("expense", row.shortcode),
  },
  value: {
    name: row.name,
    cost: row.cost,
    date: row.date,
    lineKind: row.lineKind,
    future: row.future,
    productQuantity: row.productQuantity,
  },
});

async function loadProductExpenseEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: expense.shortcode,
      name: expense.name,
      cost: expense.cost,
      date: expense.date,
      lineKind: expense.lineKind,
      future: expense.future,
      productQuantity: expense.productQuantity,
    })
    .from(expense)
    .innerJoin(product, eq(product.id, expense.productId))
    .where(
      and(
        eq(product.shortcode, shortcode),
        notDeleted(product),
        notDeleted(expense),
      ),
    )
    .orderBy(asc(expense.date), asc(expense.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, expenseSource);
}

async function loadRecipeMealEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: meal.shortcode,
      name: meal.name,
      date: meal.date,
      mealType: meal.mealType,
      mealKind: meal.mealKind,
    })
    .from(mealRecipe)
    .innerJoin(recipe, eq(recipe.id, mealRecipe.recipeId))
    .innerJoin(meal, eq(meal.id, mealRecipe.mealId))
    .where(
      and(
        eq(recipe.shortcode, shortcode),
        notDeleted(recipe),
        notDeleted(mealRecipe),
        notDeleted(meal),
      ),
    )
    .orderBy(asc(meal.date), asc(meal.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Meal-recipe relationship",
    entity: {
      entityType: "meal",
      entityId: parseShortcodeFor("meal", row.shortcode),
    },
    value: {
      name: row.name,
      date: row.date,
      mealType: row.mealType,
      mealKind: row.mealKind,
    },
  }));
}

async function loadIngredientRecipeEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .selectDistinct({ shortcode: recipe.shortcode, name: recipe.name })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        eq(ingredient.shortcode, shortcode),
        notDeleted(ingredient),
        notDeleted(recipeSectionIngredient),
        notDeleted(recipeSection),
        notDeleted(recipe),
      ),
    )
    .orderBy(asc(recipe.name), asc(recipe.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Recipe using ingredient",
    entity: {
      entityType: "recipe",
      entityId: parseShortcodeFor("recipe", row.shortcode),
    },
    value: { name: row.name },
  }));
}

async function loadCookbookRecipeEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({ shortcode: recipe.shortcode, name: recipe.name })
    .from(recipe)
    .innerJoin(cookbook, eq(cookbook.id, recipe.cookbookId))
    .where(
      and(
        eq(cookbook.shortcode, shortcode),
        notDeleted(cookbook),
        notDeleted(recipe),
      ),
    )
    .orderBy(asc(recipe.name), asc(recipe.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Imported live recipe",
    entity: {
      entityType: "recipe",
      entityId: parseShortcodeFor("recipe", row.shortcode),
    },
    value: { name: row.name },
  }));
}

type JsonPreview = { value: FieldExplanationEvidenceValue; truncated: boolean };

function previewStoredJson(
  value: FieldExplanationEvidenceValue,
  depth = 0,
): JsonPreview {
  const primitive = evidencePrimitive.safeParse(value);
  if (primitive.success) return { value: primitive.data, truncated: false };
  if (depth >= RAW_PREVIEW_DEPTH)
    return { value: "[stored import preview truncated]", truncated: true };
  const array = evidenceArray.safeParse(value);
  if (array.success) {
    const kept = array.data.slice(0, RAW_PREVIEW_FIELDS);
    const previews = kept.map((item) => previewStoredJson(item, depth + 1));
    return {
      value: previews.map((preview) => preview.value),
      truncated:
        kept.length !== array.data.length ||
        previews.some((preview) => preview.truncated),
    };
  }
  const record = evidenceRecord.parse(value);
  const entries = Object.entries(record).slice(0, RAW_PREVIEW_FIELDS);
  let truncated = entries.length !== Object.keys(record).length;
  const preview: Record<string, FieldExplanationEvidenceValue> = {};
  for (const [key, item] of entries) {
    const result = previewStoredJson(item, depth + 1);
    preview[key] = result.value;
    truncated ||= result.truncated;
  }
  return { value: preview, truncated };
}

async function loadCookbookSourceRecipeEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const [row] = await unwrapDb(db)
    .select({
      shortcode: cookbook.shortcode,
      name: cookbook.name,
      sourceLabel: cookbook.sourceLabel,
      sourceRecipeCount: cookbook.sourceRecipeCount,
      importedAt: cookbook.importedAt,
      rawJson: cookbook.rawJson,
    })
    .from(cookbook)
    .where(and(eq(cookbook.shortcode, shortcode), notDeleted(cookbook)))
    .limit(1);
  if (!row) return { sources: [], truncated: false };
  const rawImport = previewStoredJson(evidenceJson.parse(row.rawJson));
  return {
    sources: [
      {
        label: "Stored cookbook import",
        entity: {
          entityType: "cookbook",
          entityId: parseShortcodeFor("cookbook", row.shortcode),
        },
        value: {
          basis: "Stored at import time; this is not a live recipe count.",
          name: row.name,
          sourceLabel: row.sourceLabel,
          importedAt: row.importedAt.toISOString(),
          storedSourceRecipeCount: row.sourceRecipeCount,
          rawImportPreview: rawImport.value,
        },
      },
    ],
    truncated: rawImport.truncated,
  };
}

async function loadVendorPurchaseEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      displayLabel: purchase.displayLabel,
      date: purchase.date,
    })
    .from(purchase)
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .where(
      and(
        eq(vendor.shortcode, shortcode),
        notDeleted(vendor),
        notDeleted(purchase),
      ),
    )
    .orderBy(asc(purchase.date), asc(purchase.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Purchase",
    entity: {
      entityType: "purchase",
      entityId: parseShortcodeFor("purchase", row.shortcode),
    },
    value: {
      orderId: row.orderId,
      displayLabel: row.displayLabel,
      date: row.date,
    },
  }));
}

async function loadPurchaseExpenseEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: expense.shortcode,
      name: expense.name,
      cost: expense.cost,
      date: expense.date,
      lineKind: expense.lineKind,
      future: expense.future,
      productQuantity: expense.productQuantity,
    })
    .from(expense)
    .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
    .where(
      and(
        eq(purchase.shortcode, shortcode),
        notDeleted(purchase),
        notDeleted(expense),
      ),
    )
    .orderBy(asc(expense.date), asc(expense.shortcode))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, expenseSource);
}

async function loadPurchaseDocumentEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      filename: image.filename,
      documentKind: purchaseImage.documentKind,
    })
    .from(purchaseImage)
    .innerJoin(purchase, eq(purchase.id, purchaseImage.purchaseId))
    .innerJoin(image, eq(image.id, purchaseImage.imageId))
    .where(
      and(
        eq(purchase.shortcode, shortcode),
        notDeleted(purchase),
        notDeleted(purchaseImage),
        notDeleted(image),
      ),
    )
    .orderBy(asc(purchaseImage.sortOrder), asc(purchaseImage.createdAt))
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Purchase document",
    entity: {
      entityType: "image",
      entityId: parseShortcodeFor("image", row.shortcode),
    },
    value: { filename: row.filename, documentKind: row.documentKind },
  }));
}

async function loadFinancialAccountTransactionEvidence(
  db: EvidenceDatabase,
  shortcode: string,
): Promise<FieldCountEvidence> {
  const rows = await unwrapDb(db)
    .select({
      shortcode: financialTransaction.shortcode,
      amount: financialTransaction.amount,
      status: financialTransaction.status,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
      merchant: financialTransaction.merchant,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      eq(financialAccount.id, financialTransaction.accountId),
    )
    .where(
      and(
        eq(financialAccount.shortcode, shortcode),
        notDeleted(financialAccount),
        notDeleted(financialTransaction),
      ),
    )
    .orderBy(
      asc(financialTransaction.transactionDate),
      asc(financialTransaction.shortcode),
    )
    .limit(QUERY_LIMIT);
  return sourcesFromRows(rows, (row) => ({
    label: "Financial transaction",
    entity: {
      entityType: "financialTransaction",
      entityId: parseShortcodeFor("financialTransaction", row.shortcode),
    },
    value: {
      amount: row.amount,
      status: row.status,
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      merchant: row.merchant,
    },
  }));
}

const evidenceLoaders = new Map<string, EvidenceLoader>([
  ["product:componentCount", loadProductComponentEvidence],
  ["product:expenseCount", loadProductExpenseEvidence],
  ["recipe:meals", loadRecipeMealEvidence],
  ["ingredient:recipeCount", loadIngredientRecipeEvidence],
  ["ingredient:appearsInRecipes", loadIngredientRecipeEvidence],
  ["cookbook:recipeCount", loadCookbookRecipeEvidence],
  ["cookbook:sourceRecipeCount", loadCookbookSourceRecipeEvidence],
  ["vendor:purchaseCount", loadVendorPurchaseEvidence],
  ["purchase:expenseCount", loadPurchaseExpenseEvidence],
  ["purchase:documentCount", loadPurchaseDocumentEvidence],
  [
    "financialAccount:transactionCount",
    loadFinancialAccountTransactionEvidence,
  ],
]);

/** Concrete, linked inputs for count fields whose public projections only carry a scalar. */
export async function loadFieldCountEvidence(
  db: EvidenceDatabase,
  entityType: Entity,
  shortcode: string,
  field: string,
): Promise<FieldCountEvidence | null> {
  const loader = evidenceLoaders.get(`${entityType}:${field}`);
  return loader ? loader(db, shortcode) : null;
}
