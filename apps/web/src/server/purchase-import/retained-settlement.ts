import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  parseEntityId,
  type FinancialTransactionId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import { and, between, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importHunt,
  ledgerParty,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  applyAllocationChanges,
  assertAllocationSetValid,
  assertPurchasesLive,
  readAllocations,
  writeAllocationSet,
} from "~/server/repo/financial-transaction-allocations";
import { cents } from "~/server/repo/money";

import { matchCompletePaymentSet } from "./writer-policy";

/** Payment lines and statement rows may disagree by posting lag, never more. */
const POSTING_WINDOW_DAYS = 3;

/**
 * Charges an order's evidence may settle against: real money movement on the
 * member's own accounts. A void row never moved money and an expected row has
 * not yet; a charge whose merchant is confirmed for a different vendor belongs
 * to that vendor's orders.
 */
const settleableChargeCondition = (vendorId: string) =>
  and(
    notDeleted(financialTransaction),
    inArray(financialTransaction.status, ["posted", "pending"]),
    sql`NOT EXISTS (
      SELECT 1 FROM "MerchantVendorRule" mvr
      WHERE mvr."ledgerPartyId" = "FinancialAccount"."ledgerPartyId"
        AND mvr."normalizedMerchant" = lower(regexp_replace(trim("FinancialTransaction"."merchant"), '\\s+', ' ', 'g'))
        AND mvr."vendorId" <> ${vendorId}::uuid
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM "FinancialTransactionAllocation" fta
      WHERE fta."transactionId" = "FinancialTransaction"."id"
        AND fta."deletedAt" IS NULL
    )`,
  );

const shiftDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);

export type RetainedSettlementOutcome =
  | "allocated"
  | "already_allocated"
  | "no_evidence"
  | "incomplete"
  | "competing";

/**
 * Settle one Purchase from the payment lines its own order evidence retained.
 *
 * Only a complete, unique payment set is written: every retained payment must
 * match exactly one settleable charge (amount, card, posting window), and no
 * other unsettled Purchase may hold a payment line that could claim the same
 * charge. Anything less leaves settlement for review. The whole set is written
 * in the caller's transaction or not at all, and stock is never touched.
 */
export async function settlePurchaseFromRetainedPayments(
  tx: DrizzleTransaction,
  input: { purchaseId: PurchaseId; actor: ActorContext },
): Promise<RetainedSettlementOutcome> {
  const [target] = await tx
    .select({
      vendorId: purchase.vendorId,
      ledgerPartyId: sql<string | null>`(
        SELECT va."ledgerPartyId" FROM "VendorAccount" va
        WHERE va."id" = ${purchase.vendorAccountId}
      )`,
    })
    .from(purchase)
    .where(and(eq(purchase.id, input.purchaseId), notDeleted(purchase)))
    .limit(1)
    .for("update");
  if (!target?.vendorId || !target.ledgerPartyId) return "no_evidence";
  const [existing] = await tx
    .select({ id: financialTransactionAllocation.id })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.purchaseId, input.purchaseId),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .limit(1);
  if (existing) return "already_allocated";

  const payments = await tx
    .select({
      amount: purchasePaymentEvidence.amount,
      chargedAt: purchasePaymentEvidence.chargedAt,
      cardLastFour: purchasePaymentEvidence.cardLastFour,
    })
    .from(purchasePaymentEvidence)
    .where(eq(purchasePaymentEvidence.purchaseId, input.purchaseId))
    .orderBy(purchasePaymentEvidence.evidenceIndex);
  const dated = payments.flatMap((payment) =>
    payment.chargedAt ? [payment.chargedAt] : [],
  );
  // Without a dated payment line there is no posting window to bound the
  // search; an amount alone is coincidence, not evidence.
  if (payments.length === 0 || dated.length === 0) return "no_evidence";
  const low = shiftDays(
    new Date(Math.min(...dated.map((date) => date.getTime()))),
    -POSTING_WINDOW_DAYS,
  );
  const high = shiftDays(
    new Date(Math.max(...dated.map((date) => date.getTime()))),
    POSTING_WINDOW_DAYS,
  );
  const rows = await tx
    .select({
      id: financialTransaction.id,
      amount: financialTransaction.amount,
      kind: financialTransaction.kind,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
      accountCardNumbers: financialAccount.cardNumbers,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, financialTransaction.accountId),
        eq(
          financialAccount.ledgerPartyId,
          parseEntityId("ledgerParty", target.ledgerPartyId),
        ),
        notDeleted(financialAccount),
      ),
    )
    .where(
      and(
        settleableChargeCondition(target.vendorId),
        between(
          sql<string>`coalesce(${financialTransaction.transactionDate}, ${financialTransaction.postedDate})`,
          low,
          high,
        ),
      ),
    );
  const candidates = rows.flatMap((row) => {
    const date = row.transactionDate ?? row.postedDate;
    return date
      ? [
          {
            id: row.id,
            amount: row.amount,
            kind: financialTransactionKind.parse(row.kind),
            occurredAt: new Date(`${date}T12:00:00.000Z`),
            cardLastFours: cardLastFoursOn(row.accountCardNumbers, date),
          },
        ]
      : [];
  });
  const matches = matchCompletePaymentSet(
    payments.map((payment) => ({
      amount: payment.amount,
      chargedAt: payment.chargedAt?.toISOString(),
      cardLastFour: payment.cardLastFour ?? undefined,
    })),
    candidates,
  );
  if (!matches) return "incomplete";

  // No competing claim: another unsettled Purchase whose own retained payment
  // line could take the same charge makes the choice a review decision.
  for (const match of matches) {
    const charge = candidates.find(
      (candidate) => candidate.id === match.transactionId,
    );
    if (!charge) return "incomplete";
    const [competitor] = await tx
      .select({ purchaseId: purchasePaymentEvidence.purchaseId })
      .from(purchasePaymentEvidence)
      .innerJoin(
        purchase,
        and(
          eq(purchase.id, purchasePaymentEvidence.purchaseId),
          notDeleted(purchase),
        ),
      )
      .where(
        and(
          ne(purchasePaymentEvidence.purchaseId, input.purchaseId),
          sql`round(${purchasePaymentEvidence.amount} * 100) = ${cents(charge.amount)}`,
          sql`(${purchasePaymentEvidence.chargedAt} IS NULL OR abs(extract(epoch FROM (${purchasePaymentEvidence.chargedAt} - ${charge.occurredAt.toISOString()}::timestamptz))) <= ${POSTING_WINDOW_DAYS * 86_400})`,
          sql`NOT EXISTS (
            SELECT 1 FROM "FinancialTransactionAllocation" fta
            WHERE fta."purchaseId" = ${purchasePaymentEvidence.purchaseId}
              AND fta."deletedAt" IS NULL
          )`,
        ),
      )
      .limit(1);
    if (competitor) return "competing";
  }

  for (const match of matches) {
    const charge = candidates.find(
      (candidate) => candidate.id === match.transactionId,
    )!;
    await allocateUnsettledCharge(tx, {
      transactionId: parseEntityId("financialTransaction", charge.id),
      transactionAmount: charge.amount,
      kind: charge.kind,
      next: [{ purchaseId: input.purchaseId, amount: match.amount }],
      actor: input.actor,
    });
  }
  return "allocated";
}

