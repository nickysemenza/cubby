import { createHash } from "node:crypto";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import { unwrapDb, withTransactionDatabase } from "./database-helpers";

const sourceRow = z.object({ id: z.string(), name: z.string() });
const categoryRow = z.object({ id: z.string(), name: z.string() });
const linkedRow = z.object({
  id: z.string(),
  names: z.array(z.string().nullable()),
});
const normalized = (name: string) => name.trim().toLowerCase();

/** Imported labels are evidence, not guessed policy. Preview/apply never infers receipt expectations. */
export async function previewImportedSpendingCategories(db: Database) {
  const database = unwrapDb(db);
  const transactions = z.array(sourceRow).parse(
    (
      await database.execute(sql`
    SELECT shortcode AS id, btrim("sourceCategory") AS name FROM "FinancialTransaction"
    WHERE "deletedAt" IS NULL AND status <> 'void' AND "spendingCategoryId" IS NULL
      AND NULLIF(btrim("sourceCategory"), '') IS NOT NULL ORDER BY shortcode
  `)
    ).rows,
  );
  const existing = z.array(categoryRow).parse(
    (
      await database.execute(sql`
    SELECT shortcode AS id, name FROM "SpendingCategory" WHERE "deletedAt" IS NULL ORDER BY shortcode
  `)
    ).rows,
  );
  const linked = z.array(linkedRow).parse(
    (
      await database.execute(sql`
    SELECT p.shortcode AS id, array_agg(COALESCE(c.name, NULLIF(btrim(t."sourceCategory"), '')) ORDER BY t.shortcode) AS names
    FROM "Purchase" p
    JOIN "FinancialTransactionAllocation" a ON a."purchaseId" = p.id AND a."deletedAt" IS NULL
    JOIN "FinancialTransaction" t ON t.id = a."transactionId" AND t."deletedAt" IS NULL AND t.status <> 'void'
    LEFT JOIN "SpendingCategory" c ON c.id = t."spendingCategoryId" AND c."deletedAt" IS NULL
    WHERE p."deletedAt" IS NULL AND p."spendingCategoryId" IS NULL
    GROUP BY p.shortcode ORDER BY p.shortcode
  `)
    ).rows,
  );
  let unresolvedPurchases = 0;
  const purchases = linked.flatMap((row) => {
    const names = new Set(
      row.names.map((name) => (name === null ? null : normalized(name))),
    );
    if (names.size !== 1 || names.has(null)) {
      unresolvedPurchases++;
      return [];
    }
    return [{ id: row.id, name: row.names[0]! }];
  });
  const names = new Map<string, string>();
  for (const row of [...transactions, ...purchases])
    names.set(normalized(row.name), row.name.trim());
  const categories = [...names]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, name]) => {
      const matches = existing.filter(
        (category) => normalized(category.name) === key,
      );
      if (matches.length > 1)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Imported category name is ambiguous among live categories; resolve it before applying.",
        );
      return { name, existingId: matches[0]?.id ?? null };
    });
  const plan = { categories, transactions, purchases, unresolvedPurchases };
  return {
    ...plan,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
  };
}

/** Apply an unchanged reviewed plan through ordinary audited entity writes in one transaction. */
export async function applyImportedSpendingCategories(
  ctx: EntityKernelContext,
  fingerprint: string,
) {
  return withTransactionDatabase(
    ctx.db,
    async (db) => {
      const plan = await previewImportedSpendingCategories(db);
      if (plan.fingerprint !== fingerprint)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Imported category preview changed; review a fresh preview before applying.",
        );
      const context = { ...ctx, db };
      const categories = new Map<string, string>();
      for (const category of plan.categories) {
        if (category.existingId)
          categories.set(normalized(category.name), category.existingId);
        else {
          const created = await executeEntity(context, {
            action: "create",
            entity: "spendingCategory",
            data: {
              name: category.name,
              parentId: null,
              evidenceExpectation: "unknown",
              productExpectation: "unknown",
            },
          });
          categories.set(normalized(category.name), created.item.id);
        }
      }
      for (const transaction of plan.transactions) {
        const category = categories.get(normalized(transaction.name));
        if (!category)
          throw new Error(
            "Reviewed transaction category is missing from the plan",
          );
        await executeEntity(context, {
          action: "update",
          entity: "financialTransaction",
          id: parseShortcodeFor("financialTransaction", transaction.id),
          data: {
            spendingCategoryId: parseShortcodeFor("spendingCategory", category),
          },
        });
      }
      for (const purchase of plan.purchases) {
        const category = categories.get(normalized(purchase.name));
        if (!category)
          throw new Error(
            "Reviewed purchase category is missing from the plan",
          );
        await executeEntity(context, {
          action: "update",
          entity: "purchase",
          id: parseShortcodeFor("purchase", purchase.id),
          data: {
            spendingCategoryId: parseShortcodeFor("spendingCategory", category),
          },
        });
      }
      return {
        createdCategories: plan.categories.filter(
          (category) => category.existingId === null,
        ).length,
        transactions: plan.transactions.length,
        purchases: plan.purchases.length,
        unresolvedPurchases: plan.unresolvedPurchases,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
