import type { ActorContext } from "@cubby/schemas/context";
import {
  type FinancialTransactionKind,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import {
  type FinancialTransactionId,
  type PurchaseId,
  type PurchaseShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { financialTransactionAllocation, purchase } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import { notDeleted } from "~/server/repo/database-helpers";
import { cents } from "~/server/repo/money";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

/**
 * How much of one settlement transaction settled one Purchase.
 *
 * The invariant every path here upholds: a live transaction has EITHER zero live
 * allocations (unlinked evidence) OR live allocations that sum to its own amount
 * to the cent and share its sign. It is enforced in this module rather than by a
 * constraint because a row-level CHECK cannot see sibling rows, and because
 * `drizzle-kit push` cannot diff a CHECK edit anyway.
 * `findFinancialTransactionAllocationDefects` is the after-the-fact audit.
 */

export type AllocationInput = {
  purchaseId: PurchaseId;
  amount: number;
};

type AllocationRow = {
  purchaseId: PurchaseId;
  purchaseShortcode: PurchaseShortcode;
  amount: number;
};

/** Allocations per transaction, for the audit diff and the quality-target union. */
export type AllocationSnapshot = Map<FinancialTransactionId, AllocationRow[]>;

/** Stable, readable audit payload: `["PUR-TSTA:-10.00", "PUR-TSTB:-5.00"]`. */
const allocationAuditRows = (rows: readonly AllocationRow[]) =>
  rows.map((row) => `${row.purchaseShortcode}:${row.amount.toFixed(2)}`).sort();

export async function readAllocations(
  tx: DrizzleTransaction,
  transactionIds: readonly FinancialTransactionId[],
): Promise<AllocationSnapshot> {
  const snapshot: AllocationSnapshot = new Map();
  if (transactionIds.length === 0) return snapshot;
  const rows = await tx
    .select({
      transactionId: financialTransactionAllocation.transactionId,
      purchaseId: financialTransactionAllocation.purchaseId,
      purchaseShortcode: purchase.shortcode,
      amount: financialTransactionAllocation.amount,
    })
    .from(financialTransactionAllocation)
    .innerJoin(
      purchase,
      eq(purchase.id, financialTransactionAllocation.purchaseId),
    )
    .where(
      and(
        inArray(financialTransactionAllocation.transactionId, [
          ...transactionIds,
        ]),
        notDeleted(financialTransactionAllocation),
      ),
    );
  for (const row of rows) {
    const list = snapshot.get(row.transactionId) ?? [];
    list.push({
      purchaseId: row.purchaseId,
      purchaseShortcode: parseShortcodeFor("purchase", row.purchaseShortcode),
      amount: Number(row.amount),
    });
    snapshot.set(row.transactionId, list);
  }
  return snapshot;
}

/**
 * The four follow-ups every allocation change owes, in one place.
 *
 * Callers mutate allocation rows however their operation requires — a whole-set
 * replace, a purchase delete dropping them, a merge summing them — then hand the
 * before-snapshot here. Routing all of them through one function is deliberate:
 * these are exactly the removal-path obligations that get missed when each caller
 * re-implements them, and the repo's own guidance is to make such a cascade
 * structural rather than guarded.
 *
 * Returns the transactions whose allocations actually moved, so the caller can
 * refresh their embeddings after commit — a transaction's embedding text carries
 * the vendor and order id resolved through its purchase, so a moved allocation
 * changes it.
 */
export async function applyAllocationChanges(
  tx: DrizzleTransaction,
  opts: {
    transactionIds: readonly FinancialTransactionId[];
    before: AllocationSnapshot;
    actor: ActorContext;
  },
): Promise<{
  changedTransactionIds: FinancialTransactionId[];
  affectedPurchaseIds: PurchaseId[];
}> {
  const ids = uniq([...opts.transactionIds]);
  if (ids.length === 0)
    return { changedTransactionIds: [], affectedPurchaseIds: [] };

  const after = await readAllocations(tx, ids);

  const changedTransactionIds: FinancialTransactionId[] = [];
  for (const id of ids) {
    const from = allocationAuditRows(opts.before.get(id) ?? []);
    const to = allocationAuditRows(after.get(id) ?? []);
    if (from.length === to.length && from.every((v, i) => v === to[i]))
      continue;
    changedTransactionIds.push(id);
    await logAuditEntry(tx, opts.actor, {
      entityType: "financialTransaction",
      entityId: id,
      action: "update",
      changes: { allocations: { from, to } },
    });
  }

  const affectedPurchaseIds = uniq(
    ids.flatMap((id) => [
      ...(opts.before.get(id) ?? []).map((row) => row.purchaseId),
      ...(after.get(id) ?? []).map((row) => row.purchaseId),
    ]),
  );
  if (affectedPurchaseIds.length > 0)
    await touchDataQualityTargets(tx, { purchaseIds: affectedPurchaseIds });

  return { changedTransactionIds, affectedPurchaseIds };
}

/**
 * Validate a proposed allocation set against its transaction. Shared by the
 * replace path and by `updateFinancialTransaction`'s amount-change branch.
 */
export function assertAllocationSetValid(value: {
  transactionAmount: number;
  kind: FinancialTransactionKind;
  next: readonly AllocationInput[];
}): void {
  const { next, transactionAmount } = value;
  if (uniq(next.map((row) => row.purchaseId)).length !== next.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A transaction cannot allocate to the same Purchase twice; combine them into one slice.",
    );

  for (const row of next) {
    if (cents(row.amount) === 0)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "An allocation of zero says nothing — remove it instead.",
      );
    // Mixed signs are unsupported on purpose. Same-sign is what makes "sums to
    // the amount" a decomposition rather than an arbitrary set of numbers that
    // happens to add up: a +1000/-995 pair netting 5 would assert 1000 of
    // settlement against one purchase. A genuinely two-directional event is two
    // transactions, which is how the statement shows it anyway.
    if (Math.sign(row.amount) !== Math.sign(transactionAmount))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Every allocation must carry the same sign as its transaction. A charge and a credit are two settlement events; record them as two transactions.",
      );
  }

  if (next.length === 0) return;
  const total = next.reduce((sum, row) => sum + cents(row.amount), 0);
  if (total !== cents(transactionAmount))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Allocations must sum to the transaction amount: got ${(total / 100).toFixed(2)}, expected ${transactionAmount.toFixed(2)}.`,
    );

  const violation = financialTransactionSettlementViolation({
    linked: next.length > 0,
    kind: value.kind,
    amount: transactionAmount,
  });
  if (violation)
    throw createAppError("CONSTRAINT_VIOLATION", violation.message);
}

/**
 * Assert every Purchase in a proposed set is still live, under FOR SHARE.
 *
 * Shared, and share-locked rather than plainly read, because purchase delete
 * takes FOR UPDATE on these rows — an unlocked check could let an allocation be
 * written against a purchase mid-delete.
 */
export async function assertPurchasesLive(
  tx: DrizzleTransaction,
  purchaseIds: readonly PurchaseId[],
): Promise<void> {
  const wanted = uniq([...purchaseIds]);
  if (wanted.length === 0) return;
  const live = await tx
    .select({ id: purchase.id })
    .from(purchase)
    .where(and(inArray(purchase.id, wanted), notDeleted(purchase)))
    .for("share");
  if (live.length !== wanted.length)
    throw createAppError(
      "PURCHASE_NOT_FOUND",
      "One or more Purchases in this allocation set no longer exist.",
    );
}

/**
 * Diff the set rather than delete-and-reinsert: a blanket rewrite would reset
 * `createdAt` on slices that did not change and make the audit diff unreadable.
 */
export async function writeAllocationSet(
  tx: DrizzleTransaction,
  transactionId: FinancialTransactionId,
  next: readonly AllocationInput[],
  before: AllocationSnapshot,
): Promise<void> {
  const existing = before.get(transactionId) ?? [];
  const nextByPurchase = new Map(next.map((row) => [row.purchaseId, row]));
  const removed = existing.filter((row) => !nextByPurchase.has(row.purchaseId));

  if (removed.length > 0)
    await tx
      .update(financialTransactionAllocation)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(financialTransactionAllocation.transactionId, transactionId),
          inArray(
            financialTransactionAllocation.purchaseId,
            removed.map((row) => row.purchaseId),
          ),
          notDeleted(financialTransactionAllocation),
        ),
      );

  const existingByPurchase = new Map(
    existing.map((row) => [row.purchaseId, row]),
  );
  for (const row of next) {
    const prior = existingByPurchase.get(row.purchaseId);
    if (!prior) {
      await tx.insert(financialTransactionAllocation).values({
        transactionId,
        purchaseId: row.purchaseId,
        amount: row.amount,
      });
      continue;
    }
    if (cents(prior.amount) !== cents(row.amount))
      await tx
        .update(financialTransactionAllocation)
        .set({ amount: row.amount, updatedAt: new Date() })
        .where(
          and(
            eq(financialTransactionAllocation.transactionId, transactionId),
            eq(financialTransactionAllocation.purchaseId, row.purchaseId),
            notDeleted(financialTransactionAllocation),
          ),
        );
  }
}

/** Resolve caller-supplied `PUR-` codes to ids, preserving order. */
export async function resolveAllocationInputs(
  db: Database | DrizzleTransaction,
  rows: readonly { purchaseId: PurchaseShortcode; amount: number }[],
): Promise<AllocationInput[]> {
  if (rows.length === 0) return [];
  const ids = await resolveAllOrThrow(
    db,
    "purchase",
    rows.map((row) => row.purchaseId),
  );
  // resolveAllOrThrow throws naming every missing code, so the pairing is total.
  return rows.map((row, index) => ({
    purchaseId: ids[index]!,
    amount: row.amount,
  }));
}

/** Live allocation count per transaction — the "is this split?" question. */
export async function countLiveAllocations(
  tx: DrizzleTransaction,
  transactionId: FinancialTransactionId,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.transactionId, transactionId),
        notDeleted(financialTransactionAllocation),
      ),
    );
  return Number(row?.count ?? 0);
}

/** Transactions holding a live allocation against any of these purchases. */
export async function transactionIdsAllocatedTo(
  tx: DrizzleTransaction,
  purchaseIds: readonly PurchaseId[],
): Promise<FinancialTransactionId[]> {
  if (purchaseIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({
      transactionId: financialTransactionAllocation.transactionId,
    })
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(financialTransactionAllocation.purchaseId, [...purchaseIds]),
        notDeleted(financialTransactionAllocation),
      ),
    );
  return rows.map((row) => row.transactionId);
}

/**
 * The single Purchase a transaction's search/embedding subtitle should name,
 * picked deterministically from its live allocations.
 *
 * A correlated scalar rather than a joined subquery so it drops into an existing
 * leftJoin without a subquery alias. Lowest purchase id wins; for the ordinary
 * single-allocation transaction that is simply "its purchase".
 */
export const solePurchaseForTransaction = sql`(
  SELECT spa."purchaseId" FROM "FinancialTransactionAllocation" spa
  WHERE spa."transactionId" = "FinancialTransaction"."id"
    AND spa."deletedAt" IS NULL
  ORDER BY spa."purchaseId"
  LIMIT 1
)`;