/**
 * Write one complete allocation set for a charge that is still unallocated,
 * under a row lock, through the same validation and audit as a reviewed
 * allocation. A concurrent writer that allocated it first wins and this
 * becomes a no-op.
 */
async function allocateUnsettledCharge(
  tx: DrizzleTransaction,
  input: {
    transactionId: FinancialTransactionId;
    transactionAmount: number;
    kind: Parameters<typeof assertAllocationSetValid>[0]["kind"];
    next: { purchaseId: PurchaseId; amount: number }[];
    actor: ActorContext;
  },
): Promise<boolean> {
  await tx
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(eq(financialTransaction.id, input.transactionId))
    .for("update");
  const before = await readAllocations(tx, [input.transactionId]);
  if ((before.get(input.transactionId) ?? []).length > 0) return false;
  assertAllocationSetValid({
    transactionAmount: input.transactionAmount,
    kind: input.kind,
    next: input.next,
  });
  await assertPurchasesLive(
    tx,
    input.next.map((row) => row.purchaseId),
  );
  await writeAllocationSet(tx, input.transactionId, input.next, before);
  await applyAllocationChanges(tx, {
    transactionIds: [input.transactionId],
    before,
    actor: input.actor,
  });
  return true;
}

/** The member who owns a ledger party acts for its unattended settlement. */
async function memberActor(
  db: Database | DrizzleTransaction,
  ledgerPartyId: string,
): Promise<ActorContext | null> {
  const client = "rollback" in db ? db : getDb(db);
  const [owner] = await client
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(eq(ledgerParty.id, parseEntityId("ledgerParty", ledgerPartyId)))
    .limit(1);
  return owner?.userId ? buildActorContext(owner.userId, "system") : null;
}

/**
 * Before any mailbox or browser hunt, settle every unsettled Purchase whose
 * retained payment lines now uniquely meet a charge that arrived later (a
 * statement imported after the order). Each Purchase settles in its own
 * transaction; ambiguity leaves it for review.
 */
