import type { ActorContext } from "@cubby/schemas/context";
import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import {
  financialBookingInput,
  financialConvergenceResult,
  type FinancialConvergenceInput,
  type FinancialWorkPreview,
} from "@cubby/schemas/financial-booking";
import type { FinancialMailEvent } from "@cubby/schemas/financial-mail-event";
import {
  financialTransactionKind,
  type FinancialTransactionSourceRef,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor, type PurchaseId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { minorToMoney, moneyToMinor, cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { minorToDollarsSql } from "~/server/db/computed/money";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
  withHouseholdWrite,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  emailFinancialAssociation,
  financialTransaction,
  financialTransactionAllocation,
  purchase,
  vendor,
} from "~/server/db/schema";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";
import {
  paymentDateWindowSql,
  paymentFundingPartySql,
} from "~/server/domains/financial-account/repo/funding-sql";
import { digestValue } from "~/server/domains/financial-transaction/policy/booking-fingerprint";
import {
  convergenceAccountAvailable,
  financialConvergenceRefusal,
} from "~/server/domains/financial-transaction/policy/financial-convergence";
import { allocationDollars } from "~/server/domains/financial-transaction/repo/allocation-money";
import {
  commitFinancialBooking,
  bookingGraph,
  loadFinancialBookingLineage,
  previewFinancialBooking,
} from "~/server/domains/financial-transaction/repo/financial-booking";
import { financialSourceRefsFor } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { lockFinancialTransactionSources } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { findSettlementConflicts } from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import type { FinancialTransactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import {
  assertMailFinancialEvidenceCurrent,
  type PreparedMailFinancialEvent,
} from "~/server/domains/purchase-import/repo/mail-financial-event";
import { normalizeMerchant } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { AppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  nameMatchesAnySql,
  textArraySomeSql,
} from "~/server/lib/name-alias-match";

import {
  previewFinancialSpending,
  commitFinancialSpending,
} from "./financial-spending";
import { updateFinancialTransaction } from "./financial-transaction";

type Result = z.infer<typeof financialConvergenceResult>;
type Ready = {
  status: "ready";
  purchaseId: FinancialWorkPreview["purchaseId"];
  vendorId: FinancialWorkPreview["vendorId"];
  action: "link_existing" | "create_aggregate";
};
const review = (
  reason: string,
): Extract<Result, { status: "review_required" }> => ({
  status: "review_required",
  reason,
});

async function acceptedAutomaticFacts(
  db: Database,
  transactionId: FinancialConvergenceInput["transactionId"],
) {
  const row = await getDb(db)
    .query.financialTransaction.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(financialTransaction.shortcode, transactionId),
          ),
      },
    })
    .then((row) => (row ? transactionDollars(row) : row));
  if (!row) return null;
  const account = await getDb(db).query.financialAccount.findFirst({
    where: { RAW: (a, { eq }) => relationalSql(a, eq(a.id, row.accountId)) },
  });
  const allocations = await getDb(db)
    .select({
      purchaseId: financialTransactionAllocation.purchaseId,
      amount: minorToDollarsSql(
        financialTransactionAllocation.amountMinor,
        "numeric",
      ).mapWith(Number),
    })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.transactionId, row.id),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .orderBy(financialTransactionAllocation.purchaseId);
  const firstAllocation = allocations[0];
  const target = firstAllocation
    ? await getDb(db).query.purchase.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, eq(purchase.id, firstAllocation.purchaseId)),
        },
      })
    : null;
  const graph = await bookingGraph(db, target?.id ?? null);
  return digestValue({
    transaction: {
      accountId: row.accountId,
      amount: row.amount,
      kind: row.kind,
      status: row.status,
      merchant: row.merchant,
      rawDescription: row.rawDescription,
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      ledgerTransferId: row.ledgerTransferId,
    },
    account: account
      ? {
          ledgerPartyId: account.ledgerPartyId,
          fundingPeriods: account.fundingPeriods,
          deletedAt: account.deletedAt,
        }
      : null,
    allocations,
    sourceRefs: (await financialSourceRefsFor(db, [row.id])).get(row.id) ?? [],
    expenses: graph.lines,
    attributions: graph.attributions,
    purchase: target
      ? {
          vendorId: target.vendorId,
          vendorAccountId: target.vendorAccountId,
          date: target.date,
          orderId: target.orderId,
          statedTotal:
            target.statedTotal === null
              ? null
              : minorToMoney(target.statedTotal),
          deletedAt: target.deletedAt,
        }
      : null,
    lineage: await loadFinancialBookingLineage(db, transactionId),
  });
}

