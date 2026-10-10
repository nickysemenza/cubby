import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import {
  financialTransactionKind,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import {
  parseEntityId,
  type LedgerPartyId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { and, asc, between, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
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

import {
  matchCompletePaymentSet,
  type SettlementCandidate,
} from "./writer-policy";

const log = createLogger("purchase-import.settlement");

/** Payment lines and statement rows may disagree by posting lag, never more. */
const POSTING_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * Serialize settlement per member. An import inserts its payment lines and
 * settles inside one transaction; without this lock a concurrent pass could
 * settle a charge before the import's competing line is visible to it.
 */
export async function lockPartySettlement(
  tx: DrizzleTransaction,
  ledgerPartyId: LedgerPartyId,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`purchase-settlement:${ledgerPartyId}`}))`,
  );
}

type RetainedPayment = {
  amount: number;
  chargedAt: Date | null;
  cardLastFour: string | null;
};

type Charge = SettlementCandidate & {
  kind: ReturnType<typeof financialTransactionKind.parse>;
};

export type RetainedSettlementOutcome =
  | "allocated"
  | "already_allocated"
  | "no_evidence"
  | "conflicting_sources"
  | "incomplete"
  | "competing";

// Sources record the same payment at different precision (a full timestamp
// and card on the page, a date only in an export), so they agree on amount
// and charge day.
// The UTC day on purpose: date-only sources arrive as UTC-midnight
// timestamps, and the deferred-settlement SQL compares `chargedAt::date`.
const paymentKey = (payment: RetainedPayment) =>
  // oxlint-disable-next-line cubby/no-ad-hoc-calendar-day -- same UTC day as the SQL side
  `${cents(payment.amount)}|${payment.chargedAt?.toISOString().slice(0, 10) ?? ""}`;

/**
 * One order's payment set. A Purchase seen through several sources (a browser
 * page and an export) keeps each source's lines; they must describe the same
 * payments, or the order's evidence disagrees with itself and stays for review.
 */
async function loadPaymentSet(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<RetainedPayment[] | "conflicting_sources"> {
  const rows = await tx
    .select({
      sourceClaimId: purchasePaymentEvidence.sourceClaimId,
      amount: purchasePaymentEvidence.amount,
      chargedAt: purchasePaymentEvidence.chargedAt,
      cardLastFour: purchasePaymentEvidence.cardLastFour,
    })
    .from(purchasePaymentEvidence)
    .where(eq(purchasePaymentEvidence.purchaseId, purchaseId))
    .orderBy(
      asc(purchasePaymentEvidence.sourceClaimId),
      asc(purchasePaymentEvidence.evidenceIndex),
    );
  const bySource = new Map<string, RetainedPayment[]>();
  for (const row of rows) {
    const set = bySource.get(row.sourceClaimId) ?? [];
    set.push(row);
    bySource.set(row.sourceClaimId, set);
  }
  const sets = [...bySource.values()];
  const signature = (set: RetainedPayment[]) =>
    set.map(paymentKey).sort().join(";");
  const [first] = sets;
  if (!first) return [];
  return sets.every((set) => signature(set) === signature(first))
    ? first
    : "conflicting_sources";
}

/**
 * Charges an order's evidence may settle against: real settlement money on
 * the member's own accounts within the posting window. A void row never moved
 * money and an expected one has not yet; a charge whose merchant is confirmed
 * for a different vendor belongs to that vendor's orders; a kind or sign that
 * cannot settle a Purchase is excluded rather than left to fail validation.
 */
async function settleableCharges(
  tx: DrizzleTransaction,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: string;
    payments: RetainedPayment[];
  },
): Promise<Charge[]> {
  const dated = input.payments.flatMap((payment) =>
    payment.chargedAt ? [payment.chargedAt.getTime()] : [],
  );
  if (dated.length === 0) return [];
  // oxlint-disable-next-line cubby/no-ad-hoc-calendar-day -- matches paymentKey's UTC day
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
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
        eq(financialAccount.ledgerPartyId, input.ledgerPartyId),
        notDeleted(financialAccount),
      ),
    )
    .where(
      and(
        notDeleted(financialTransaction),
        inArray(financialTransaction.status, ["posted", "pending"]),
        between(
          sql<string>`coalesce(${financialTransaction.transactionDate}, ${financialTransaction.postedDate})`,
          day(Math.min(...dated) - POSTING_WINDOW_DAYS * DAY_MS),
          day(Math.max(...dated) + POSTING_WINDOW_DAYS * DAY_MS),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM "MerchantVendorRule" mvr
          WHERE mvr."ledgerPartyId" = ${input.ledgerPartyId}::uuid
            AND mvr."normalizedMerchant" = lower(regexp_replace(trim(${financialTransaction.merchant}), '\\s+', ' ', 'g'))
            AND mvr."vendorId" <> ${input.vendorId}::uuid
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM "FinancialTransactionAllocation" fta
          WHERE fta."transactionId" = ${financialTransaction.id}
            AND fta."deletedAt" IS NULL
        )`,
      ),
    );
  return rows.flatMap((row) => {
    const date = row.transactionDate ?? row.postedDate;
    const kind = financialTransactionKind.parse(row.kind);
    if (
      !date ||
      financialTransactionSettlementViolation({
        linked: true,
        kind,
        amount: row.amount,
      })
    )
      return [];
    return [
      {
        id: row.id,
        amount: row.amount,
        kind,
        occurredAt: new Date(`${date}T12:00:00.000Z`),
        cardLastFours: cardLastFoursOn(row.accountCardNumbers, date),
      },
    ];
  });
}

