import type { ActorContext } from "@cubby/schemas/context";
import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import {
  type ExpenseShortcode,
  type FinancialTransactionShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  entityAttachment,
  financialTransaction,
  financialTransactionAllocation,
  purchase,
  sourceTransactionRecord,
} from "~/server/db/schema";
import {
  deleteExpenses,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { refreshDerivedSearchRefs } from "~/server/entity-kernel/repo/mutation-side-effects";
import { isBlockedRefusal } from "~/server/errors/app-error";
import { assertAutomaticRuleOn } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { ruleBase } from "~/server/generic/assessment/repo/automatic-rules";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";

import {
  bookingGraph,
  digestValue,
  loadFinancialBookingLineage,
} from "./financial-booking";
import {
  acceptedAutomaticFacts,
  refreshAutomaticBookingFingerprint,
} from "./financial-convergence";
import { updateFinancialTransaction } from "./financial-transaction";

type Observation = typeof sourceTransactionRecord.$inferSelect;
type EvidenceVerification =
  | { status: "verified" }
  | { status: "review"; reason: string };

export type FinancialEvidenceCorrectionInput = Pick<
  Observation,
  "source" | "externalId"
> & {
  transactionId: FinancialTransactionShortcode;
  /** Null means confirmed withdrawal, never an unknown or zero amount. */
  amount: number | null;
  /**
   * Intake-owned DB-only proof, rerun inside each snapshot attempt before writes.
   * Use only this transaction-bound Database. Verify the observation's accepted
   * transaction identity and all current corroborating sources (including sources
   * whose retained references name older observations). Amount changes require
   * agreement; withdrawal requires complete same-account/window coverage and no
   * remaining current support, replacement identity, or unresolved date movement.
   * No provider calls, writes, scheduling, or externally captured proof snapshots.
   * The caller retains evidence and publishes a correction Suggestion on review.
   */
  verifyCurrentEvidence: (
    db: Database,
    observation: Observation,
  ) => Promise<EvidenceVerification>;
};

export type FinancialEvidenceCorrectionResult =
  | { status: "corrected"; reason: "amount_changed" | "source_withdrawn" }
  | { status: "unchanged"; reason: "already_current" | "already_withdrawn" }
  | { status: "review"; reason: string };

type Review = Extract<FinancialEvidenceCorrectionResult, { status: "review" }>;
const review = (reason: string): Review => ({
  status: "review",
  reason,
});

async function loadCorrectionObservation(
  db: Database,
  input: FinancialEvidenceCorrectionInput,
): Promise<{ status: "verified"; observation: Observation } | Review> {
  const observation = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: and(
      eq(sourceTransactionRecord.source, input.source),
      eq(sourceTransactionRecord.externalId, input.externalId),
      notDeleted(sourceTransactionRecord),
    ),
  });
  if (!observation)
    return review("The retained source observation is missing.");
  if (input.amount === null) {
    if (observation.withdrawnAt === null)
      return review("The source observation has no confirmed withdrawal.");
  } else {
    if (
      !Number.isFinite(input.amount) ||
      input.amount === 0 ||
      Math.abs(input.amount * 100 - cents(input.amount)) >= 0.0000001
    )
      return review("A correction requires a nonzero whole-cent amount.");
    if (
      !observation.current ||
      observation.withdrawnAt !== null ||
      observation.supersededByRowId !== null
    )
      return review("The source observation is no longer current.");
    if (cents(observation.amount) !== cents(input.amount))
      return review(
        "The requested amount disagrees with retained current source evidence.",
      );
  }
  return { status: "verified", observation };
}

function isRetiredBooking(
  row: typeof financialTransaction.$inferSelect,
  lineage: Awaited<ReturnType<typeof loadFinancialBookingLineage>>,
  allocationCount: number,
): boolean {
  return (
    row.status === "void" &&
    lineage.lines.length === 0 &&
    lineage.attributions.length === 0 &&
    lineage.sourceClaims.length === 0 &&
    allocationCount === 0
  );
}

