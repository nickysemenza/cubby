import type { ActorContext } from "@cubby/schemas/context";
import { type FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  type FinancialTransactionId,
  type PurchaseId,
  type PurchaseShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { moneyToMinor } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { notDeleted, touchUpdatedAt } from "~/server/db/helpers";
import { financialTransactionAllocation, purchase } from "~/server/db/schema";
import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import { insertPurchaseEventRows } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  logAuditEntries,
} from "~/server/generic/audit-log/repo/audit-log";
import { resolveAllOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

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
  confirmsMerchant?: boolean;
};

type AllocationRow = {
  purchaseId: PurchaseId;
  purchaseShortcode: PurchaseShortcode;
  amount: number;
  confirmsMerchant: boolean;
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
      amount: minorToDollarsSql(
        financialTransactionAllocation.amountMinor,
        "numeric",
      ).mapWith(Number),
      confirmsMerchant: financialTransactionAllocation.confirmsMerchant,
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
      confirmsMerchant: row.confirmsMerchant,
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
  const { changedTransactionIds, audits } = allocationChangeAudits(
    ids,
    opts.before,
    after,
  );
  await logAuditEntries(tx, opts.actor, audits);

  const affectedPurchaseIds = uniq(
    ids.flatMap((id) => [
      ...(opts.before.get(id) ?? []).map((row) => row.purchaseId),
      ...(after.get(id) ?? []).map((row) => row.purchaseId),
    ]),
  );
  if (affectedPurchaseIds.length > 0)
    await touchUpdatedAt(tx, purchase, affectedPurchaseIds);

  return { changedTransactionIds, affectedPurchaseIds };
}

/** The allocation audit each changed transaction owes, from its before and after sets. */
export function allocationChangeAudits(
  ids: readonly FinancialTransactionId[],
  before: AllocationSnapshot,
  after: AllocationSnapshot,
) {
  const changedTransactionIds: FinancialTransactionId[] = [];
  const audits: AuditEntryInput[] = [];
  for (const id of ids) {
    const from = allocationAuditRows(before.get(id) ?? []);
    const to = allocationAuditRows(after.get(id) ?? []);
    const confirmedBefore = (before.get(id) ?? [])
      .filter((row) => row.confirmsMerchant)
      .map((row) => row.purchaseShortcode)
      .sort();
    const confirmedAfter = (after.get(id) ?? [])
      .filter((row) => row.confirmsMerchant)
      .map((row) => row.purchaseShortcode)
      .sort();
    if (
      from.length === to.length &&
      from.every((v, i) => v === to[i]) &&
      JSON.stringify(confirmedBefore) === JSON.stringify(confirmedAfter)
    )
      continue;
    changedTransactionIds.push(id);
    audits.push({
      entityKind: "financialTransaction",
      entityId: id,
      action: "update",
      changes: {
        allocations: { from, to },
        merchantConfirmations: { from: confirmedBefore, to: confirmedAfter },
      },
    });
  }
  return { changedTransactionIds, audits };
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
  const violation = allocationSetViolation({
    transactionAmountMinor: moneyToMinor(value.transactionAmount),
    kind: value.kind,
    next: value.next.map((row) => ({
      purchaseId: row.purchaseId,
      amountMinor: moneyToMinor(row.amount),
    })),
  });
  if (violation) throw createAppError("CONSTRAINT_VIOLATION", violation);
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
  actor: ActorContext,
): Promise<void> {
  await writeAllocationSets(tx, [{ transactionId, next }], before, actor);
}

/** `writeAllocationSet` for several transactions; new slices share one insert. */
export async function writeAllocationSets(
  tx: DrizzleTransaction,
  sets: readonly {
    transactionId: FinancialTransactionId;
    next: readonly AllocationInput[];
  }[],
  before: AllocationSnapshot,
  actor: ActorContext,
): Promise<void> {
  const inserts: (typeof financialTransactionAllocation.$inferInsert)[] = [];
  for (const { transactionId, next } of sets)
    inserts.push(
      ...(await writeChangedAllocations(
        tx,
        transactionId,
        next,
        before,
        actor,
      )),
    );
  if (inserts.length)
    await insertPurchaseEventRows(
      tx,
      "FinancialTransactionAllocation",
      inserts,
    );
}

/** Applies removals and changed slices; returns the new slices to insert. */
async function writeChangedAllocations(
  tx: DrizzleTransaction,
  transactionId: FinancialTransactionId,
  next: readonly AllocationInput[],
  before: AllocationSnapshot,
  actor: ActorContext,
) {
  const inserts: (typeof financialTransactionAllocation.$inferInsert)[] = [];
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
    const confirmsMerchant = allocationConfirmsMerchant(prior, row, actor);
    if (!prior) {
      inserts.push({
        transactionId,
        purchaseId: row.purchaseId,
        amountMinor: moneyToMinor(row.amount),
        confirmsMerchant,
      });
      continue;
    }
    if (
      moneyToMinor(prior.amount) !== moneyToMinor(row.amount) ||
      prior.confirmsMerchant !== confirmsMerchant
    )
      await updatePurchaseEventWhere(
        tx,
        "FinancialTransactionAllocation",
        {
          amountMinor: moneyToMinor(row.amount),
          confirmsMerchant,
          updatedAt: new Date(),
        },
        and(
          eq(financialTransactionAllocation.transactionId, transactionId),
          eq(financialTransactionAllocation.purchaseId, row.purchaseId),
          notDeleted(financialTransactionAllocation),
        ),
        actor,
      );
  }
  return inserts;
}

/** Automation preserves independent confirmation but cannot create it by default. */
export function allocationConfirmsMerchant(
  prior: { confirmsMerchant: boolean } | undefined,
  row: { confirmsMerchant?: boolean },
  actor: ActorContext,
) {
  const memberDecision = actor.channel !== "system" && actor.runId === null;
  return prior?.confirmsMerchant || (row.confirmsMerchant ?? memberDecision);
}

/** Resolve caller-supplied `PUR-` codes to ids, preserving order. */
export async function resolveAllocationInputs(
  db: Database | DrizzleTransaction,
  rows: readonly {
    purchaseId: PurchaseShortcode;
    amount: number;
    confirmsMerchant?: boolean;
  }[],
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
    confirmsMerchant: row.confirmsMerchant,
  }));
}

/** Live allocation count per transaction — the "is this split?" question. */
export async function countLiveAllocations(
  tx: DrizzleTransaction,
  transactionIds: readonly FinancialTransactionId[],
): Promise<Map<FinancialTransactionId, number>> {
  if (!transactionIds.length) return new Map();
  const rows = await tx
    .select({
      transactionId: financialTransactionAllocation.transactionId,
      count: sql<number>`count(*)::int`,
    })
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(financialTransactionAllocation.transactionId, [
          ...transactionIds,
        ]),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .groupBy(financialTransactionAllocation.transactionId);
  return new Map(rows.map((row) => [row.transactionId, Number(row.count)]));
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
    AND ${notDeleted("spa")}
  ORDER BY spa."purchaseId"
  LIMIT 1
)`;