const toPolicyPayments = (payments: RetainedPayment[]) =>
  payments.map((payment) => ({
    amount: payment.amount,
    chargedAt: payment.chargedAt?.toISOString(),
    cardLastFour: payment.cardLastFour ?? undefined,
  }));

/**
 * Other live Purchases still short of their own payment total whose retained
 * payment line could take this charge. Deliberately wide (any member, any
 * vendor): a spurious competitor only sends the choice to review.
 */
async function competingClaimants(
  tx: DrizzleTransaction,
  charge: Charge,
  excludePurchaseId: PurchaseId,
): Promise<PurchaseId[]> {
  const epoch = Math.floor(charge.occurredAt.getTime() / 1_000);
  const cards = charge.cardLastFours;
  const rows = await tx
    .selectDistinct({ purchaseId: purchasePaymentEvidence.purchaseId })
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
        sql`${purchasePaymentEvidence.purchaseId} <> ${excludePurchaseId}::uuid`,
        sql`round(${purchasePaymentEvidence.amount} * 100) = ${cents(charge.amount)}`,
        // Both sides as UTC epochs, independent of the session time zone.
        sql`(${purchasePaymentEvidence.chargedAt} IS NULL
          OR abs(extract(epoch FROM ${purchasePaymentEvidence.chargedAt}) - ${epoch}) <= ${POSTING_WINDOW_DAYS * 86_400})`,
        cards.length > 0
          ? sql`(${purchasePaymentEvidence.cardLastFour} IS NULL
              OR ${purchasePaymentEvidence.cardLastFour} IN (${sql.join(
                cards.map((four) => sql`${four}`),
                sql`, `,
              )}))`
          : undefined,
        // A Purchase whose allocations already cover its payment lines makes
        // no further claim; a partly settled one still does.
        sql`coalesce((
          SELECT sum(fta."amount") FROM "FinancialTransactionAllocation" fta
          WHERE fta."purchaseId" = ${purchasePaymentEvidence.purchaseId}
            AND fta."deletedAt" IS NULL
        ), 0) < (
          SELECT sum(ppe."amount") FROM "PurchasePaymentEvidence" ppe
          WHERE ppe."purchaseId" = ${purchasePaymentEvidence.purchaseId}
        )`,
      ),
    );
  return rows.map((row) => row.purchaseId);
}