async function retireGeneratedExpense(
  db: Database,
  code: ExpenseShortcode,
  actor: ActorContext,
): Promise<{ status: "retired" } | Review> {
  try {
    await deleteExpenses(db, [code], actor);
    return { status: "retired" };
  } catch (error) {
    // The supported delete's savepoint has rolled back before returning review.
    if (isBlockedRefusal(error))
      return review(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function correctionAuthority(
  db: Database,
): Promise<EvidenceVerification> {
  const key = "statement_transaction.book_spending";
  try {
    await assertAutomaticRuleOn(db, key, ruleBase(key), null);
    return { status: "verified" };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Automatic rule ${key} is off; review the suggestion`
    )
      return review(error.message);
    throw error;
  }
}

const isSameAmount = (amount: number | null, current: number) =>
  amount !== null && cents(amount) === cents(current);

const changesMoneyDirection = (amount: number | null, current: number) =>
  amount !== null && Math.sign(amount) !== Math.sign(current);

const hasSourceUpdates = (
  previousRefs: number,
  currentRefs: number,
  lifecycle: ReturnType<typeof sourceLifecycle>,
) => previousRefs !== currentRefs || Object.keys(lifecycle).length > 0;

function sourceLifecycle(
  observation: typeof sourceTransactionRecord.$inferSelect,
  row: typeof financialTransaction.$inferSelect,
) {
  if (
    observation.providerStatus === "posted" &&
    (row.status !== "posted" || row.postedDate !== observation.statementDate)
  )
    return { status: "posted" as const, postedDate: observation.statementDate };
  if (
    observation.providerStatus === "pending" &&
    row.status !== "posted" &&
    (row.status !== "pending" ||
      row.transactionDate !== observation.statementDate)
  )
    return {
      status: "pending" as const,
      transactionDate: observation.statementDate,
    };
  return {};
}

function changesFundingDate(
  row: typeof financialTransaction.$inferSelect,
  lifecycle: ReturnType<typeof sourceLifecycle>,
) {
  const projectedDate =
    lifecycle.transactionDate ??
    row.transactionDate ??
    lifecycle.postedDate ??
    row.postedDate;
  return projectedDate !== (row.transactionDate ?? row.postedDate);
}

/**
 * Correct one untouched generated lump booking, retaining every observation,
 * settlement reference, attribution share and reviewed correction receipt.
 * Caller-owned transactions must supply snapshot/serializable isolation too.
 */
export async function reconcileFinancialEvidenceCorrection(
  db: Database,
  input: FinancialEvidenceCorrectionInput,
  actor: ActorContext,
): Promise<FinancialEvidenceCorrectionResult> {
  return withSnapshotWrite(
    db,
    async (tx): Promise<FinancialEvidenceCorrectionResult> => {
      await lockFinancialEvidenceKeys(tx, "reviewed-booking", [
        input.transactionId,
      ]);
      const txDb = databaseForTransaction(tx);
      const source = await loadCorrectionObservation(txDb, input);
      if (source.status === "review") return source;
      const { observation } = source;
      const row = await tx.query.financialTransaction.findFirst({
        where: and(
          eq(financialTransaction.shortcode, input.transactionId),
          notDeleted(financialTransaction),
        ),
      });
      if (!row) return review("The financial transaction is no longer live.");
      if (observation.accountId !== row.accountId)
        return review(
          "The source observation does not identify the transaction's account.",
        );
      const refs = (await settlementRefsFor(txDb, [row.id])).get(row.id) ?? [];
      const sourceRefs = refs.filter((ref) => ref.source === input.source);
      const acceptedObservation = sourceRefs.length
        ? await tx.query.sourceTransactionRecord.findFirst({
            where: and(
              eq(sourceTransactionRecord.source, input.source),
              eq(sourceTransactionRecord.chargeKey, observation.chargeKey),
              or(
                inArray(
                  sourceTransactionRecord.externalId,
                  sourceRefs.map((ref) => ref.externalId),
                ),
                inArray(
                  sourceTransactionRecord.legacyReference,
                  sourceRefs.map((ref) => ref.externalId),
                ),
              ),
              notDeleted(sourceTransactionRecord),
            ),
          })
        : undefined;
      if (!acceptedObservation)
        return review(
          "The source charge is not accepted evidence for this transaction.",
        );
      const nextRefs = refs.some(
        (ref) =>
          ref.source === input.source && ref.externalId === input.externalId,
      )
        ? refs
        : [...refs, { source: input.source, externalId: input.externalId }];
      const verification = await input.verifyCurrentEvidence(txDb, observation);
      if (verification.status === "review") return verification;
      if (
        row.ledgerTransferId ||
        !purchaseSettlementKinds.some((kind) => kind === row.kind)
      )
        return review(
          "Transfer or non-spending evidence requires individual review.",
        );
      if (row.bookingCorrectionReceipt)
        return review("This booking already has a reviewed correction.");
      const lineage = await loadFinancialBookingLineage(
        txDb,
        input.transactionId,
      );
      const allocations =
        await tx.query.financialTransactionAllocation.findMany({
          where: and(
            eq(financialTransactionAllocation.transactionId, row.id),
            notDeleted(financialTransactionAllocation),
          ),
        });
      const allocatedPurchase = allocations[0];
      if (allocatedPurchase) {
        const target = await tx.query.purchase.findFirst({
          where: and(
            eq(purchase.id, allocatedPurchase.purchaseId),
            notDeleted(purchase),
          ),
        });
        if (!target) return review("The allocated Purchase is no longer live.");
      }
      if (
        !row.bookingExpenseFingerprint ||
        row.bookingExpenseFingerprint !== (await digestValue(lineage))
      )
        return review(
          "The generated booking was edited or its live lineage changed.",
        );
      if (
        !row.bookingDecisionFingerprint?.startsWith("automatic:") ||
        row.bookingDecisionFingerprint !==
          `automatic:${await acceptedAutomaticFacts(txDb, input.transactionId)}`
      )
        return review(
          "The accepted automatic booking facts changed or require member review.",
        );
      if (
        input.amount === null &&
        isRetiredBooking(row, lineage, allocations.length)
      )
        return { status: "unchanged", reason: "already_withdrawn" };
      if (row.status === "void")
        return review("The transaction is already void.");
      const line = lineage.lines[0];
      const allocation = allocations[0];
      if (
        lineage.lines.length !== 1 ||
        !line ||
        line.future ||
        line.cost === null ||
        line.lineBasis !== "allocation" ||
        line.lineKind !== "principal" ||
        line.productId !== null ||
        !line.purchaseId ||
        lineage.sourceClaims.length > 0 ||
        row.itemizationExpectation === "required"
      )
        return review(
          "Only an untouched generated lump Expense without source claims can be corrected automatically.",
        );
      if (
        allocations.length !== 1 ||
        !allocation ||
        allocation.purchaseId !== line.purchaseId ||
        cents(allocation.amount) !== cents(row.amount) ||
        cents(line.cost) !== cents(row.amount)
      )
        return review(
          "The generated Expense, allocation and transaction no longer agree.",
        );
      const graph = await bookingGraph(txDb, line.purchaseId);
      if (
        !graph.target ||
        graph.lines.length !== 1 ||
        graph.lines[0]?.id !== line.id
      )
        return review("The Purchase has independent or itemized Expenses.");
      const document = await tx.query.entityAttachment.findFirst({
        where: and(
          inArray(entityAttachment.entityId, [
            row.id,
            line.id,
            line.purchaseId,
          ]),
          notDeleted(entityAttachment),
        ),
      });
      if (document)
        return review("The booking has independent attached evidence.");
      if (changesMoneyDirection(input.amount, row.amount))
        return review(
          "A source revision changed the transaction's money direction.",
        );
      const lifecycle = sourceLifecycle(observation, row);
      // Funding authority and generated Expense dates were accepted for the
      // original effective date; a new date needs its own reviewed allocation.
      if (changesFundingDate(row, lifecycle))
        return review(
          "The source date changed the booking's funding date. Review its dated allocations and Expenses individually.",
        );
      if (isSameAmount(input.amount, row.amount)) {
        if (hasSourceUpdates(refs.length, nextRefs.length, lifecycle)) {
          await updateFinancialTransaction(
            txDb,
            input.transactionId,
            { sourceRefs: nextRefs, ...lifecycle },
            actor,
          );
          await refreshAutomaticBookingFingerprint(txDb, input.transactionId);
        }
        return { status: "unchanged", reason: "already_current" };
      }

      const authority = await correctionAuthority(txDb);
      if (authority.status === "review") return authority;
      const expenseCode = parseShortcodeFor("expense", line.shortcode);
      if (input.amount === null) {
        // The supported delete preserves tombstones, attribution history and audit;
        // source observations and settlement references remain attached to the FTX.
        const retired = await retireGeneratedExpense(txDb, expenseCode, actor);
        if (retired.status === "review") return retired;
        await updateFinancialTransaction(
          txDb,
          input.transactionId,
          { status: "void", allocations: [], sourceRefs: nextRefs },
          actor,
        );
      } else {
        // Attribution rows hold unitless shares. Cost-only updates preserve the
        // exact line structure and member parties instead of redistributing them.
        await updateExpense(
          txDb,
          expenseCode,
          { cost: observation.amount },
          actor,
        );
        await updateFinancialTransaction(
          txDb,
          input.transactionId,
          {
            amount: observation.amount,
            ...lifecycle,
            allocations: [
              {
                purchaseId: parseShortcodeFor(
                  "purchase",
                  graph.target.shortcode,
                ),
                amount: observation.amount,
              },
            ],
            sourceRefs: nextRefs,
          },
          actor,
        );
      }
      await refreshAutomaticBookingFingerprint(txDb, input.transactionId);
      await refreshDerivedSearchRefs(
        txDb,
        [
          { entityKind: "financialTransaction", entityId: row.id },
          { entityKind: "purchase", entityId: line.purchaseId },
          { entityKind: "expense", entityId: line.id },
        ],
        "financialTransaction.correctEvidence",
      );
      return {
        status: "corrected",
        reason: input.amount === null ? "source_withdrawn" : "amount_changed",
      };
    },
    { isolationLevel: "serializable" },
  );
}