export const resolveConvergenceEmail = (
  db: Database,
  emailId: NonNullable<FinancialConvergenceInput["emailId"]>,
) => resolveOrThrow(db, "email", emailId);

async function verifyMailPayment(
  tx: DrizzleTransaction,
  row: FinancialTransactionDollars,
  purchaseId: PurchaseId | null,
  evidence: PreparedMailFinancialEvent,
  actor: ActorContext,
): Promise<
  | Extract<Result, { status: "review_required" }>
  | {
      status: "verified";
      purchaseId: PurchaseId | null;
      vendorId: typeof vendor.$inferSelect;
      eventRef: FinancialTransactionSourceRef;
      mailEvent: FinancialMailEvent;
    }
> {
  let mailEvent: FinancialMailEvent;
  let vendorId: typeof vendor.$inferSelect;
  let eventRef: FinancialTransactionSourceRef;
  mailEvent = await assertMailFinancialEvidenceCurrent(tx, evidence, actor);
  if (
    mailEvent.kind !== "purchase_payment" ||
    mailEvent.amount.currency !== "USD" ||
    mailEvent.amount.minor !== cents(row.amount)
  )
    return review(
      "The current financial Email does not establish this purchase payment and literal amount.",
    );
  if (
    !mailEvent.providerEventId ||
    !mailEvent.sourceAccountLabel ||
    !mailEvent.counterpartyLabel ||
    !mailEvent.occurredOn
  )
    return review(
      "The financial Email needs a provider payment identity, literal account, counterparty and date.",
    );
  const account = await tx.query.financialAccount.findFirst({
    where: { RAW: (a, { eq }) => relationalSql(a, eq(a.id, row.accountId)) },
  });
  if (
    !account ||
    ![account.name, ...account.sourceAliases.map((alias) => alias.alias)].some(
      (label) =>
        normalizeMerchant(label) ===
        normalizeMerchant(mailEvent!.sourceAccountLabel!),
    )
  )
    return review(
      "The Email's literal account label does not uniquely establish the payment account.",
    );
  // A copied id has no financial provider namespace. Gmail transport identity,
  // a coincident statement id and a later derived dedup key cannot establish
  // this cross-provider mapping; the exact current association must be accepted.
  const [acceptedMapping] = await tx
    .select({ id: emailFinancialAssociation.id })
    .from(emailFinancialAssociation)
    .where(
      and(
        eq(emailFinancialAssociation.emailId, evidence.emailId),
        eq(emailFinancialAssociation.evidenceChecksum, evidence.checksum),
        eq(emailFinancialAssociation.transactionId, row.id),
        eq(emailFinancialAssociation.reviewedAccountId, row.accountId),
      ),
    )
    .limit(1)
    .for("share");
  if (!acceptedMapping)
    return review(
      "Accept the exact current Email-to-transaction and account mapping before automatic booking. Payment ids are scoped to their financial provider; an unqualified id cannot establish identity.",
    );
  const merchantName = normalizeMerchant(mailEvent.counterpartyLabel) ?? "";
  const vendors = await tx
    .select()
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        sql`(${nameMatchesAnySql(sql`btrim(${vendor.name})`, [merchantName])} OR ${textArraySomeSql(vendor.aliases, (value) => nameMatchesAnySql(sql`btrim(${value})`, [merchantName]))})`,
      ),
    );
  if (
    vendors.length !== 1 ||
    !vendors[0]?.website ||
    !vendors[0]?.orderEmailSenders.length
  )
    return review(
      "Resolve one exact Vendor and verify its website and sender addresses before financial discovery.",
    );
  vendorId = vendors[0];
  eventRef = {
    source: "financial-mail",
    externalId: await sha256Hex(
      JSON.stringify([row.accountId, vendorId.id, mailEvent.providerEventId]),
    ),
  };
  const previousIdentity = await tx.execute<{ id: string }>(
    sql`SELECT x."historicalTransactionId" AS id FROM "FinancialEvidenceAlias" x WHERE x.source = ${eventRef.source} AND x.value = ${eventRef.externalId} AND ${notDeleted("x")}`,
  );
  if (previousIdentity.rows.some((previous) => previous.id !== row.id))
    return review(
      "This provider payment already belongs to another transaction; preserve both observations for review.",
    );
  const emailPurchases = await tx.execute<{
    purchaseId: typeof purchase.$inferSelect.id;
  }>(sql`
  SELECT DISTINCT p.id AS "purchaseId" FROM "Email"
  CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) evidence
  JOIN "Purchase" p ON p.id = evidence."purchaseId" AND ${notDeleted("p")}
  WHERE "Email".id = ${evidence.emailId} AND NOT evidence.changed AND evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked})`);
  if (
    emailPurchases.rows.length > 1 ||
    (purchaseId && emailPurchases.rows.some((p) => p.purchaseId !== purchaseId))
  )
    return review(
      "Accepted Email and transaction Purchase identities conflict or require split reconciliation.",
    );
  purchaseId ??= emailPurchases.rows[0]?.purchaseId ?? null;
  if (!purchaseId) {
    const nearby = await tx
      .select({ id: purchase.id })
      .from(purchase)
      .where(
        and(
          notDeleted(purchase),
          eq(purchase.vendorId, vendorId.id),
          sql`(${purchase.date} IS NULL OR abs(${purchase.date}::date - ${mailEvent.occurredOn}::date) <= 45)`,
        ),
      )
      .limit(1);
    if (nearby.length)
      return review(
        "Existing Vendor Purchases may describe this payment; resolve their identity before creating another spending event.",
      );
  }
  return { status: "verified", purchaseId, vendorId, eventRef, mailEvent };
}