type PlannedAllocation = {
  charge: Charge;
  next: { purchaseId: PurchaseId; amount: number }[];
};

/**
 * Several orders whose own payment lines each name the same combined charge,
 * and nothing else, form a group when their printed totals conserve it. Every
 * member must be live, unsettled, of the same member and vendor, and match no
 * other charge; any doubt leaves the charge for review. Orders whose totals
 * merely add up to a charge are never a group: that is amount coincidence.
 */
async function evidencedChargeGroup(
  tx: DrizzleTransaction,
  input: {
    charge: Charge;
    members: PurchaseId[];
    ledgerPartyId: LedgerPartyId;
    vendorId: string;
  },
): Promise<PlannedAllocation["next"] | null> {
  const members = [...new Set(input.members)].sort();
  const rows = await tx
    .select({
      id: purchase.id,
      vendorId: purchase.vendorId,
      statedTotal: purchase.statedTotal,
    })
    .from(purchase)
    .where(and(inArray(purchase.id, members), notDeleted(purchase)))
    .orderBy(asc(purchase.id))
    .for("update");
  if (rows.length !== members.length) return null;
  const [allocated] = await tx
    .select({ id: financialTransactionAllocation.id })
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(financialTransactionAllocation.purchaseId, members),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .limit(1);
  if (allocated) return null;
  for (const row of rows) {
    if (!(await namesOnlyThisCharge(tx, { ...input, row }))) return null;
  }
  const total = rows.reduce((sum, row) => sum + cents(row.statedTotal ?? 0), 0);
  if (total !== cents(input.charge.amount)) return null;
  return rows.map((row) => ({
    purchaseId: row.id,
    amount: row.statedTotal ?? 0,
  }));
}

/** One group member: a single payment line naming this charge and no other. */
async function namesOnlyThisCharge(
  tx: DrizzleTransaction,
  input: {
    charge: Charge;
    ledgerPartyId: LedgerPartyId;
    vendorId: string;
    row: {
      id: PurchaseId;
      vendorId: string | null;
      statedTotal: number | null;
    };
  },
): Promise<boolean> {
  const { row } = input;
  if (
    row.vendorId !== input.vendorId ||
    row.statedTotal === null ||
    cents(row.statedTotal) <= 0
  )
    return false;
  const [claim] = await tx
    .select({ ledgerPartyId: importSourceClaim.ledgerPartyId })
    .from(importSourceClaim)
    .innerJoin(
      importSourceOrder,
      eq(importSourceOrder.sourceClaimId, importSourceClaim.id),
    )
    .where(eq(importSourceOrder.purchaseId, row.id))
    .limit(1);
  if (claim?.ledgerPartyId !== input.ledgerPartyId) return false;
  const payments = await loadPaymentSet(tx, row.id);
  if (payments === "conflicting_sources" || payments.length !== 1) return false;
  if (cents(payments[0]?.amount ?? 0) !== cents(input.charge.amount))
    return false;
  const own = matchCompletePaymentSet(
    toPolicyPayments(payments),
    await settleableCharges(tx, {
      ledgerPartyId: input.ledgerPartyId,
      vendorId: input.vendorId,
      payments,
    }),
  );
  return own?.[0]?.transactionId === input.charge.id;
}

/** The sum of a Purchase's live, priced Expense lines, or null when none. */
async function liveExpenseTotalCents(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<number | null> {
  const [row] = await tx
    .select({
      total: sql<string | null>`sum(${expense.cost})`,
      priced: sql<number>`count(${expense.cost})::int`,
    })
    .from(expense)
    .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)));
  return row && row.priced > 0 && row.total !== null
    ? cents(Number(row.total))
    : null;
}