export async function settleRetainedPaymentEvidence(
  db: Database,
): Promise<{ allocated: number; reviewable: number }> {
  const pending = await getDb(db)
    .selectDistinct({
      purchaseId: purchasePaymentEvidence.purchaseId,
      ledgerPartyId: sql<string>`(
        SELECT va."ledgerPartyId" FROM "VendorAccount" va
        WHERE va."id" = "Purchase"."vendorAccountId"
      )`,
    })
    .from(purchasePaymentEvidence)
    .innerJoin(
      purchase,
      and(
        eq(purchase.id, purchasePaymentEvidence.purchaseId),
        notDeleted(purchase),
      ),
    )
    .leftJoin(
      financialTransactionAllocation,
      and(
        eq(financialTransactionAllocation.purchaseId, purchase.id),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .where(isNull(financialTransactionAllocation.id));
  let allocated = 0;
  let reviewable = 0;
  for (const row of pending) {
    if (!row.ledgerPartyId) continue;
    const actor = await memberActor(db, row.ledgerPartyId);
    if (!actor) continue;
    const outcome = await withTransaction(db, (tx) =>
      settlePurchaseFromRetainedPayments(tx, {
        purchaseId: row.purchaseId,
        actor,
      }),
    );
    if (outcome === "allocated") allocated += 1;
    else if (outcome === "competing" || outcome === "incomplete")
      reviewable += 1;
  }
  return { allocated, reviewable };
}

/**
 * A charge the mailbox proved to be one unique set of orders is allocated
 * across those orders once every one of them is imported, each at its printed
 * total, and only when those totals conserve the charge exactly and none of
 * the orders is already settled elsewhere. Refund groups stay reviewable: a
 * credit's split across orders is not stated by their totals.
 */
export async function settleMatchedChargeGroups(
  db: Database,
): Promise<{ allocated: number }> {
  const hunts = await getDb(db)
    .select({
      id: importHunt.id,
      ledgerPartyId: importHunt.ledgerPartyId,
      vendorId: importHunt.vendorId,
      transactionId: importHunt.financialTransactionId,
      matchedOrderIds: importHunt.matchedOrderIds,
    })
    .from(importHunt)
    .where(
      and(
        inArray(importHunt.state, ["pending_browser", "browser_queued"]),
        sql`jsonb_array_length(${importHunt.matchedOrderIds}) > 1`,
      ),
    );
  let allocated = 0;
  for (const hunt of hunts) {
    const vendorId = hunt.vendorId;
    if (!vendorId) continue;
    const actor = await memberActor(db, hunt.ledgerPartyId);
    if (!actor) continue;
    const written = await withTransaction(db, async (tx) => {
      const [charge] = await tx
        .select({
          amount: financialTransaction.amount,
          kind: financialTransaction.kind,
          status: financialTransaction.status,
        })
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.id, hunt.transactionId),
            notDeleted(financialTransaction),
          ),
        )
        .limit(1);
      if (
        !charge ||
        charge.amount <= 0 ||
        !["posted", "pending"].includes(charge.status)
      )
        return false;
      const orders = await tx
        .select({
          id: purchase.id,
          orderId: purchase.orderId,
          statedTotal: purchase.statedTotal,
        })
        .from(purchase)
        .where(
          and(
            eq(purchase.vendorId, vendorId),
            inArray(purchase.orderId, hunt.matchedOrderIds),
            notDeleted(purchase),
            sql`EXISTS (
              SELECT 1 FROM "VendorAccount" va
              WHERE va."id" = "Purchase"."vendorAccountId"
                AND va."ledgerPartyId" = ${hunt.ledgerPartyId}::uuid
                AND va."deletedAt" IS NULL
            )`,
          ),
        )
        .for("update");
      // Every matched order exactly once, each with a printed total.
      if (
        orders.length !== hunt.matchedOrderIds.length ||
        new Set(orders.map((order) => order.orderId)).size !== orders.length ||
        orders.some((order) => order.statedTotal === null)
      )
        return false;
      const total = orders.reduce(
        (sum, order) => sum + cents(order.statedTotal ?? 0),
        0,
      );
      if (total !== cents(charge.amount)) return false;
      const [settledElsewhere] = await tx
        .select({ id: financialTransactionAllocation.id })
        .from(financialTransactionAllocation)
        .where(
          and(
            inArray(
              financialTransactionAllocation.purchaseId,
              orders.map((order) => order.id),
            ),
            notDeleted(financialTransactionAllocation),
          ),
        )
        .limit(1);
      if (settledElsewhere) return false;
      const wrote = await allocateUnsettledCharge(tx, {
        transactionId: hunt.transactionId,
        transactionAmount: charge.amount,
        kind: financialTransactionKind.parse(charge.kind),
        next: orders.map((order) => ({
          purchaseId: order.id,
          amount: order.statedTotal ?? 0,
        })),
        actor,
      });
      if (wrote)
        await tx
          .update(importHunt)
          .set({ state: "resolved", updatedAt: new Date() })
          .where(eq(importHunt.id, hunt.id));
      return wrote;
    });
    if (written) allocated += 1;
  }
  return { allocated };
}
