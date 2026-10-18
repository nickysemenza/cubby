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
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
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
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  assertMailFinancialEvidenceCurrent,
  type PreparedMailFinancialEvent,
} from "~/server/domains/purchase-import/repo/mail-financial-event";
import { normalizeMerchant } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { AppError } from "~/server/errors/app-error";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  commitFinancialBooking,
  bookingGraph,
  digestValue,
  loadFinancialBookingLineage,
  previewFinancialBooking,
} from "./financial-booking";
import { updateFinancialTransaction } from "./financial-transaction";
import { findSettlementConflicts } from "./settlement-conflicts";

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
  const row = await getDb(db).query.financialTransaction.findFirst({
    where: eq(financialTransaction.shortcode, transactionId),
  });
  if (!row) return null;
  const account = await getDb(db).query.financialAccount.findFirst({
    where: (a, { eq }) => eq(a.id, row.accountId),
  });
  const allocations = await getDb(db)
    .select({
      purchaseId: financialTransactionAllocation.purchaseId,
      amount: financialTransactionAllocation.amount,
    })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.transactionId, row.id),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .orderBy(financialTransactionAllocation.purchaseId);
  const target = allocations[0]
    ? await getDb(db).query.purchase.findFirst({
        where: eq(purchase.id, allocations[0].purchaseId),
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
          provisional: account.provisional,
          deletedAt: account.deletedAt,
        }
      : null,
    allocations,
    sourceRefs: (await settlementRefsFor(db, [row.id])).get(row.id) ?? [],
    expenses: graph.lines,
    attributions: graph.attributions,
    purchase: target
      ? {
          vendorId: target.vendorId,
          vendorAccountId: target.vendorAccountId,
          date: target.date,
          orderId: target.orderId,
          statedTotal: target.statedTotal,
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
  row: typeof financialTransaction.$inferSelect,
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
    where: (a, { eq }) => eq(a.id, row.accountId),
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
  const vendors = await tx
    .select()
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        sql`lower(btrim(${vendor.name})) = ${normalizeMerchant(mailEvent.counterpartyLabel)} OR (${notDeleted(vendor)} AND EXISTS (SELECT 1 FROM unnest(${vendor.aliases}) label WHERE lower(btrim(label)) = ${normalizeMerchant(mailEvent.counterpartyLabel)}))`,
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
  await lockFinancialEvidenceKeys(tx, "transaction-ref", [
    `${eventRef.source}\u0000${eventRef.externalId}`,
  ]);
  const previousIdentity = await tx.execute<{ id: string }>(
    sql`SELECT x."entityId" AS id FROM "EntityExternalId" x WHERE x.source = ${eventRef.source} AND x.kind = 'settlement_ref' AND x."externalId" = ${eventRef.externalId} AND x."deletedAt" IS NULL`,
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
  JOIN "Purchase" p ON p.id = evidence."purchaseId" AND p."deletedAt" IS NULL
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
  row: typeof financialTransaction.$inferSelect,
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
      cents(target.statedTotal) !== cents(row.amount)
    )
      return review(
        "The Purchase's literal total differs from this payment; reconcile split or installment money before booking.",
      );
    const existingLines = await tx.execute<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM "Expense" e WHERE e."purchaseId" = ${target.id} AND e."deletedAt" IS NULL) AS present`,
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
  return withTransaction(
    db,
    async (tx) => {
      await lockFinancialEvidenceKeys(tx, "reviewed-booking", [
        input.transactionId,
      ]);
      const txDb = databaseForTransaction(tx);
      const id = await resolveOrThrow(
        txDb,
        "financialTransaction",
        input.transactionId,
      );
      // Match the settlement writer's global lock order: accepted Purchases
      // precede the transaction, including a target proved by the current Email.
      await tx.execute(sql`
        SELECT p.id FROM "Purchase" p WHERE p."deletedAt" IS NULL AND (
          EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a
            WHERE a."purchaseId" = p.id AND a."transactionId" = ${id} AND a."deletedAt" IS NULL)
          OR p.id IN (SELECT association."purchaseId" FROM "Email"
            CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) association
            WHERE "Email".id = ${evidence?.emailId ?? null}::uuid AND NOT association.changed
              AND association.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked}))
        ) ORDER BY p.id FOR UPDATE`);
      const [row] = await tx
        .select()
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.id, id),
            notDeleted(financialTransaction),
          ),
        )
        .for("update");
      if (
        !row ||
        row.status !== "posted" ||
        row.kind !== "purchase" ||
        row.amount <= 0 ||
        row.ledgerTransferId
      )
        return review(
          "Automatic booking requires a posted purchase payment. Transfers, repayments, refunds, reimbursements and incoming payments retain their meaning.",
        );
      // The funder on the charge date (a lag-safe posting date when only that
      // is known) is the household or the member, and the member owns the
      // account or holds the card: a household-funded card owned by another
      // member's party is still its cardholder's to settle.
      const window = paymentDateWindowSql(sql`payment`);
      const accountAuthority = await tx.execute<{ authorized: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "FinancialAccount" a
        JOIN "FinancialTransaction" payment ON payment.id = ${row.id} AND payment."deletedAt" IS NULL
        JOIN "LedgerParty" funder ON funder.id = ${paymentFundingPartySql(sql`a`, sql`payment`)} AND funder."deletedAt" IS NULL
        LEFT JOIN "LedgerParty" owner ON owner.id = a."ledgerPartyId" AND owner."deletedAt" IS NULL
        LEFT JOIN "LedgerParty" member ON member."userId" = ${actor.userId} AND member.kind = ${ledgerPartyKind.enum.member} AND member."deletedAt" IS NULL
        WHERE a.id = ${row.accountId} AND a."deletedAt" IS NULL AND NOT a.provisional
          AND (funder.kind = ${ledgerPartyKind.enum.household} OR funder.id = member.id)
          AND (
            owner.kind = ${ledgerPartyKind.enum.household}
            OR owner.id = member.id
            OR a."primaryCardholderId" = member.id
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(a."authorizedUsers") period
              WHERE period->>'ledgerPartyId' = member.shortcode
                AND (period->>'validFrom' IS NULL OR (period->>'validFrom')::date <= ${window.from})
                AND (period->>'validTo' IS NULL OR ${window.to} <= (period->>'validTo')::date)
            )
          )
      ) AS authorized`);
      if (!accountAuthority.rows[0]?.authorized)
        return review(
          "The payment needs a dated, confirmed funding account available to this member: the household or the member funds it on the charge date, and the member owns the account, is its primary cardholder, or is an authorized user then.",
        );
      const refs = (await settlementRefsFor(tx, [row.id])).get(row.id) ?? [];
      if (!refs.length)
        return review("The payment has no stable source identity.");
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
        .for("update");
      if (
        allocations.length > 1 ||
        (allocations[0] && cents(allocations[0].amount) !== cents(row.amount))
      )
        return review(
          "Split or incomplete accepted allocations require individual reconciliation.",
        );
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
      if (!purchaseId && !vendorId)
        return review(
          "No accepted Purchase identity or verified genuine financial payment establishes a new order.",
        );
      const target = purchaseId
        ? await tx.query.purchase.findFirst({
            where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
          })
        : undefined;
      if (
        purchaseId &&
        (!target || (vendorId && target.vendorId !== vendorId.id))
      )
        return review(
          "The accepted Purchase is missing or conflicts with the verified Vendor.",
        );
      const acceptedVendor = target?.vendorId
        ? await tx.query.vendor.findFirst({
            where: and(eq(vendor.id, target.vendorId), notDeleted(vendor)),
          })
        : undefined;
      if (target && !acceptedVendor)
        return review(
          "Resolve the accepted Purchase's live Vendor before automatic booking.",
        );
      if (target) {
        const conflicts = await findSettlementConflicts(tx, {
          accountId: row.accountId,
          kind: financialTransactionKind.parse(row.kind),
          transactionDate: row.transactionDate,
          purchaseIds: [target.id],
        });
        if (conflicts.has(target.id))
          return review(
            "This payment's account conflicts with the Purchase (another member's account, or not an account its payment evidence names); settle it by review.",
          );
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
        if (
          !target ||
          !allocations.length ||
          row.bookingDecisionFingerprint !==
            `automatic:${await acceptedAutomaticFacts(txDb, input.transactionId)}` ||
          !row.bookingExpenseFingerprint ||
          row.bookingExpenseFingerprint !==
            (await digestValue(
              await loadFinancialBookingLineage(txDb, input.transactionId),
            ))
        )
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
    },
    { isolationLevel: "serializable" },
  );
}

export async function convergeFinancialTransaction(
  db: Database,
  input: FinancialConvergenceInput,
  actor: ActorContext,
  evidence?: PreparedMailFinancialEvent,
): Promise<Result> {
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
  const row = await getDb(db).query.financialTransaction.findFirst({
    where: eq(financialTransaction.shortcode, transactionId),
  });
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