async function automaticBookingPreview(
  txDb: Database,
  row: FinancialTransactionDollars,
  input: FinancialConvergenceInput,
  target: typeof purchase.$inferSelect | undefined,
  vendorId: typeof vendor.$inferSelect | undefined,
) {
  const tx = getDb(txDb);
  let preview;
  try {
    preview = await previewFinancialBooking(
      txDb,
      financialBookingInput.parse({
        transactionId: input.transactionId,
        purchaseId: target?.shortcode ?? null,
        vendorId: vendorId?.shortcode ?? null,
        confirmsMerchant: false,
      }),
    );
  } catch (error) {
    if (error instanceof AppError && error.reason === "CONSTRAINT_VIOLATION")
      return review(error.message);
    throw error;
  }
  if (
    preview.action === "link_existing" &&
    cents(preview.remainingBookedAmount) !== cents(row.amount)
  )
    return review(
      "The existing itemization has a different remaining amount; automatic settlement cannot choose a partial allocation.",
    );
  if (preview.action === "create_aggregate" && target) {
    if (
      target.statedTotal !== null &&
      target.statedTotal !== moneyToMinor(row.amount)
    )
      return review(
        "The Purchase's literal total differs from this payment; reconcile split or installment money before booking.",
      );
    const existingLines = await tx.execute<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM "Expense" e WHERE e."purchaseId" = ${target.id} AND ${notDeleted("e")}) AS present`,
    );
    if (existingLines.rows[0]?.present)
      return review(
        "Existing accepted Expenses require reconciliation rather than another aggregate.",
      );
  }
  return { status: "ready" as const, preview };
}

/** No caller-supplied safety switch: identity comes from the accepted graph or
 * an opaque, checksum-fenced financial observation prepared by the mail service.
 * Serializable rechecks bind source identity, allocations, capacity and lineage
 * to the same write. A candidate's rank never enters this boundary. */
async function runFinancialConvergence(
  db: Database,
  input: FinancialConvergenceInput,
  actor: ActorContext,
  evidence?: PreparedMailFinancialEvent,
  dryRun = false,
): Promise<Result | Ready> {
  return (dryRun ? withTransaction : withHouseholdWrite)(db, async (tx) => {
    const txDb = databaseForTransaction(tx);
    const id = await resolveOrThrow(
      txDb,
      "financialTransaction",
      input.transactionId,
    );
    await lockFinancialTransactionSources(tx, [input.transactionId]);
    // Match the settlement writer's global lock order: accepted Purchases
    // precede the transaction, including a target proved by the current Email.
    await tx.execute(sql`
        SELECT p.id FROM "Purchase" p WHERE ${notDeleted("p")} AND (
          EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a
            WHERE a."purchaseId" = p.id AND a."transactionId" = ${id} AND ${notDeleted("a")})
          OR p.id IN (SELECT association."purchaseId" FROM "Email"
            CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) association
            WHERE "Email".id = ${evidence?.emailId ?? null}::uuid AND NOT association.changed
              AND association.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked}))
        ) ORDER BY p.id FOR UPDATE`);
    const [row] = await tx
      .select()
      .from(financialTransaction)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      )
      .for("update")
      .then((rows) => rows.map(transactionDollars));
    const paymentRefusal = financialConvergenceRefusal({
      kind: "payment",
      transaction: row
        ? { ...row, amountMinor: moneyToMinor(row.amount) }
        : null,
    });
    if (paymentRefusal) return review(paymentRefusal);
    if (!row) return review(paymentRefusal!);
    // The funder on the charge date (a lag-safe posting date when only that
    // is known) is the household or the member, and the member owns the
    // account or holds the card: a household-funded card owned by another
    // member's party is still its cardholder's to settle.
    const window = paymentDateWindowSql(sql`payment`);
    const accountAuthority = await tx.execute<{
      funderId: string | null;
      funderKind: string | null;
      ownerId: string | null;
      ownerKind: string | null;
      memberId: string | null;
      memberCode: string | null;
      primaryHolderId: string | null;
      from: string | null;
      to: string | null;
      authorizedUsers: {
        ledgerPartyId: string;
        validFrom: string | null;
        validTo: string | null;
      }[];
    }>(sql`SELECT funder.id AS "funderId",funder.kind AS "funderKind",owner.id AS "ownerId",owner.kind AS "ownerKind",member.id AS "memberId",member.shortcode AS "memberCode",${effectiveFieldSql("financialAccount", "primaryCardholderId", "a")} AS "primaryHolderId",${window.from}::text AS "from",${window.to}::text AS "to",a."authorizedUsers" AS "authorizedUsers"
        FROM "FinancialAccount" a JOIN "FinancialTransaction" payment ON payment.id=${row.id} AND ${notDeleted("payment")}
        JOIN "LedgerParty" funder ON funder.id=${paymentFundingPartySql(sql`a`, sql`payment`)} AND ${notDeleted("funder")}
        LEFT JOIN "LedgerParty" owner ON owner.id=a."ledgerPartyId" AND ${notDeleted("owner")}
        LEFT JOIN "LedgerParty" member ON member."userId"=${actor.userId} AND member.kind=${ledgerPartyKind.enum.member} AND ${notDeleted("member")}
        WHERE a.id=${row.accountId} AND ${notDeleted("a")}`);
    const authorityRefusal = financialConvergenceRefusal({
      kind: "authority",
      authorized: accountAuthority.rows.some(convergenceAccountAvailable),
    });
    if (authorityRefusal) return review(authorityRefusal);
    const refs = (await financialSourceRefsFor(tx, [row.id])).get(row.id) ?? [];
    const sourceRefusal = financialConvergenceRefusal({
      kind: "source",
      referenceCount: refs.length,
    });
    if (sourceRefusal) return review(sourceRefusal);
    const allocations = await tx
      .select()
      .from(financialTransactionAllocation)
      .where(
        and(
          eq(financialTransactionAllocation.transactionId, row.id),
          notDeleted(financialTransactionAllocation),
        ),
      )
      .orderBy(financialTransactionAllocation.purchaseId)
      .for("update")
      .then((rows) => rows.map(allocationDollars));
    const allocationRefusal = financialConvergenceRefusal({
      kind: "allocations",
      amountMinor: moneyToMinor(row.amount),
      allocations: allocations.map((allocation) => ({
        amountMinor: moneyToMinor(allocation.amount),
      })),
    });
    if (allocationRefusal) return review(allocationRefusal);
    let purchaseId = allocations[0]?.purchaseId ?? null;
    let vendorId: typeof vendor.$inferSelect | undefined;
    let eventRef: { source: string; externalId: string } | undefined;
    let mailEvent:
      | Awaited<ReturnType<typeof assertMailFinancialEvidenceCurrent>>
      | undefined;
    const verified = evidence
      ? await verifyMailPayment(tx, row, purchaseId, evidence, actor)
      : null;
    if (verified?.status === "review_required") return verified;
    if (verified) {
      purchaseId = verified.purchaseId;
      vendorId = verified.vendorId;
      eventRef = verified.eventRef;
      mailEvent = verified.mailEvent;
    }
    const identityRefusal = financialConvergenceRefusal({
      kind: "identity",
      purchaseId,
      vendorId: vendorId?.id ?? null,
    });
    if (identityRefusal) return review(identityRefusal);
    const target = purchaseId
      ? await tx.query.purchase.findFirst({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(eq(purchase.id, purchaseId), notDeleted(purchase)),
              ),
          },
        })
      : undefined;
    const acceptedVendor = target?.vendorId
      ? await tx.query.vendor.findFirst({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(eq(vendor.id, target.vendorId), notDeleted(vendor)),
              ),
          },
        })
      : undefined;
    const targetRefusal = financialConvergenceRefusal({
      kind: "target",
      purchaseId,
      targetVendorId: target?.vendorId ?? null,
      verifiedVendorId: vendorId?.id ?? null,
      hasTarget: Boolean(target),
      hasAcceptedVendor: Boolean(acceptedVendor),
    });
    if (targetRefusal) return review(targetRefusal);
    if (target) {
      const conflicts = await findSettlementConflicts(tx, {
        accountId: row.accountId,
        kind: financialTransactionKind.parse(row.kind),
        transactionDate: row.transactionDate,
        purchaseIds: [target.id],
      });
      const conflictRefusal = financialConvergenceRefusal({
        kind: "settlement",
        conflicting: conflicts.has(target.id),
      });
      if (conflictRefusal) return review(conflictRefusal);
    }
    const verifiedTransactionId = row.id;
    const verifiedAccountId = row.accountId;
    async function retainFinancialEmail() {
      if (!evidence || !mailEvent || !eventRef || dryRun) return;
      if (
        !refs.some(
          (ref) =>
            ref.source === eventRef.source &&
            ref.externalId === eventRef.externalId,
        )
      ) {
        await updateFinancialTransaction(
          txDb,
          input.transactionId,
          { sourceRefs: [...refs, eventRef] },
          actor,
        );
      }
      await tx
        .insert(emailFinancialAssociation)
        .values({
          emailId: evidence.emailId,
          evidenceChecksum: evidence.checksum,
          transactionId: verifiedTransactionId,
          reviewedAccountId: verifiedAccountId,
          sourceAccountLabel: mailEvent.sourceAccountLabel!,
          reviewReason:
            "Server-verified provider payment identity, exact money, account and Vendor",
          decidedByUserId: actor.userId,
        })
        .onConflictDoNothing();
    }
    if (row.bookingDecisionFingerprint) {
      const bookingRefusal = financialConvergenceRefusal({
        kind: "booking",
        hasTarget: Boolean(target),
        allocationCount: allocations.length,
        storedDecision: row.bookingDecisionFingerprint,
        currentDecision: await acceptedAutomaticFacts(
          txDb,
          input.transactionId,
        ),
        storedLineage: row.bookingExpenseFingerprint,
        currentLineage: await digestValue(
          await loadFinancialBookingLineage(txDb, input.transactionId),
        ),
      });
      if (bookingRefusal) return review(bookingRefusal);
      if (!target)
        return review(
          "Accepted booking facts changed; reconcile the existing Expenses before another automatic write.",
        );
      await retainFinancialEmail();
      if (verified && !dryRun)
        await refreshAutomaticBookingFingerprint(txDb, input.transactionId);
      return {
        status: "already_recorded",
        purchaseId: parseShortcodeFor("purchase", target.shortcode),
        expenseId: null,
      };
    }
    const checked = await automaticBookingPreview(
      txDb,
      row,
      input,
      target,
      vendorId,
    );
    if (checked.status === "review_required") return checked;
    const { preview } = checked;
    if (dryRun)
      return {
        status: "ready",
        purchaseId: preview.purchaseId,
        vendorId: vendorId
          ? parseShortcodeFor("vendor", vendorId.shortcode)
          : acceptedVendor
            ? parseShortcodeFor("vendor", acceptedVendor.shortcode)
            : null,
        action: preview.action,
      };
    const saved = await commitFinancialBooking(txDb, preview, actor);
    await retainFinancialEmail();
    await tx
      .update(financialTransaction)
      .set({
        bookingDecisionFingerprint: `automatic:${await acceptedAutomaticFacts(txDb, input.transactionId)}`,
      })
      .where(eq(financialTransaction.id, row.id));
    return {
      status: "applied",
      purchaseId: saved.purchaseId,
      expenseId: saved.expenseId,
    };
  });
}

export async function convergeFinancialTransaction(
  db: Database,
  input: FinancialConvergenceInput,
  actor: ActorContext,
  evidence?: PreparedMailFinancialEvent,
): Promise<Result> {
  if (input.advice && !input.emailId && !evidence) {
    return withHouseholdWrite(db, async (tx) => {
      const txDb = databaseForTransaction(tx);
      const plan = await previewFinancialSpending(txDb, {
        transactionId: input.transactionId,
        advice: input.advice,
      });
      if (plan.status === "review_required" || plan.status === "deferred")
        return review(plan.reason);
      const result = await commitFinancialSpending(txDb, plan, actor);
      const purchaseId = result?.purchaseIds[0];
      if (!result || !purchaseId)
        return review("The spending plan established no Purchase.");
      return financialConvergenceResult.parse({
        status: result.replayed ? "already_recorded" : "applied",
        purchaseId,
        expenseId: null,
      });
    });
  }
  return financialConvergenceResult.parse(
    await runFinancialConvergence(db, input, actor, evidence),
  );
}

/** Verified exact replacement and provenance writers call this after preserving
 * money, identity and attribution. It runs in that writer's transaction. */
export async function refreshAutomaticBookingFingerprint(
  db: Database,
  transactionId: FinancialConvergenceInput["transactionId"],
) {
  const row = await getDb(db)
    .query.financialTransaction.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(financialTransaction.shortcode, transactionId),
          ),
      },
    })
    .then((row) => (row ? transactionDollars(row) : row));
  if (!row?.bookingDecisionFingerprint?.startsWith("automatic:")) return;
  await getDb(db)
    .update(financialTransaction)
    .set({
      bookingDecisionFingerprint: `automatic:${await acceptedAutomaticFacts(db, transactionId)}`,
      bookingExpenseFingerprint: await digestValue(
        await loadFinancialBookingLineage(db, transactionId),
      ),
    })
    .where(eq(financialTransaction.id, row.id));
}

/** This read uses the writer's policy; queue adapters supply their own labels. */
export async function readFinancialWork(
  db: Database,
  transactionIds: FinancialConvergenceInput["transactionId"][],
  actor: ActorContext,
): Promise<FinancialWorkPreview[]> {
  return Promise.all(
    transactionIds.map(async (transactionId) => {
      const result = await runFinancialConvergence(
        db,
        { transactionId },
        actor,
        undefined,
        true,
      );
      return {
        transactionId,
        canApplyAutomatically: result.status === "ready",
        blocker: result.status === "review_required" ? result.reason : null,
        purchaseId:
          result.status === "review_required" ? null : result.purchaseId,
        vendorId: result.status === "ready" ? result.vendorId : null,
        effect:
          result.status === "ready"
            ? result.action
            : result.status === "already_recorded"
              ? "already_recorded"
              : null,
      };
    }),
  );
}
