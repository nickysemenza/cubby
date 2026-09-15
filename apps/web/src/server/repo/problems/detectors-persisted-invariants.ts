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

const registrations = [
  {
    domain: "meal recipe",
    table: "MealRecipe",
    schema: mealRecipePersistedInvariant,
    query: sql`SELECT mr.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", to_jsonb(mr) AS payload
      FROM "MealRecipe" mr JOIN "Meal" m ON m.id = mr."mealId"
      WHERE mr."deletedAt" IS NULL`,
  },
  {
    domain: "meal portion",
    table: "MealRecipePortion",
    schema: mealRecipePortionPersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", to_jsonb(p) AS payload
      FROM "MealRecipePortion" p JOIN "Meal" m ON m.id = p."mealId"
      WHERE p."deletedAt" IS NULL`,
  },
  {
    domain: "meal food",
    table: "MealFoodEntry",
    schema: mealFoodEntryPersistedInvariant,
    query: sql`SELECT f.id::text AS "recordId", 'meal' AS "ownerEntity",
      m.shortcode AS "ownerId", to_jsonb(f) AS payload
      FROM "MealFoodEntry" f JOIN "Meal" m ON m.id = f."mealId"
      WHERE f."deletedAt" IS NULL`,
  },
  {
    domain: "location identity",
    table: "Location",
    schema: locationPersistedInvariant,
    query: sql`SELECT l.id::text AS "recordId", 'location' AS "ownerEntity",
      l.shortcode AS "ownerId", to_jsonb(l) AS payload
      FROM "Location" l WHERE l."deletedAt" IS NULL`,
  },
  {
    domain: "image metadata",
    table: "Image",
    schema: imagePersistedInvariant,
    query: sql`SELECT i.id::text AS "recordId", 'image' AS "ownerEntity",
      i.shortcode AS "ownerId", to_jsonb(i) AS payload
      FROM "Image" i WHERE i."deletedAt" IS NULL`,
  },
  {
    domain: "planting location history",
    table: "PlantingLocationPeriod",
    schema: plantingLocationPeriodPersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'planting' AS "ownerEntity",
      owner.shortcode AS "ownerId", to_jsonb(p) AS payload
      FROM "PlantingLocationPeriod" p
      JOIN "Planting" owner ON owner.id = p."plantingId"`,
  },
  {
    domain: "project dependency",
    table: "ProjectDependency",
    schema: dependencyPersistedInvariant,
    query: sql`SELECT d.id::text AS "recordId", 'project' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'sourceId', d."projectId", 'blockedById', d."blockedByProjectId"
      ) AS payload FROM "ProjectDependency" d
      JOIN "Project" owner ON owner.id = d."projectId"`,
  },
  {
    domain: "task dependency",
    table: "TaskDependency",
    schema: dependencyPersistedInvariant,
    query: sql`SELECT d.id::text AS "recordId", 'task' AS "ownerEntity",
      owner.shortcode AS "ownerId", jsonb_build_object(
        'sourceId', d."taskId", 'blockedById', d."blockedByTaskId"
      ) AS payload FROM "TaskDependency" d
      JOIN "Task" owner ON owner.id = d."taskId"`,
  },
  {
    domain: "ledger party",
    table: "LedgerParty",
    schema: ledgerPartyPersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'ledgerParty' AS "ownerEntity",
      p.shortcode AS "ownerId", to_jsonb(p) AS payload
      FROM "LedgerParty" p WHERE p."deletedAt" IS NULL`,
  },
  {
    domain: "purchase",
    table: "Purchase",
    schema: purchasePersistedInvariant,
    query: sql`SELECT p.id::text AS "recordId", 'purchase' AS "ownerEntity",
      p.shortcode AS "ownerId", to_jsonb(p) AS payload
      FROM "Purchase" p WHERE p."deletedAt" IS NULL`,
  },
  {
    domain: "product component",
    table: "ProductComponent",
    schema: productComponentPersistedInvariant,
    query: sql`SELECT c.id::text AS "recordId", 'product' AS "ownerEntity",
      owner.shortcode AS "ownerId", to_jsonb(c) AS payload
      FROM "ProductComponent" c
      JOIN "Product" owner ON owner.id = c."parentProductId"
      WHERE c."deletedAt" IS NULL`,
  },
  {
    domain: "financial transaction",
    table: "FinancialTransaction",
    schema: financialTransactionPersistedInvariant,
    query: sql`SELECT t.id::text AS "recordId", 'financialTransaction' AS "ownerEntity",
      t.shortcode AS "ownerId", to_jsonb(t) AS payload
      FROM "FinancialTransaction" t WHERE t."deletedAt" IS NULL`,
  },
  {
    domain: "transaction allocation",
    table: "FinancialTransactionAllocation",
    schema: financialTransactionAllocationPersistedInvariant,
    query: sql`SELECT a.id::text AS "recordId", 'financialTransaction' AS "ownerEntity",
      owner.shortcode AS "ownerId", to_jsonb(a) AS payload
      FROM "FinancialTransactionAllocation" a
      JOIN "FinancialTransaction" owner ON owner.id = a."transactionId"
      WHERE a."deletedAt" IS NULL`,
  },
  {
    domain: "ledger transfer",
    table: "LedgerTransfer",
    schema: ledgerTransferPersistedInvariant,
    query: sql`SELECT t.id::text AS "recordId", 'ledgerTransfer' AS "ownerEntity",
      t.shortcode AS "ownerId", to_jsonb(t) AS payload
      FROM "LedgerTransfer" t WHERE t."deletedAt" IS NULL`,
  },
  {
    domain: "statement import",
    table: "StatementImport",
    schema: statementImportPersistedInvariant,
    query: sql`SELECT i.id::text AS "recordId", NULL::text AS "ownerEntity",
      NULL::text AS "ownerId", to_jsonb(i) AS payload
      FROM "StatementImport" i WHERE i."deletedAt" IS NULL`,
  },
  {
    domain: "statement row",
    table: "StatementRow",
    schema: statementRowPersistedInvariant,
    query: sql`SELECT r.id::text AS "recordId", NULL::text AS "ownerEntity",
      NULL::text AS "ownerId", to_jsonb(r) AS payload
      FROM "StatementRow" r WHERE r."deletedAt" IS NULL`,
  },
  {
    domain: "expense",
    table: "Expense",
    schema: expensePersistedInvariant,
    query: sql`SELECT e.id::text AS "recordId", 'expense' AS "ownerEntity",
      e.shortcode AS "ownerId", to_jsonb(e) AS payload
      FROM "Expense" e WHERE e."deletedAt" IS NULL`,
  },
  {
    domain: "expense attribution",
    table: "ExpenseAttribution",
    schema: expenseAttributionPersistedInvariant,
    query: sql`SELECT a.id::text AS "recordId", 'expense' AS "ownerEntity",
      owner.shortcode AS "ownerId", to_jsonb(a) AS payload
      FROM "ExpenseAttribution" a
      JOIN "Expense" owner ON owner.id = a."expenseId"
      WHERE a."deletedAt" IS NULL`,
  },
  {
    domain: "ledger source claim",
    table: "LedgerSourceClaim",
    schema: ledgerSourceClaimPersistedInvariant,
    query: sql`SELECT c.id::text AS "recordId",
      CASE WHEN c."expenseId" IS NOT NULL THEN 'expense' ELSE 'ledgerTransfer' END AS "ownerEntity",
      COALESCE(e.shortcode, t.shortcode) AS "ownerId", to_jsonb(c) AS payload
      FROM "LedgerSourceClaim" c
      LEFT JOIN "Expense" e ON e.id = c."expenseId"
      LEFT JOIN "LedgerTransfer" t ON t.id = c."ledgerTransferId"
      WHERE c."deletedAt" IS NULL`,
  },
] satisfies readonly PersistedInvariantRegistration[];

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
