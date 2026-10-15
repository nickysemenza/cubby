import type { ActorContext } from "@cubby/schemas/context";
import type { EmailId, PurchaseId } from "@cubby/schemas/identifiers";
import type { MailSettlementReview } from "@cubby/schemas/mailbox-research";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  emailFinancialAssociation,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
} from "~/server/db/schema";
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

/** Reviewed evidence only: existing settlement allocations remain the money authority. */
export async function recordMailFinancialReview(
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
  const allocations = await tx
    .select()
    .from(financialTransactionAllocation)
    .where(
      and(
        inArray(
          financialTransactionAllocation.transactionId,
          selected.map((row) => row.id),
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
    allocatedPurchases.size !== input.purchaseIds.length ||
    input.purchaseIds.some((id) => !allocatedPurchases.has(id)) ||
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
    throw new Error(
      "The refund allocations must explain exactly the reviewed Purchases.",
    );
  const existing = await tx
    .select()
    .from(emailFinancialAssociation)
    .where(
      and(
        eq(emailFinancialAssociation.emailId, input.emailId),
        eq(emailFinancialAssociation.evidenceChecksum, input.checksum),
      ),
    );
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
