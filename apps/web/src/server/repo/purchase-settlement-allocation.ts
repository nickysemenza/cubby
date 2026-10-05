import {
  type PurchaseShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { SettlementAllocationDraft } from "@cubby/schemas/purchase";

import { formatCurrency } from "~/lib/utils";
import { cents, dollars } from "~/server/repo/money";

/**
 * The allocation form's rules, kept on the server so web and native share one
 * answer. All arithmetic is in integer cents: `0.1 + 0.2` is not `0.3`, and a
 * settlement that is off by a cent must never read as complete.
 */
/** `4250` -> `"42.50"`, the form the amount input takes; no float formatting involved. */
const centsToInput = (value: number) => {
  const magnitude = Math.abs(value);
  return `${value < 0 ? "-" : ""}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
};

/**
 * The first rows to show once a statement entry is chosen: a charge is
 * allocated to this Purchase up to its stated total and the rest is left for
 * another Purchase (a charge can settle several orders). A refund is never
 * capped by the stated total.
 */
export function proposeSettlementAllocations(
  purchaseId: string,
  transaction: { amount: number; kind: string },
  purchase: { statedTotal: number | null },
): SettlementAllocationDraft[] {
  const totalCents = cents(transaction.amount);
  const statedCents = cents(purchase.statedTotal ?? 0);
  const firstCents =
    transaction.kind === "purchase" && statedCents > 0
      ? Math.min(totalCents, statedCents)
      : totalCents;
  const rows = [
    { purchaseId, amount: centsToInput(firstCents) },
  ] satisfies SettlementAllocationDraft[];
  if (firstCents !== totalCents)
    rows.push({
      purchaseId: "",
      amount: centsToInput(totalCents - firstCents),
    });
  return rows;
}

export interface SettlementAllocationCheck {
  /** The typed rows to save, or null while the draft cannot be saved. */
  allocations: { purchaseId: PurchaseShortcode; amount: number }[] | null;
  /** Dollars the valid rows add up to. */
  allocatedTotal: number;
  /** Dollars still to allocate (negative when over-allocated). */
  remaining: number;
  /** Why the draft cannot be saved; null when it can. */
  reason: string | null;
}

const rowLabel = (index: number) => `Row ${index + 1}`;

export function checkSettlementAllocationDraft(
  rows: readonly SettlementAllocationDraft[],
  transactionAmount: number,
): SettlementAllocationCheck {
  const totalCents = cents(transactionAmount);
  const parsed: { purchaseId: PurchaseShortcode; cents: number }[] = [];
  const seen = new Set<string>();
  let allocatedCents = 0;
  let reason: string | null = null;
  const refuse = (message: string) => {
    reason ??= message;
  };

  if (rows.length === 0) refuse("Add at least one Purchase.");
  rows.forEach((row, index) => {
    const code = purchaseShortcode.safeParse(row.purchaseId.trim());
    if (!code.success) {
      refuse(`${rowLabel(index)}: enter a Purchase code such as PUR-4K7M.`);
      return;
    }
    const purchaseId = code.data;
    const amount = Number(row.amount);
    const amountCents = cents(amount);
    if (
      !row.amount.trim() ||
      !Number.isSafeInteger(amountCents) ||
      amountCents === 0
    ) {
      refuse(`${rowLabel(index)}: enter a non-zero amount.`);
      return;
    }
    if (Math.abs(amount * 100 - amountCents) > 0.000001) {
      refuse(`${rowLabel(index)}: amounts are whole cents.`);
      return;
    }
    if (Math.sign(amountCents) !== Math.sign(totalCents)) {
      refuse(
        `${rowLabel(index)}: the amount must have the same sign as the ${formatCurrency(transactionAmount)} statement entry.`,
      );
      return;
    }
    if (seen.has(purchaseId)) {
      refuse(`${rowLabel(index)}: ${purchaseId} is already allocated above.`);
      return;
    }
    seen.add(purchaseId);
    allocatedCents += amountCents;
    parsed.push({ purchaseId, cents: amountCents });
  });

  if (reason === null && allocatedCents !== totalCents)
    reason = `Allocations total ${formatCurrency(dollars(allocatedCents))}, not ${formatCurrency(transactionAmount)}.`;

  return {
    allocations:
      reason === null
        ? parsed.map((allocation) => ({
            purchaseId: allocation.purchaseId,
            amount: dollars(allocation.cents),
          }))
        : null,
    allocatedTotal: dollars(allocatedCents),
    remaining: dollars(totalCents - allocatedCents),
    reason,
  };
}
