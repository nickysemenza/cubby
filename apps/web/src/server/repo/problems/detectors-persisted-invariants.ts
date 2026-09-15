import {
  dependencyPersistedInvariant,
  expenseAttributionPersistedInvariant,
  expensePersistedInvariant,
  financialTransactionAllocationPersistedInvariant,
  financialTransactionPersistedInvariant,
  imagePersistedInvariant,
  ledgerPartyPersistedInvariant,
  ledgerSourceClaimPersistedInvariant,
  ledgerTransferPersistedInvariant,
  locationPersistedInvariant,
  mealFoodEntryPersistedInvariant,
  mealRecipePersistedInvariant,
  mealRecipePortionPersistedInvariant,
  plantingLocationPeriodPersistedInvariant,
  productComponentPersistedInvariant,
  purchasePersistedInvariant,
  statementImportPersistedInvariant,
  statementRowPersistedInvariant,
} from "@cubby/schemas/persisted-invariants";
import {
  persistedInvariantViolationSchema,
  type PersistedInvariantViolation,
} from "@cubby/schemas/problems";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

type PersistedInvariantRegistration = {
  domain: string;
  table: string;
  query: SQL;
  schema: z.ZodType;
};

const definePersistedInvariant = <T extends PersistedInvariantRegistration>(
  registration: T,
): T => registration;

