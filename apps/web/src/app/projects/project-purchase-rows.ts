import type {
  ExpenseShortcode,
  ProjectShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseOut } from "@cubby/schemas/purchase";

import { purchaseIdentityLabel } from "~/lib/purchase-label";

/**
 * A row in the project's Purchases table: a Purchase, or one of the Expense
 * lines it charged to THIS project nested beneath it.
 *
 * A discriminated union rather than one widened shape, for the same reason as
 * the wishlist's rows: every column has to say what it renders for an expense
 * line, because a purchase-level reconciliation verdict on an expense row would
 * be a category error, not a blank cell.
 *
 * `linesOnProject` / `expenseCount` are carried on the parent so the table can
 * disclose a partly-shared charge. A Purchase reaches this table because ONE of
 * its lines landed on this project; the rest may sit on other projects or on no
 * project at all, and a bare "$412.60" with three visible lines reads as if the
 * whole charge landed here.
 */
export type ProjectPurchaseRow =
  | {
      kind: "purchase";
      id: PurchaseShortcode;
      name: string;
      /** Flattened onto both variants so one date column serves the whole tree. */
      date: string | null;
      purchase: PurchaseOut;
      /** Lines of this purchase charged to this project. */
      linesOnProject: number;
      /** Their summed cost — NOT `purchase.expenseTotal`, which spans projects. */
      projectSpend: number;
      subRows?: ProjectPurchaseRow[];
    }
  | {
      kind: "expense";
      id: string;
      name: string;
      date: string | null;
      expenseId: ExpenseShortcode;
      expense: ExpenseOut;
    };

/**
 * Nest each purchase's project-scoped expense lines beneath it.
 *
 * A purchase whose lines aren't in `expenses` (the caller's set is the
 * project's own ledger, which a freshly-linked expense may not have reached
 * yet) gets no `subRows`, so TanStack's `getCanExpand()` is false and the name
 * column renders its leaf spacer instead of a chevron that opens nothing.
 */
export const buildProjectPurchaseRows = (
  purchases: readonly PurchaseOut[],
  expenses: readonly ExpenseOut[],
  projectId: ProjectShortcode,
): ProjectPurchaseRow[] => {
  const byPurchase = new Map<PurchaseShortcode, ExpenseOut[]>();
  for (const expense of expenses) {
    if (expense.purchaseId === null) continue;
    if (expense.projectId !== projectId) continue;
    const group = byPurchase.get(expense.purchaseId) ?? [];
    group.push(expense);
    byPurchase.set(expense.purchaseId, group);
  }

  return purchases.map((purchase) => {
    const lines = byPurchase.get(purchase.id) ?? [];
    const row: Extract<ProjectPurchaseRow, { kind: "purchase" }> = {
      kind: "purchase",
      id: purchase.id,
      name: purchaseIdentityLabel(purchase),
      date: purchase.date,
      purchase,
      linesOnProject: lines.length,
      projectSpend: lines.reduce((total, line) => total + (line.cost ?? 0), 0),
    };
    if (lines.length > 0) {
      row.subRows = lines.map((expense) => ({
        kind: "expense",
        // One Expense belongs to exactly one Purchase, but namespacing keeps
        // row ids unambiguous if that ever stops being true.
        id: `${purchase.id}:${expense.id}`,
        name: expense.name,
        date: expense.date,
        expenseId: expense.id,
        expense,
      }));
    }
    return row;
  });
};

export const projectPurchaseSubRows = (
  row: ProjectPurchaseRow,
): ProjectPurchaseRow[] | undefined =>
  row.kind === "purchase" ? row.subRows : undefined;