/**
 * Settle one Purchase from the payment lines its own order evidence retained.
 *
 * Only a complete, unique, conserved set is written. Every retained payment
 * must match exactly one settleable charge (amount, card, posting window). A
 * charge another unsettled Purchase could also claim is written only when
 * every claimant's own single payment line names that charge and their printed
 * totals conserve it (a combined charge); otherwise it stays for review. All
 * matched charges are locked and re-checked before the first write, so the
 * whole set lands or nothing does. Stock is never touched.
 */
export async function settlePurchaseFromRetainedPayments(
  tx: DrizzleTransaction,
  input: {
    purchaseId: PurchaseId;
    ledgerPartyId: LedgerPartyId;
    actor: ActorContext;
  },
): Promise<RetainedSettlementOutcome> {
  await lockPartySettlement(tx, input.ledgerPartyId);
  const [target] = await tx
    .select({ vendorId: purchase.vendorId, statedTotal: purchase.statedTotal })
    .from(purchase)
    .where(and(eq(purchase.id, input.purchaseId), notDeleted(purchase)))
    .limit(1)
    .for("update");
  if (!target?.vendorId) return "no_evidence";
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

  const payments = await loadPaymentSet(tx, input.purchaseId);
  if (payments === "conflicting_sources") return payments;
  // Without a dated payment line there is no posting window to bound the
  // search; an amount alone is coincidence, not evidence.
  if (!payments.some((payment) => payment.chargedAt)) return "no_evidence";
  const charges = await settleableCharges(tx, {
    ledgerPartyId: input.ledgerPartyId,
    vendorId: target.vendorId,
    payments,
  });
  const matches = matchCompletePaymentSet(toPolicyPayments(payments), charges);
  if (!matches) return "incomplete";

  // Payment lines that exceed the order's own total describe a combined
  // charge: this order alone may never absorb it. Without a printed total the
  // live Expense lines stand in; with neither, the paid amount is unproven.
  const orderTotal =
    target.statedTotal !== null
      ? cents(target.statedTotal)
      : await liveExpenseTotalCents(tx, input.purchaseId);
  if (orderTotal === null) return "incomplete";
  const paid = payments.reduce(
    (sum, payment) => sum + cents(payment.amount),
    0,
  );
  const sharesCharge = paid > orderTotal;
  const plan: PlannedAllocation[] = [];
  for (const match of matches) {
    const charge = charges.find((row) => row.id === match.transactionId);
    if (!charge) return "incomplete";
    const claimants = await competingClaimants(tx, charge, input.purchaseId);
    if (claimants.length === 0 && !sharesCharge) {
      plan.push({
        charge,
        next: [{ purchaseId: input.purchaseId, amount: match.amount }],
      });
      continue;
    }
    // A combined charge is a group only when this order's single payment line
    // names it too; a multi-payment order sharing a charge is a review case.
    if (payments.length !== 1) return "competing";
    // The rest of a combined charge has not been imported yet.
    if (claimants.length === 0) return "incomplete";
    const group = await evidencedChargeGroup(tx, {
      charge,
      members: [input.purchaseId, ...claimants],
      ledgerPartyId: input.ledgerPartyId,
      vendorId: target.vendorId,
    });
    if (!group) return "competing";
    plan.push({ charge, next: group });
  }
  return (await writePlan(tx, plan, input.actor)) ? "allocated" : "incomplete";
}

/**
 * Lock every planned charge in id order, re-check that none was allocated
 * meanwhile, then write. A lost race writes nothing.
 */
async function writePlan(
  tx: DrizzleTransaction,
  plan: PlannedAllocation[],
  actor: ActorContext,
): Promise<boolean> {
  const chargeIds = plan
    .map((entry) => parseEntityId("financialTransaction", entry.charge.id))
    .sort();
  await tx
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(inArray(financialTransaction.id, chargeIds))
    .orderBy(asc(financialTransaction.id))
    .for("update");
  const before = await readAllocations(tx, chargeIds);
  if (chargeIds.some((id) => (before.get(id) ?? []).length > 0)) return false;
  for (const entry of plan) {
    assertAllocationSetValid({
      transactionAmount: entry.charge.amount,
      kind: entry.charge.kind,
      next: entry.next,
    });
    await assertPurchasesLive(
      tx,
      entry.next.map((row) => row.purchaseId),
    );
    await writeAllocationSet(
      tx,
      parseEntityId("financialTransaction", entry.charge.id),
      entry.next,
      before,
    );
  }
  await applyAllocationChanges(tx, {
    transactionIds: chargeIds,
    before,
    actor,
  });
  return true;
}

