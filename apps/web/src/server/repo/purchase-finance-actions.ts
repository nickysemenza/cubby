import { inferExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type ExpenseShortcode,
  parseShortcodeFor,
  type ProductShortcode,
  type PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  purchaseLinkExpensesCandidatesInput,
  purchaseLinkExpensesCandidatesOut,
  purchaseLinkExpensesCheckInput,
  purchaseLinkExpensesCheckOut,
  purchaseSplitCheckInput,
  purchaseSplitCheckOut,
} from "@cubby/schemas/purchase";
import { and, count, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import { AppError, createAppError } from "~/server/errors/app-error";
import { assertClassificationPolicies } from "~/server/repo/classification-field-policy";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { validateExpenseInheritance } from "~/server/repo/expense-inheritance";
import { getExpenseByShortcode } from "~/server/repo/expense/crud";
import { expenseList } from "~/server/repo/expense/lookup";
import { getPurchaseByShortcode } from "~/server/repo/purchase";
import {
  LINK_CANDIDATE_LIMIT,
  LINK_EXPENSE_SCOPES,
  checkLinkExpenses,
  composeLinkExpenseCandidates,
  expenseFiltersForScope,
} from "~/server/repo/purchase-link-draft";
import { listPurchaseProducts } from "~/server/repo/purchase-products";
import {
  checkSplitDraft,
  resolveSplitPartClassification,
  type SplitOriginal,
} from "~/server/repo/purchase-split-draft";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/**
 * The reads behind the split, attach-expenses and attach-products actions. The wording and
 * every rule live in `purchase-split-draft.ts` and `purchase-link-draft.ts`; this file only
 * loads what they are given.
 */

/** The expense a split would replace, with the facts that decide whether it can be split. */
export async function loadSplitOriginal(
  db: Database,
  expenseId: ExpenseShortcode,
): Promise<SplitOriginal> {
  const original = await getExpenseByShortcode(db, expenseId);
  if (!original) throw createAppError("EXPENSE_NOT_FOUND", "Expense not found");
  const dbc = getDb(db);
  const [row] = await dbc
    .select({ id: expense.id })
    .from(expense)
    .where(and(eq(expense.shortcode, expenseId), notDeleted(expense)))
    .limit(1);
  if (!row) throw createAppError("EXPENSE_NOT_FOUND", "Expense not found");
  const [attributions, sourceClaims] = await Promise.all([
    dbc
      .select({ total: count() })
      .from(expenseAttribution)
      .where(
        and(
          eq(expenseAttribution.expenseId, row.id),
          notDeleted(expenseAttribution),
        ),
      ),
    dbc
      .select({ total: count() })
      .from(ledgerSourceClaim)
      .where(
        and(
          eq(ledgerSourceClaim.expenseId, row.id),
          notDeleted(ledgerSourceClaim),
        ),
      ),
  ]);
  return {
    name: original.name,
    cost: original.cost,
    costType: original.costType,
    trade: original.trade,
    spendingCategoryId: original.spendingCategoryId,
    projectId: original.projectId,
    productId: original.productId,
    productName: original.productName,
    productQuantity: original.productQuantity,
    purchaseId: original.purchaseId,
    unitemized: original.lineBasis === "allocation",
    hasAttribution: (attributions[0]?.total ?? 0) > 0,
    imported: (sourceClaims[0]?.total ?? 0) > 0,
  };
}

type CandidatesInput = z.output<typeof purchaseLinkExpensesCandidatesInput>;
type CandidatesOut = z.output<typeof purchaseLinkExpensesCandidatesOut>;

/** Expenses worth attaching to a purchase for a scope and search, as the dialogs list them. */
export async function listLinkExpenseCandidates(
  db: Database,
  input: CandidatesInput,
): Promise<CandidatesOut> {
  const target = await getPurchaseByShortcode(db, input.purchaseId);
  if (!target) throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  const page = await expenseList(
    db,
    expenseFiltersForScope(input.scope, target.vendorId, input.search),
    [{ orderBy: "date", direction: "desc" }],
    { pageIndex: 0, pageSize: LINK_CANDIDATE_LIMIT },
  );
  return {
    scopes: LINK_EXPENSE_SCOPES,
    ...composeLinkExpenseCandidates(input.purchaseId, page.data),
  };
}

type CheckInput = z.output<typeof purchaseLinkExpensesCheckInput>;
type CheckOut = z.output<typeof purchaseLinkExpensesCheckOut>;

/** Whether the selection can be attached, and what that does to the purchase's total. */
export async function checkLinkExpensesFor(
  db: Database,
  input: CheckInput,
): Promise<CheckOut> {
  const target = await getPurchaseByShortcode(db, input.purchaseId);
  if (!target) throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  const requested = [...new Set(input.expenseIds)];
  const rows =
    requested.length === 0
      ? []
      : await getDb(db)
          .select({
            id: expense.shortcode,
            cost: expense.cost,
            purchaseId: purchase.shortcode,
          })
          .from(expense)
          .leftJoin(
            purchase,
            and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
          )
          .where(
            and(inArray(expense.shortcode, requested), notDeleted(expense)),
          );
  return checkLinkExpenses(
    {
      id: target.id,
      expenseTotal: target.expenseTotal,
      unpricedExpenseCount: target.unpricedExpenseCount,
    },
    rows.map((row) => ({
      id: parseShortcodeFor("expense", row.id),
      cost: row.cost,
      purchaseId: row.purchaseId
        ? parseShortcodeFor("purchase", row.purchaseId)
        : null,
    })),
    requested,
  );
}

/** The products already attached on purpose; derived ones (from itemized expenses) are not. */
export async function explicitlyAttachedProductIds(
  db: Database,
  purchaseId: PurchaseShortcode,
): Promise<Set<ProductShortcode>> {
  return new Set(
    (
      await listPurchaseProducts(
        db,
        await resolveOrThrow(db, "purchase", purchaseId),
      )
    )
      .filter((item) => item.linkAttachedAt !== null)
      .map((item) => item.productId),
  );
}

type SplitCheckInput = z.output<typeof purchaseSplitCheckInput>;
type SplitCheckOut = z.output<typeof purchaseSplitCheckOut>;

/**
 * The split form's check: the pure rules of `checkSplitDraft`, then the same per-part checks the
 * write makes — the project exists, only a principal line carries a product, and the part's
 * trade and project resolve (`validateExpenseInheritance`). A split this accepts is one the write
 * accepts; the write still validates on its own.
 */
export async function checkSplitFor(
  db: Database,
  input: SplitCheckInput,
): Promise<SplitCheckOut> {
  const original = await loadSplitOriginal(db, input.expenseId);
  const result = checkSplitDraft(original, input);
  const body = result.split;
  if (!body || !original.purchaseId) return result;
  try {
    const purchaseId = await resolveOrThrow(
      db,
      "purchase",
      original.purchaseId,
    );
    for (const [index, part] of body.parts.entries()) {
      const where = `Part ${index + 1}`;
      try {
        const productId = part.productId
          ? await resolveOrThrow(db, "product", part.productId)
          : null;
        const lineKind = inferExpenseLineKind({ name: part.name, productId });
        const classification = resolveSplitPartClassification({
          originalSpendingCategoryId: original.spendingCategoryId,
          lineKind,
          partSpendingCategoryId: part.spendingCategoryId,
        });
        assertClassificationPolicies("expense", {
          ...classification,
          productId,
        });
        await validateExpenseInheritance(db, {
          lineKind,
          projectId: part.projectId
            ? await resolveOrThrow(db, "project", part.projectId)
            : null,
          productId,
          purchaseId,
          trade: part.trade,
        });
      } catch (error) {
        if (error instanceof AppError)
          return {
            ...result,
            split: null,
            reason: `${where}: ${error.message}`,
          };
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof AppError)
      return { ...result, split: null, reason: error.message };
    throw error;
  }
  return result;
}
