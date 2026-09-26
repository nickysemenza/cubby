import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ExpenseShortcode,
} from "@cubby/schemas/identifiers";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  photoGroupProposal,
  product,
  purchase,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { updateExpense } from "~/server/repo/expense/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

async function committedGroup(db: Database, runId: string, groupKey: string) {
  const id = await resolveOrThrow(db, "run", runId);
  const [group] = await getDb(db)
    .select({
      productId: photoGroupProposal.productId,
      productName: product.name,
      productCode: product.shortcode,
    })
    .from(photoGroupProposal)
    .innerJoin(
      product,
      and(eq(photoGroupProposal.productId, product.id), notDeleted(product)),
    )
    .where(
      and(
        eq(photoGroupProposal.runId, id),
        eq(photoGroupProposal.groupKey, groupKey),
        eq(photoGroupProposal.state, "committed"),
      ),
    )
    .limit(1);
  if (!group?.productId)
    throw new Error("A committed group with a live Product is required");
  return group;
}

/** Bounded, source-backed lines the reviewer may choose to attribute after approval. */
export async function linkablePhotoGroupExpenses(
  db: Database,
  input: { runId: string; groupKey: string; search?: string },
) {
  const group = await committedGroup(db, input.runId, input.groupKey);
  const query = input.search?.trim() || group.productName;
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3)
    .slice(0, 4);
  const patterns = words.length ? words : [query];
  const rows = await getDb(db)
    .select({
      id: expense.shortcode,
      name: expense.name,
      date: expense.date,
      cost: expense.cost,
      productQuantity: expense.productQuantity,
      purchaseId: purchase.shortcode,
      purchaseLabel: purchase.displayLabel,
    })
    .from(expense)
    .leftJoin(
      purchase,
      and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
    )
    .where(
      and(
        notDeleted(expense),
        isNull(expense.productId),
        eq(expense.lineKind, "principal"),
        eq(expense.lineBasis, "item_line"),
        or(
          ...patterns.map((word) =>
            ilike(expense.name, `%${word.replace(/[\\%_]/g, "\\$&")}%`),
          ),
        ),
      ),
    )
    .orderBy(desc(expense.date), desc(expense.id))
    .limit(25);
  return {
    productId: parseShortcodeFor("product", group.productCode),
    productName: group.productName,
    lines: rows.map((row) => ({
      expenseId: parseShortcodeFor("expense", row.id),
      name: row.name,
      date: row.date,
      cost: row.cost,
      productQuantity: row.productQuantity,
      purchaseId: row.purchaseId
        ? parseShortcodeFor("purchase", row.purchaseId)
        : null,
      purchaseLabel: row.purchaseLabel,
      expectedQuantityDelta:
        row.productQuantity == null
          ? null
          : row.cost != null && row.cost < 0
            ? -Math.abs(row.productQuantity)
            : row.cost != null && row.cost > 0
              ? Math.abs(row.productQuantity)
              : row.productQuantity,
    })),
  };
}

/** Locks the exact line and group, then reuses the normal Expense write and audit path. */
export async function linkPhotoGroupExpense(
  db: Database,
  input: { runId: string; groupKey: string; expenseId: string },
  actor: ActorContext,
) {
  return withTransactionDatabase(db, async (txDb) => {
    const group = await committedGroup(txDb, input.runId, input.groupKey);
    const lineId = await resolveOrThrow(txDb, "expense", input.expenseId);
    const [line] = await getDb(txDb)
      .select({
        id: expense.id,
        productId: expense.productId,
        lineKind: expense.lineKind,
        lineBasis: expense.lineBasis,
      })
      .from(expense)
      .where(and(eq(expense.id, lineId), notDeleted(expense)))
      .for("update")
      .limit(1);
    if (
      !line ||
      line.productId ||
      line.lineKind !== "principal" ||
      line.lineBasis !== "item_line"
    )
      throw new Error(
        "Expense line must be live, eligible, and still unlinked",
      );
    // SAFETY: the input contract parses an Expense shortcode before this action.
    const expenseId = parseShortcodeFor(
      "expense",
      input.expenseId,
    ) as ExpenseShortcode;
    await updateExpense(
      txDb,
      expenseId,
      { productId: parseShortcodeFor("product", group.productCode) },
      actor,
    );
    return {
      expenseId,
      productId: parseShortcodeFor("product", group.productCode),
    };
  });
}
