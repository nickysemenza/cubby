import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialMailEvent } from "@cubby/schemas/financial-mail-event";
import type {
  EmailId,
  financialAccountShortcode,
  financialTransactionShortcode,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import type { MailSettlementReview } from "@cubby/schemas/mailbox-research";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  emailFinancialAssociation,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

function accountAvailable(
  party: typeof ledgerParty.$inferSelect | undefined,
  actor: ActorContext,
) {
  return (
    party?.kind === "household" ||
    (party?.kind === "member" && party.userId === actor.userId)
  );
}

function sameReviewSet(
  existing: (typeof emailFinancialAssociation.$inferSelect)[],
  ids: (typeof financialTransaction.$inferSelect)["id"][],
) {
  return (
    existing.length === 0 ||
    (existing.length === ids.length &&
      existing.every((row) => ids.includes(row.transactionId)))
  );
}

const reviewedRefundAssociations = (
  db: Database,
  input: { emailId: EmailId; checksum: string },
) =>
  getDb(db)
    .select()
    .from(emailFinancialAssociation)
    .where(
      and(
        eq(emailFinancialAssociation.emailId, input.emailId),
        eq(emailFinancialAssociation.evidenceChecksum, input.checksum),
      ),
    );

async function assertRefundAllocationsExplain(
  db: Database,
  transactions: Pick<
    typeof financialTransaction.$inferSelect,
    "id" | "amount"
  >[],
  purchaseIds: PurchaseId[],
) {
  const allocations = await getDb(db)
    .select()
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(
          financialTransactionAllocation.transactionId,
          transactions.map((row) => row.id),
        ),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .orderBy(
      financialTransactionAllocation.transactionId,
      financialTransactionAllocation.purchaseId,
    )
    .for("update");
  const allocatedPurchases = new Set(allocations.map((row) => row.purchaseId));
  if (
    allocatedPurchases.size !== purchaseIds.length ||
    purchaseIds.some((id) => !allocatedPurchases.has(id)) ||
    transactions.some(
      (row) =>
        allocations
          .filter((allocation) => allocation.transactionId === row.id)
          .reduce(
            (sum, allocation) => sum + Math.round(allocation.amount * 100),
            0,
          ) !== Math.round(row.amount * 100),
    )
  )
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "The refund allocations must explain exactly the reviewed Purchases.",
    );
}

/**
 * A refunded Email's reviewed refund set must explain exactly the Purchases it
 * links as refunded, whether or not this resolution carries a settlement:
 * a later link cannot escape an earlier review, nor a review a subset of links.
 */
export async function reconcileMailRefundReview(
  db: Database,
  input: {
    emailId: EmailId;
    checksum: string;
    purchaseIds: PurchaseId[];
    review: MailSettlementReview | undefined;
  },
  actor: ActorContext,
) {
  if (input.review)
    return recordMailFinancialReview(
      db,
      { ...input, review: input.review },
      actor,
    );
  const existing = await reviewedRefundAssociations(db, input);
  if (!existing.length) return;
  const transactions = await getDb(db)
    .select({
      id: financialTransaction.id,
      amount: financialTransaction.amount,
    })
    .from(financialTransaction)
    .where(
      and(
        inArray(
          financialTransaction.id,
          existing.map((row) => row.transactionId),
        ),
        notDeleted(financialTransaction),
      ),
    )
    .orderBy(financialTransaction.id)
    .for("update");
  // A deleted refund leg no longer constrains the Email; only live reviewed legs do.
  if (!transactions.length) return;
  await assertRefundAllocationsExplain(db, transactions, input.purchaseIds);
}