const registrations = [
  definePersistedInvariant({
    domain: "meal recipe",
    table: "MealRecipe",
    schema: mealRecipePersistedInvariant,
    query: sql`SELECT mr.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", jsonb_build_object(
        'estimatedYieldGrams', mr."estimatedYieldGrams",
        'actualYieldGrams', mr."actualYieldGrams"
      ) AS payload FROM "MealRecipe" mr JOIN "Meal" m ON m.id = mr."mealId"
      WHERE mr."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "meal portion",
    table: "MealRecipePortion",
    schema: mealRecipePortionPersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", jsonb_build_object(
        'amount', p.amount, 'grams', p.grams
      ) AS payload FROM "MealRecipePortion" p JOIN "Meal" m ON m.id = p."mealId"
      WHERE p."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "meal food",
    table: "MealFoodEntry",
    schema: mealFoodEntryPersistedInvariant,
    query: sql`SELECT f.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", jsonb_build_object(
        'sourceKind', f."sourceKind", 'ingredientId', f."ingredientId",
        'productId', f."productId", 'amount', f.amount, 'grams', f.grams,
        'name', f.name, 'nutrients', f.nutrients
      ) AS payload FROM "MealFoodEntry" f JOIN "Meal" m ON m.id = f."mealId"
      WHERE f."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "location identity",
    table: "Location",
    schema: locationPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'location' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object(
        'type', type, 'productId', "productId"
      ) AS payload FROM "Location" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "image metadata",
    table: "Image",
    schema: imagePersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'image' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object(
        'perceptualHash', "perceptualHash"
      ) AS payload FROM "Image" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "planting location history",
    table: "PlantingLocationPeriod",
    schema: plantingLocationPeriodPersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'planting' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'startKind', p."startKind"
      ) AS payload FROM "PlantingLocationPeriod" p
      JOIN "Planting" owner ON owner.id = p."plantingId"`,
  }),
  definePersistedInvariant({
    domain: "project dependency",
    table: "ProjectDependency",
    schema: dependencyPersistedInvariant,
    query: sql`SELECT d.id::text AS "recordId", 'project' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'sourceId', d."projectId", 'blockedById', d."blockedByProjectId"
      ) AS payload FROM "ProjectDependency" d
      JOIN "Project" owner ON owner.id = d."projectId"`,
  }),
  definePersistedInvariant({
    domain: "task dependency",
    table: "TaskDependency",
    schema: dependencyPersistedInvariant,
    query: sql`SELECT d.id::text AS "recordId", 'task' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'sourceId', d."taskId", 'blockedById', d."blockedByTaskId"
      ) AS payload FROM "TaskDependency" d
      JOIN "Task" owner ON owner.id = d."taskId"`,
  }),
  definePersistedInvariant({
    domain: "ledger party",
    table: "LedgerParty",
    schema: ledgerPartyPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'ledgerParty' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object('kind', kind) AS payload
      FROM "LedgerParty" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "purchase",
    table: "Purchase",
    schema: purchasePersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'purchase' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object(
        'statedTotal', "statedTotal"
      ) AS payload FROM "Purchase" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "product component",
    table: "ProductComponent",
    schema: productComponentPersistedInvariant,
    query: sql`SELECT c.id::text AS "recordId", 'product' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'parentProductId', c."parentProductId",
        'componentProductId', c."componentProductId", 'quantity', c.quantity
      ) AS payload FROM "ProductComponent" c
      JOIN "Product" owner ON owner.id = c."parentProductId"
      WHERE c."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "financial transaction",
    table: "FinancialTransaction",
    schema: financialTransactionPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'financialTransaction' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object(
        'amount', amount, 'status', status, 'postedDate', "postedDate"
      ) AS payload FROM "FinancialTransaction" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "transaction allocation",
    table: "FinancialTransactionAllocation",
    schema: financialTransactionAllocationPersistedInvariant,
    query: sql`SELECT a.id::text AS "recordId", 'financialTransaction' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object('amount', a.amount) AS payload
      FROM "FinancialTransactionAllocation" a
      JOIN "FinancialTransaction" owner ON owner.id = a."transactionId"
      WHERE a."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "ledger transfer",
    table: "LedgerTransfer",
    schema: ledgerTransferPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'ledgerTransfer' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object('amount', amount) AS payload
      FROM "LedgerTransfer" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "statement import",
    table: "StatementImport",
    schema: statementImportPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", NULL::text AS "ownerEntity",
      NULL::text AS "ownerId", jsonb_build_object(
        'dateKind', "dateKind", 'rowCountDeclared', "rowCountDeclared"
      ) AS payload FROM "StatementImport" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "statement row",
    table: "StatementRow",
    schema: statementRowPersistedInvariant,
    query: sql`SELECT id::text AS "recordId", NULL::text AS "ownerEntity",
      NULL::text AS "ownerId", jsonb_build_object(
        'amount', amount, 'providerAmount', "providerAmount",
        'providerStatus', "providerStatus", 'disposition', disposition,
        'dispositionReason', "dispositionReason", 'dispositionNote', "dispositionNote"
      ) AS payload FROM "StatementRow" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "expense",
    table: "Expense",
    schema: expensePersistedInvariant,
    query: sql`SELECT id::text AS "recordId", 'expense' AS "ownerEntity",
      shortcode AS "ownerId", jsonb_build_object(
        'cost', cost, 'productId', "productId", 'productQuantity', "productQuantity",
        'lineKind', "lineKind"
      ) AS payload FROM "Expense" WHERE "deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "expense attribution",
    table: "ExpenseAttribution",
    schema: expenseAttributionPersistedInvariant,
    query: sql`SELECT a.id::text AS "recordId", 'expense' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'role', a.role, 'weight', a.weight::text
      ) AS payload FROM "ExpenseAttribution" a
      JOIN "Expense" owner ON owner.id = a."expenseId"
      WHERE a."deletedAt" IS NULL`,
  }),
  definePersistedInvariant({
    domain: "ledger source claim",
    table: "LedgerSourceClaim",
    schema: ledgerSourceClaimPersistedInvariant,
    query: sql`SELECT c.id::text AS "recordId",
      CASE WHEN c."expenseId" IS NOT NULL THEN 'expense' ELSE 'ledgerTransfer' END AS "ownerEntity",
      COALESCE(e.shortcode, t.shortcode) AS "ownerId", jsonb_build_object(
        'expenseId', c."expenseId", 'ledgerTransferId', c."ledgerTransferId",
        'sourceKeyVersion', c."sourceKeyVersion",
        'normalizedEvidence', c."normalizedEvidence",
        'targetAmountAtClaim', c."targetAmountAtClaim",
        'reconciliationDecision', c."reconciliationDecision",
        'reconciliationNote', c."reconciliationNote"
      ) AS payload FROM "LedgerSourceClaim" c
      LEFT JOIN "Expense" e ON e.id = c."expenseId"
      LEFT JOIN "LedgerTransfer" t ON t.id = c."ledgerTransferId"
      WHERE c."deletedAt" IS NULL`,
  }),
] as const;

const selectedRow = z.object({
  recordId: z.string(),
  ownerEntity: z.string().nullable(),
  ownerId: z.string().nullable(),
  payload: z.unknown(),
});

const issuePath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? "row" : path.map(String).join(".");

export const findPersistedInvariantViolations = async (
  db: Database,
): Promise<PersistedInvariantViolation[]> => {
  const violations: PersistedInvariantViolation[] = [];
  for (const registration of registrations) {
    const result = await getDb(db).execute(registration.query);
    for (const rawRow of result.rows) {
      const row = selectedRow.parse(rawRow);
      const parsed = registration.schema.safeParse(row.payload);
      if (parsed.success) continue;
      violations.push(
        persistedInvariantViolationSchema.parse({
          domain: registration.domain,
          table: registration.table,
          recordId: row.recordId,
          owner:
            row.ownerEntity && row.ownerId
              ? { entity: row.ownerEntity, id: row.ownerId }
              : null,
          issues: parsed.error.issues.slice(0, 4).map((issue) => ({
            path: issuePath(issue.path),
            message: issue.message,
          })),
        }),
      );
    }
  }
  return violations;
};

export const countPersistedInvariantViolations = async (
  db: Database,
): Promise<number> => (await findPersistedInvariantViolations(db)).length;
