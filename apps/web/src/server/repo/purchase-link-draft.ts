import type {
  ExpenseShortcode,
  ProductShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseFilters, Trade } from "@cubby/schemas/project";
import type {
  LinkExpenseScope,
  purchaseLinkExpensesCandidatesOut,
  purchaseLinkExpensesCheckOut,
  purchaseLinkProductsCandidatesOut,
} from "@cubby/schemas/purchase";
import type { z } from "zod";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/utils";

/**
 * The rules of the two attach dialogs, kept on the server so web and native offer the same
 * candidates and make the same promises. Attaching moves ledger rows between purchases, so the
 * totals are whole cents and an expense with no cost stays unknown (it adds nothing, and is
 * counted out loud).
 */

export const LINK_EXPENSE_SCOPES: z.output<
  typeof purchaseLinkExpensesCandidatesOut
>["scopes"] = [
  { value: "vendorOrUnattached", label: "This vendor or unattached" },
  { value: "unattached", label: "Unattached expenses only" },
  { value: "any", label: "Any expense" },
];

/** The page of candidates, as many as either dialog has ever shown. */
export const LINK_CANDIDATE_LIMIT = 100;
export const LINK_PRODUCT_LIMIT = 50;

/**
 * Which expenses the list reads for a scope. "Vendor or unattached" is one filter, not an
 * impossible conjunction: the expense list ORs the vendor with the unattached sentinel.
 */
export const expenseFiltersForScope = (
  scope: LinkExpenseScope,
  vendorId: VendorShortcode,
  search: string | undefined,
): ExpenseFilters => {
  const term = search?.trim() || undefined;
  switch (scope) {
    case "vendorOrUnattached":
      return {
        vendorId,
        vendorPresenceFilter: "none",
        search: term,
      };
    case "unattached":
      return { vendorPresenceFilter: "none", search: term };
    case "any":
      return { search: term };
  }
};

/** The expense list's fields an attach candidate is worded from. */
export interface LinkExpenseRow {
  id: ExpenseShortcode;
  name: string;
  date: string | null;
  cost: number | null;
  trade: Trade | null;
  projectId: ProjectShortcode | null;
  projectName: string | null;
  purchaseId: PurchaseShortcode | null;
  vendor: string | null;
}

type CandidatesOut = z.output<typeof purchaseLinkExpensesCandidatesOut>;

const CAUTION =
  "A payment schedule is not one Purchase — separate transactions stay separate Purchases. Attaching an already-filed expense moves it off its current purchase.";

export function composeLinkExpenseCandidates(
  purchaseId: PurchaseShortcode,
  rows: readonly LinkExpenseRow[],
): Pick<CandidatesOut, "candidates" | "message" | "caution"> {
  const candidates = rows
    .filter((row) => row.purchaseId !== purchaseId)
    .map((row): CandidatesOut["candidates"][number] => {
      const filed = row.purchaseId !== null;
      const current = filed ? (row.vendor ?? "another purchase") : "unattached";
      return {
        id: row.id,
        name: row.name,
        date: row.date,
        cost: row.cost,
        trade: row.trade,
        projectId: row.projectId,
        projectName: row.projectName,
        current,
        filed,
        summary: [
          row.date ? formatCalendarDay(row.date, "dateShort") : null,
          row.cost === null ? "no cost recorded" : formatCurrency(row.cost),
          row.trade,
          row.projectName,
          filed ? `on ${current}` : "unattached",
        ]
          .filter((part) => part !== null && part !== "")
          .join(" · "),
      };
    });
  return {
    candidates,
    message:
      candidates.length === 0
        ? "Nothing matches this scope. Widen it to any expense, or clear the search."
        : null,
    caution: CAUTION,
  };
}

type CheckOut = z.output<typeof purchaseLinkExpensesCheckOut>;

const toCents = (dollars: number) => Math.round(dollars * 100);

const countLabel = (count: number) =>
  `${count} expense${count === 1 ? "" : "s"}`;

/**
 * Whether a selection can be attached, and what attaching does to the purchase's expense total.
 * `lines` are the live expenses that exist among the requested ids.
 */
export function checkLinkExpenses(
  purchase: { id: PurchaseShortcode; expenseTotal: number },
  lines: readonly {
    id: ExpenseShortcode;
    cost: number | null;
    purchaseId: PurchaseShortcode | null;
  }[],
  requested: readonly ExpenseShortcode[],
): CheckOut {
  const ids = [...new Set(requested)];
  const refused = (reason: string): CheckOut => ({
    expenseIds: null,
    selectedCount: ids.length,
    selectedTotal: 0,
    resultingTotal: null,
    movedCount: 0,
    reason,
    note: null,
    confirm: null,
  });
  if (ids.length === 0) return refused("Select at least one expense.");

  const byId = new Map(lines.map((line) => [line.id, line]));
  const selected = ids.map((id) => byId.get(id));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return refused(
      `${missing.join(", ")} no longer exists. Refresh the list and select again.`,
    );
  const present = selected.flatMap((line) => (line ? [line] : []));
  const already = present.filter((line) => line.purchaseId === purchase.id);
  if (already.length > 0)
    return refused(
      `${already.map((line) => line.id).join(", ")} is already on this purchase.`,
    );

  const totalCents = present.reduce(
    (sum, line) => sum + (line.cost === null ? 0 : toCents(line.cost)),
    0,
  );
  const unpriced = present.filter((line) => line.cost === null).length;
  const movedCount = present.filter((line) => line.purchaseId !== null).length;
  const selectedTotal = totalCents / 100;
  return {
    expenseIds: ids,
    selectedCount: ids.length,
    selectedTotal,
    resultingTotal: (toCents(purchase.expenseTotal) + totalCents) / 100,
    movedCount,
    reason: null,
    note: `${countLabel(ids.length)} selected · ${formatCurrency(selectedTotal)}${
      unpriced > 0 ? ` · ${unpriced} without a cost` : ""
    }. Purchase expense total would go to ${formatCurrency((toCents(purchase.expenseTotal) + totalCents) / 100)}.`,
    confirm:
      movedCount > 0
        ? `Attaching moves ${countLabel(movedCount)} off ${movedCount === 1 ? "its" : "their"} current purchase.`
        : null,
  };
}

type ProductsOut = z.output<typeof purchaseLinkProductsCandidatesOut>;
type LinkProductRow = ProductsOut["candidates"][number];

/**
 * Products worth attaching: everything the search returned except what is already attached
 * explicitly. `purchase.products` also lists products derived from this order's itemized
 * expenses; those are not attached, so hiding them would hide exactly the products still worth
 * linking.
 */
export function composeLinkProductCandidates(
  found: readonly LinkProductRow[],
  attachedIds: ReadonlySet<ProductShortcode>,
  limit: number,
): ProductsOut {
  const candidates = found
    .filter((item) => !attachedIds.has(item.id))
    .slice(0, limit)
    // Only what the picker shows: the search rows carry more than a client should receive here.
    .map(({ id, name, manufacturer, price, coverImageUrl }) => ({
      id,
      name,
      manufacturer,
      price,
      coverImageUrl,
    }));
  return {
    candidates,
    message:
      candidates.length === 0
        ? "Adjust the search, or every match is already attached."
        : null,
    note: "Record which products this purchase bought. The link carries no money or quantity — spend stays on the purchase's Expenses.",
  };
}