/** Reviewed evidence only: existing settlement allocations remain the money authority. */
async function recordMailFinancialReview(
  db: Database,
  input: {
    emailId: EmailId;
    checksum: string;
    purchaseIds: PurchaseId[];
    review: MailSettlementReview;
  },
  actor: ActorContext,
) {
  if (actor.runId)
    throw new Error("A refund account mapping requires a member's review.");
  const tx = getDb(db);
  const selected = await Promise.all(
    input.review.associations.map(async (row) => ({
      ...row,
      id: await resolveOrThrow(db, "financialTransaction", row.transactionId),
      accountId: await resolveOrThrow(
        db,
        "financialAccount",
        row.reviewedAccountId,
      ),
    })),
  );
  if (new Set(selected.map((row) => row.id)).size !== selected.length)
    throw new Error("Refund references must resolve to distinct transactions.");
  const transactions = await tx
    .select()
    .from(financialTransaction)
    .where(
      and(
        inArray(
          financialTransaction.id,
          selected.map((row) => row.id),
        ),
        notDeleted(financialTransaction),
      ),
    )
    .orderBy(financialTransaction.id)
    .for("update");
  if (
    transactions.length !== selected.length ||
    transactions.some(
      (row) =>
        row.kind !== "refund" || row.status !== "posted" || row.amount >= 0,
    )
  )
    throw new Error("Every refund reference must name a live posted refund.");
  const accounts = await tx
    .select({ account: financialAccount, party: ledgerParty })
    .from(financialAccount)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, financialAccount.ledgerPartyId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        inArray(
          financialAccount.id,
          selected.map((row) => row.accountId),
        ),
        notDeleted(financialAccount),
      ),
    )
    .orderBy(financialAccount.id)
    .for("update", { of: financialAccount });
  for (const row of selected) {
    const account = accounts.find(
      (candidate) => candidate.account.id === row.accountId,
    );
    if (!accountAvailable(account?.party, actor))
      throw new Error(
        "The reviewed refund account is not available to this member.",
      );
    if (
      transactions.find((candidate) => candidate.id === row.id)?.accountId !==
      row.accountId
    )
      throw new Error(
        "The refund's current account differs from the reviewed account.",
      );
  }
  if (
    transactions.reduce((sum, row) => sum + Math.round(row.amount * 100), 0) !==
    Math.round(input.review.refundAmount * 100)
  )
    throw new Error(
      "The existing refund legs do not equal the reviewed credit amount.",
    );
  await assertRefundAllocationsExplain(db, transactions, input.purchaseIds);
  const existing = await reviewedRefundAssociations(db, input);
  if (
    !sameReviewSet(
      existing,
      selected.map((row) => row.id),
    )
  )
    throw new Error("This Email already has a different reviewed refund set.");
  for (const row of selected) {
    const previous = existing.find(
      (candidate) => candidate.transactionId === row.id,
    );
    if (previous) {
      if (
        previous.reviewedAccountId !== row.accountId ||
        previous.sourceAccountLabel !== row.sourceAccountLabel ||
        previous.reviewReason !== row.reviewReason
      )
        throw new Error(
          "This refund already has a different account review for this Email checksum.",
        );
      continue;
    }
    await tx.insert(emailFinancialAssociation).values({
      emailId: input.emailId,
      evidenceChecksum: input.checksum,
      transactionId: row.id,
      reviewedAccountId: row.accountId,
      sourceAccountLabel: row.sourceAccountLabel,
      reviewReason: row.reviewReason,
      decidedByUserId: actor.userId,
    });
  }
}

/** Financial meaning an Email may evidence without a Purchase, by transaction kind and sign. */
const FINANCIAL_ONLY_MATCHES = {
  refund: { kinds: ["refund", "adjustment"], sign: -1 },
  incoming_payment: {
    kinds: ["income", "account_transfer", "other"],
    sign: -1,
  },
  reimbursement: { kinds: ["income", "account_transfer", "other"], sign: -1 },
  transfer: { kinds: ["account_transfer"], sign: 0 },
  card_repayment: { kinds: ["credit_card_payment"], sign: 0 },
} as const satisfies Record<
  Exclude<FinancialMailEvent["kind"], "purchase_payment">,
  {
    kinds: readonly (typeof financialTransaction.$inferSelect)["kind"][];
    sign: -1 | 1 | 0;
  }
>;

/**
 * Financial-only Email evidence: the Email documents one existing Financial
 * Transaction (a transfer, incoming payment, reimbursement, card repayment or
 * refund) without a Purchase. It writes provenance only, never spending.
 * A member's review is the authority for their own choice; a Mail import Run
 * reuses only an exact accepted Email/checksum/transaction/account mapping
 * with matching event meaning and money. An unqualified identifier cannot
 * establish a financial provider namespace.
 */
