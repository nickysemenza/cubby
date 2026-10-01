import { createHash } from "node:crypto";

import {
  type FinanceCategoryApplyInput,
  financeCategoryReviewSchema,
} from "@cubby/schemas/ai";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";
import { createAppError } from "~/server/errors/app-error";

import { unwrapDb, withTransactionDatabase } from "./database-helpers";
import {
  expenseSpendingCategoryResolutionSql,
  spendingClassificationRevision,
} from "./expense-category-resolution";
import { loadExpenseSpendingAllocations } from "./expense-spending-allocation";
import { resolveOrThrow } from "./shortcode-resolver";

const evidenceRow = z.record(z.string(), z.json());
const rowsSchema = z.array(evidenceRow);
const financeTables = {
  financialTransaction: "FinancialTransaction",
  purchase: "Purchase",
  expense: "Expense",
} as const;
type FinanceEntity = keyof typeof financeTables;
export function isFinanceCategoryEntity(
  entity: string,
): entity is FinanceEntity {
  return entity === "purchase" || entity === "expense";
}
const rootFields = {
  financialTransaction: [
    "shortcode",
    "merchant",
    "rawDescription",
    "sourceCategory",
    "kind",
    "notes",
    "amount",
    "transactionDate",
    "postedDate",
    "status",
    "purchaseId",
    "spendingCategoryId",
  ],
  purchase: [
    "shortcode",
    "name",
    "displayLabel",
    "orderId",
    "date",
    "notes",
    "vendorId",
    "spendingCategoryId",
  ],
  expense: [
    "shortcode",
    "name",
    "cost",
    "productQuantity",
    "date",
    "notes",
    "lineKind",
    "lineBasis",
    "economicRole",
    "costType",
    "trade",
    "purchaseId",
    "productId",
    "spendingCategoryId",
  ],
} as const;

function savedFinanceBasis(
  entity: FinanceEntity,
  root: z.infer<typeof evidenceRow>,
  purchases: z.infer<typeof rowsSchema>,
  lines: z.infer<typeof rowsSchema>,
) {
  const basis = Object.fromEntries(
    Object.entries(root).map(([key, value]) => [
      key,
      value === null ? null : String(value),
    ]),
  );
  if (entity === "purchase")
    basis.vendorId = z
      .string()
      .nullable()
      .parse(purchases[0]?.vendorId ?? null);
  if (entity === "expense") {
    basis.purchaseId = z
      .string()
      .nullable()
      .parse(purchases[0]?.shortcode ?? null);
    basis.productId = z
      .string()
      .nullable()
      .parse(lines[0]?.product ?? null);
  }
  return basis;
}