/**
 * Settle each unsettled Purchase whose retained payment lines now meet a
 * charge that arrived later (a statement imported after the order). Only Purchases with an unallocated charge of a
 * matching amount near a payment date are visited, each in its own
 * transaction; one failure is logged and never stops the pass.
 */
export async function settleRetainedPaymentEvidence(
  db: Database,
): Promise<{ allocated: number; reviewable: number; failed: number }> {
  const pending = await getDb(db)
    .selectDistinct({
      purchaseId: purchasePaymentEvidence.purchaseId,
      ledgerPartyId: importSourceClaim.ledgerPartyId,
    })
    .from(purchasePaymentEvidence)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, purchasePaymentEvidence.sourceClaimId),
    )
    .innerJoin(
      purchase,
      and(
        eq(purchase.id, purchasePaymentEvidence.purchaseId),
        notDeleted(purchase),
      ),
    )
    .where(
      and(
        sql`${purchasePaymentEvidence.chargedAt} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM "FinancialTransactionAllocation" fta
          WHERE fta."purchaseId" = ${purchase.id} AND fta."deletedAt" IS NULL
        )`,
        sql`EXISTS (
          SELECT 1 FROM "FinancialTransaction" ft
          JOIN "FinancialAccount" fa
            ON fa."id" = ft."accountId" AND fa."deletedAt" IS NULL
          WHERE fa."ledgerPartyId" = ${importSourceClaim.ledgerPartyId}
            AND ft."deletedAt" IS NULL
            AND ft."status" IN ('posted', 'pending')
            AND round(ft."amount" * 100) = round(${purchasePaymentEvidence.amount} * 100)
            AND abs(coalesce(ft."transactionDate", ft."postedDate") - (${purchasePaymentEvidence.chargedAt})::date) <= ${POSTING_WINDOW_DAYS}
            AND NOT EXISTS (
              SELECT 1 FROM "FinancialTransactionAllocation" ofta
              WHERE ofta."transactionId" = ft."id" AND ofta."deletedAt" IS NULL
            )
        )`,
      ),
    );
  const actors = new Map<string, ActorContext | null>();
  const tally = { allocated: 0, reviewable: 0, failed: 0 };
  for (const row of pending) {
    const ledgerPartyId = parseEntityId("ledgerParty", row.ledgerPartyId);
    if (!actors.has(ledgerPartyId))
      actors.set(ledgerPartyId, await memberActor(db, ledgerPartyId));
    const actor = actors.get(ledgerPartyId);
    if (!actor) continue;
    try {
      const outcome = await withTransaction(db, (tx) =>
        settlePurchaseFromRetainedPayments(tx, {
          purchaseId: row.purchaseId,
          ledgerPartyId,
          actor,
        }),
      );
      if (outcome === "allocated") tally.allocated += 1;
      else if (outcome !== "already_allocated" && outcome !== "no_evidence")
        tally.reviewable += 1;
    } catch (error) {
      tally.failed += 1;
      log.warn("Retained settlement failed for one Purchase", {
        purchaseId: row.purchaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return tally;
}

/** The member who owns a ledger party acts for its unattended settlement. */
async function memberActor(
  db: Database,
  ledgerPartyId: LedgerPartyId,
): Promise<ActorContext | null> {
  const [owner] = await getDb(db)
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, ledgerPartyId), notDeleted(ledgerParty)))
    .limit(1);
  return owner?.userId ? buildActorContext(owner.userId, "system") : null;
}