export async function recordMailFinancialEvidence(
  db: Database,
  input: {
    emailId: EmailId;
    checksum: string;
    transactionId: z.infer<typeof financialTransactionShortcode>;
    reason: string;
    review?: {
      reviewedAccountId: z.infer<typeof financialAccountShortcode>;
      sourceAccountLabel: string;
    };
    /** Required under a Mail import Run: the revalidated event of this Email. */
    event?: FinancialMailEvent;
  },
  actor: ActorContext,
) {
  const tx = getDb(db);
  const transactionId = await resolveOrThrow(
    db,
    "financialTransaction",
    input.transactionId,
  );
  const [transaction] = await tx
    .select()
    .from(financialTransaction)
    .where(
      and(
        eq(financialTransaction.id, transactionId),
        notDeleted(financialTransaction),
      ),
    )
    .for("update");
  if (!transaction || transaction.status !== "posted")
    throw new Error(
      "Financial Email evidence must name a live posted transaction.",
    );
  const [account] = await tx
    .select({ account: financialAccount, party: ledgerParty })
    .from(financialAccount)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, financialAccount.ledgerPartyId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(financialAccount.id, transaction.accountId),
        notDeleted(financialAccount),
      ),
    )
    .for("update", { of: financialAccount });
  if (!account || !accountAvailable(account.party, actor))
    throw new Error(
      "The transaction's account is not available to this member.",
    );
  let sourceAccountLabel: string;
  let reviewReason: string;
  const existing = await tx
    .select()
    .from(emailFinancialAssociation)
    .where(
      and(
        eq(emailFinancialAssociation.emailId, input.emailId),
        eq(emailFinancialAssociation.evidenceChecksum, input.checksum),
      ),
    );
  if (actor.runId) {
    const event = input.event;
    if (!event || event.kind === "purchase_payment")
      throw new Error(
        "A Mail import Run associates only a verified non-purchase financial event; finance.converge books purchase payments.",
      );
    const match = FINANCIAL_ONLY_MATCHES[event.kind];
    const cents = Math.round(transaction.amount * 100);
    if (
      !match.kinds.some((kind) => kind === transaction.kind) ||
      (match.sign !== 0 && Math.sign(cents) !== match.sign) ||
      Math.abs(cents) !== event.amount.minor ||
      event.amount.currency !== "USD"
    )
      throw new Error(
        `The Email's ${event.kind} does not match the transaction's kind, direction or amount.`,
      );
    const accepted = existing[0];
    if (
      existing.length !== 1 ||
      !accepted ||
      accepted.transactionId !== transaction.id ||
      accepted.reviewedAccountId !== transaction.accountId ||
      (event.sourceAccountLabel &&
        event.sourceAccountLabel !== accepted.sourceAccountLabel)
    )
      throw new Error(
        "Cannot verify a cross-provider financial association without current member-accepted Email, checksum, transaction and account evidence.",
      );
    sourceAccountLabel = accepted.sourceAccountLabel;
    reviewReason = accepted.reviewReason;
  } else {
    if (!input.review)
      throw new Error(
        "Name the reviewed account and its label as the Email shows it.",
      );
    const reviewedAccountId = await resolveOrThrow(
      db,
      "financialAccount",
      input.review.reviewedAccountId,
    );
    if (reviewedAccountId !== transaction.accountId)
      throw new Error(
        "The transaction's current account differs from the reviewed account.",
      );
    sourceAccountLabel = input.review.sourceAccountLabel;
    reviewReason = input.reason;
  }
  if (!sameReviewSet(existing, [transaction.id]))
    throw new Error(
      "This Email already evidences a different transaction set.",
    );
  const [previous] = existing;
  if (previous) {
    if (
      previous.reviewedAccountId !== transaction.accountId ||
      previous.sourceAccountLabel !== sourceAccountLabel
    )
      throw new Error(
        "This transaction already has a different account review for this Email checksum.",
      );
    return;
  }
  await tx.insert(emailFinancialAssociation).values({
    emailId: input.emailId,
    evidenceChecksum: input.checksum,
    transactionId: transaction.id,
    reviewedAccountId: transaction.accountId,
    sourceAccountLabel,
    reviewReason,
    decidedByUserId: actor.userId,
  });
}