/** Saved evidence only: no client edits or unrelated household records enter a reviewed proposal. */
export async function loadFinanceSuggestionContext(
  db: Database,
  entity: FinanceEntity,
  entityId: string,
) {
  const shortcode = parseShortcodeFor(entity, entityId);
  const id = await resolveOrThrow(db, entity, shortcode);
  const database = unwrapDb(db);
  const rootRows = z.array(z.object({ data: evidenceRow })).parse(
    (
      await database.execute(sql`
    SELECT to_jsonb(saved) AS data FROM ${sql.identifier(financeTables[entity])} saved WHERE id = ${id} AND "deletedAt" IS NULL
  `)
    ).rows,
  );
  const row = rootRows[0]?.data;
  if (!row || (entity === "financialTransaction" && row.status === "void"))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Finance category suggestions require a live saved record.",
    );
  const root = Object.fromEntries(
    rootFields[entity].map((key) => [key, row[key] ?? null]),
  );
  // UNION folds the legacy purchase pointer and live allocations without
  // multiplying receipt lines. Each signed allocation remains separate evidence.
  const links =
    entity === "financialTransaction"
      ? sql`
    SELECT p.id FROM "Purchase" p WHERE p.id = ${row.purchaseId ?? null} AND p."deletedAt" IS NULL
    UNION SELECT p.id FROM "FinancialTransactionAllocation" a JOIN "Purchase" p ON p.id = a."purchaseId"
    WHERE a."transactionId" = ${id} AND a."deletedAt" IS NULL AND p."deletedAt" IS NULL
  `
      : sql`SELECT p.id FROM "Purchase" p WHERE p.id = ${entity === "purchase" ? id : (row.purchaseId ?? null)} AND p."deletedAt" IS NULL`;
  const purchases = rowsSchema.parse(
    (
      await database.execute(sql`
    SELECT p.shortcode, p."displayLabel", p."orderId", p.date, p.notes,
      v.shortcode AS "vendorId", v.name AS vendor, v.notes AS "vendorNotes",
      p."spendingCategoryId" AS "storedSpendingCategoryId", p."spendingCategoryOrigin", c.shortcode AS "spendingCategoryId", c.name AS "spendingCategory"
    FROM "Purchase" p LEFT JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN "SpendingCategory" c ON c.id = p."spendingCategoryId" AND c."deletedAt" IS NULL
    WHERE p.id IN (${links}) ORDER BY p.shortcode LIMIT 101
  `)
    ).rows,
  );
  const lines = rowsSchema.parse(
    (
      await database.execute(sql`
    SELECT e.shortcode, e.name, e.cost, e."productQuantity", e.date, e.notes, e."lineKind", e."lineBasis", e."economicRole", e."costType", e.trade,
      p.shortcode AS purchase, g.shortcode AS product, g.name AS "productName", g.manufacturer, g.model, g.notes AS "productNotes",
      pc.shortcode AS "productCategoryId", pc.name AS "productCategory",
      e."spendingCategoryId" AS "storedSpendingCategoryId", c.shortcode AS "spendingCategoryId", c.name AS "spendingCategory",
      ${expenseSpendingCategoryResolutionSql("e")} AS "classification"
    FROM "Expense" e LEFT JOIN "Purchase" p ON p.id = e."purchaseId" AND p."deletedAt" IS NULL
    LEFT JOIN "Product" g ON g.id = e."productId" AND g."deletedAt" IS NULL
    LEFT JOIN "ProductCategory" pc ON pc.id = g."categoryId" AND pc."deletedAt" IS NULL
    LEFT JOIN "SpendingCategory" c ON c.id = e."spendingCategoryId" AND c."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL AND ${entity === "expense" ? sql`e.id = ${id}` : sql`e."purchaseId" IN (${links})`}
    ORDER BY e.shortcode LIMIT 201
  `)
    ).rows,
  );
  const allocations =
    entity === "financialTransaction"
      ? rowsSchema.parse(
          (
            await database.execute(sql`
    SELECT p.shortcode AS purchase, a.amount FROM "FinancialTransactionAllocation" a JOIN "Purchase" p ON p.id = a."purchaseId"
    WHERE a."transactionId" = ${id} AND a."deletedAt" IS NULL AND p."deletedAt" IS NULL
    ORDER BY p.shortcode LIMIT 101
  `)
          ).rows,
        )
      : [];
  const categories = rowsSchema.parse(
    (
      await database.execute(sql`
    SELECT shortcode, name, "parentId" FROM "SpendingCategory" WHERE "deletedAt" IS NULL ORDER BY shortcode
  `)
    ).rows,
  );
  const classificationRevision = await spendingClassificationRevision(db);
  const categoryAllocations =
    entity === "expense"
      ? ((
          await loadExpenseSpendingAllocations(db, [
            parseEntityId("expense", id),
          ])
        ).get(parseEntityId("expense", id)) ?? [])
      : [];
  const truncated =
    purchases.length > 100 || lines.length > 200 || allocations.length > 100;
  const subject = JSON.stringify({
    savedRecord: root,
    classificationRevision,
    categoryAllocations,
    purchases: purchases.slice(0, 100),
    allocations: allocations.slice(0, 100),
    lines: lines.slice(0, 200),
    truncated,
  });
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({ entity, entityId: shortcode, subject, categories }),
    )
    .digest("hex");
  const basis = savedFinanceBasis(entity, root, purchases, lines);
  return {
    subject,
    fingerprint,
    hasSignal:
      lines.length > 0 ||
      purchases.some((p) => p.vendor || p.displayLabel || p.notes),
    basis,
    truncated,
  };
}

/** Freshness and the audited entity write share the same committed operation. */
export async function applyFinanceCategorySuggestion(
  context: EntityKernelContext,
  input: FinanceCategoryApplyInput,
) {
  const review = financeCategoryReviewSchema.parse(input);
  if (!isFinanceCategoryEntity(review.entity))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Classify Expense lines or review the Purchase fallback; transactions carry source evidence only.",
    );
  return withTransactionDatabase(
    context.db,
    async (db) => {
      const current = await loadFinanceSuggestionContext(
        db,
        review.entity,
        review.entityId,
      );
      if (current.truncated)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Linked evidence exceeds the review limit; review the record and choose a category manually.",
        );
      if (current.fingerprint !== review.fingerprint)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "The saved finance record or linked evidence changed; review again before applying the category.",
        );
      await resolveOrThrow(db, "spendingCategory", input.spendingCategoryId);
      const result = await executeEntity(
        { ...context, db },
        entityBrowserMutationCommandSchema.parse({
          action: "update",
          entity: review.entity,
          id: parseShortcodeFor(review.entity, review.entityId),
          data: { spendingCategoryId: input.spendingCategoryId },
        }),
      );
      if (result.action !== "update")
        throw new Error("Finance category Apply requires an update result.");
      return {
        entity: review.entity,
        entityId: review.entityId,
        spendingCategoryId: input.spendingCategoryId,
        sideEffects: result.sideEffects,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
