import type { ActorContext } from "@cubby/schemas/context";
import {
  financialBookingCorrectionInput,
  financialBookingCorrectionPreview,
  financialBookingCorrectionResult,
  type FinancialBookingCorrectionInput,
  type FinancialBookingCorrectionPreview,
} from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { financialTransaction, purchase } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import {
  getDb,
  notDeleted,
  withTransaction,
  databaseForTransaction,
} from "./database-helpers";
import { deleteExpenses, updateExpense } from "./expense";
import { digestValue, loadFinancialBookingLineage } from "./financial-booking";
import { lockFinancialEvidenceKeys } from "./financial-evidence";
import { updateFinancialTransaction } from "./financial-transaction";
import {
  getLedgerTransferByShortcode,
  updateLedgerTransfer,
} from "./ledger-transfer";
import { resolveOrThrow } from "./shortcode-resolver";

const fail = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
async function reimbursementDestination(
  db: Database,
  purchaseCode: Extract<
    FinancialBookingCorrectionInput["action"],
    { kind: "attach_reimbursement" }
  >["purchaseId"],
  amount: number,
  lineage: Awaited<ReturnType<typeof loadFinancialBookingLineage>>,
) {
  let projectName: string | null = null;
  if (
    amount >= 0 ||
    lineage.lines.some((line) => line.economicRole !== "reimbursement")
  )
    return fail(
      "Only reimbursement credits can move to the original Purchase.",
    );
  const purchaseId = await resolveOrThrow(db, "purchase", purchaseCode);
  const target = await getDb(db).query.purchase.findFirst({
    where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
  });
  if (!target?.spendingCategoryId)
    return fail(
      "Categorize the original Purchase before attaching its reimbursement.",
    );
  const category = await getDb(db).query.spendingCategory.findFirst({
    where: (category, { eq, isNull }) =>
      and(
        eq(category.id, target!.spendingCategoryId!),
        isNull(category.deletedAt),
      ),
  });
  if (!category)
    return fail("The original Purchase's category is no longer live.");
  const categoryName = category.name;
  let trade = target.defaultTrade;
  if (target.defaultProjectId) {
    const project = await getDb(db).query.project.findFirst({
      where: (project, { eq, isNull }) =>
        and(
          eq(project.id, target!.defaultProjectId!),
          isNull(project.deletedAt),
        ),
    });
    projectName = project?.name ?? null;
    trade ??= project?.defaultTrade ?? null;
  }
  const targetName = target.displayLabel ?? target.orderId ?? target.shortcode;
  return { target, targetName, categoryName, projectName, trade };
}
export async function previewFinancialBookingCorrection(
  db: Database,
  raw: FinancialBookingCorrectionInput,
) {
  const input = financialBookingCorrectionInput.parse(raw);
  const id = await resolveOrThrow(
    db,
    "financialTransaction",
    input.transactionId,
  );
  const row = await getDb(db).query.financialTransaction.findFirst({
    where: and(
      eq(financialTransaction.id, id),
      notDeleted(financialTransaction),
    ),
  });
  if (!row || row.status !== "posted" || row.ledgerTransferId)
    return fail("Choose a live posted booking before correcting it.");
  const lineage = await loadFinancialBookingLineage(db, input.transactionId);
  if (lineage.sourceClaims.length > 0)
    return fail(
      "This Expense has source claims that require individual review.",
    );
  if (
    !lineage.lines.length ||
    lineage.lines.some(
      (line) =>
        line.future ||
        line.cost === null ||
        line.lineBasis !== "allocation" ||
        line.productId !== null,
    )
  )
    return fail(
      "Only reviewed aggregate bookings can be corrected here. Review edited or itemized Expenses individually.",
    );
  if (
    lineage.lines.reduce(
      (sum, line) => sum + Math.round((line.cost ?? 0) * 100),
      0,
    ) !== Math.round(row.amount * 100)
  )
    return fail("The booked Expense amount no longer matches its transaction.");
  const originalFingerprint = await digestValue(lineage);
  if (
    !row.bookingExpenseFingerprint ||
    row.bookingExpenseFingerprint !== originalFingerprint
  )
    return fail(
      "The original booking was edited. Review its Expense changes before correcting settlement.",
    );
  const allocations = await getDb(
    db,
  ).query.financialTransactionAllocation.findMany({
    where: (allocation, { eq, isNull }) =>
      and(eq(allocation.transactionId, id), isNull(allocation.deletedAt)),
  });
  if (
    allocations.length !== 1 ||
    lineage.lines.some((line) => line.purchaseId !== allocations[0]?.purchaseId)
  )
    return fail("The original booking allocation changed.");
  let targetName: string;
  let categoryName: string | null = null;
  let projectName: string | null = null;
  let trade: FinancialBookingCorrectionPreview["trade"] = null;
  let target;
  if (input.action.kind === "attach_reimbursement") {
    const destination = await reimbursementDestination(
      db,
      input.action.purchaseId,
      row.amount,
      lineage,
    );
    ({ target, targetName, categoryName, projectName, trade } = destination);
  } else {
    target = await getLedgerTransferByShortcode(db, input.action.transferId);
    if (!target) return fail("The selected transfer is no longer live.");
    if (
      Math.round(target.amount * 100) !== Math.round(Math.abs(row.amount) * 100)
    )
      return fail("The transfer amount must match the transaction.");
    targetName = `${target.fromPartyName} → ${target.toPartyName}`;
  }
  const snapshot = await digestValue({
    input,
    row,
    lineage,
    allocations,
    target,
  });
  return financialBookingCorrectionPreview.parse({
    ...input,
    snapshot,
    targetName,
    categoryName,
    projectName,
    trade,
    amount: row.amount,
    lines: lineage.lines.map((line) => ({
      expenseId: parseShortcodeFor("expense", line.shortcode),
      title: line.name,
      amount: line.cost,
      notes: line.notes,
    })),
  });
}
export async function commitFinancialBookingCorrection(
  db: Database,
  review: FinancialBookingCorrectionPreview,
  actor: ActorContext,
) {
  return withTransaction(
    db,
    async (tx) => {
      await lockFinancialEvidenceKeys(tx, "reviewed-booking", [
        review.transactionId,
      ]);
      const txDb = databaseForTransaction(tx);
      const decisionDigest = await digestValue(
        financialBookingCorrectionPreview.parse(review),
      );
      const transactionId = await resolveOrThrow(
        txDb,
        "financialTransaction",
        review.transactionId,
      );
      const current = await getDb(txDb).query.financialTransaction.findFirst({
        where: and(
          eq(financialTransaction.id, transactionId),
          notDeleted(financialTransaction),
        ),
      });
      if (current?.bookingCorrectionReceipt) {
        const receipt = z
          .object({
            digest: z.string(),
            result: financialBookingCorrectionResult,
          })
          .parse(current.bookingCorrectionReceipt);
        if (receipt.digest === decisionDigest) return receipt.result;
        return fail(
          "This booking already has a different reviewed correction. Refresh its financial record.",
        );
      }
      const fresh = await previewFinancialBookingCorrection(txDb, review);
      if (
        JSON.stringify(fresh) !==
        JSON.stringify(financialBookingCorrectionPreview.parse(review))
      )
        return fail("The correction changed after review. Preview it again.");
      const id = await resolveOrThrow(
        txDb,
        "financialTransaction",
        review.transactionId,
      );
      if (review.action.kind === "attach_reimbursement") {
        const targetId = await resolveOrThrow(
          txDb,
          "purchase",
          review.action.purchaseId,
        );
        const target = await getDb(txDb).query.purchase.findFirst({
          where: eq(purchase.id, targetId),
        });
        const category = await getDb(txDb).query.spendingCategory.findFirst({
          where: (category, { eq }) =>
            eq(category.id, target!.spendingCategoryId!),
        });
        for (const line of review.lines)
          await updateExpense(
            txDb,
            line.expenseId,
            { purchaseId: review.action.purchaseId, spendingCategoryId: null },
            actor,
          );
        await updateFinancialTransaction(
          txDb,
          review.transactionId,
          {
            allocations: [
              { purchaseId: review.action.purchaseId, amount: review.amount },
            ],
            spendingCategoryId: parseShortcodeFor(
              "spendingCategory",
              category!.shortcode,
            ),
          },
          actor,
        );
        await getDb(txDb)
          .update(financialTransaction)
          .set({
            bookingExpenseFingerprint: await digestValue(
              await loadFinancialBookingLineage(txDb, review.transactionId),
            ),
          })
          .where(eq(financialTransaction.id, id));
        const result = financialBookingCorrectionResult.parse({
          transactionId: review.transactionId,
          purchaseId: review.action.purchaseId,
          transferId: null,
          retiredExpenseIds: [],
        });
        await getDb(txDb)
          .update(financialTransaction)
          .set({
            bookingDecisionFingerprint: `corrected:${decisionDigest}`,
            bookingCorrectionReceipt: { digest: decisionDigest, result },
          })
          .where(eq(financialTransaction.id, id));
        return result;
      }
      const target = await getLedgerTransferByShortcode(
        txDb,
        review.action.transferId,
      );
      if (!target) return fail("The selected transfer is no longer live.");
      await deleteExpenses(
        txDb,
        review.lines.map((line) => line.expenseId),
        actor,
      );
      await updateFinancialTransaction(
        txDb,
        review.transactionId,
        { allocations: [], kind: "account_transfer" },
        actor,
      );
      await updateLedgerTransfer(
        txDb,
        review.action.transferId,
        {
          evidenceTransactionIds: [
            ...target.evidenceTransactionIds.filter(
              (code) => code !== review.transactionId,
            ),
            review.transactionId,
          ],
        },
        actor,
      );
      const result = financialBookingCorrectionResult.parse({
        transactionId: review.transactionId,
        purchaseId: null,
        transferId: review.action.transferId,
        retiredExpenseIds: review.lines.map((line) => line.expenseId),
      });
      await getDb(txDb)
        .update(financialTransaction)
        .set({
          bookingDecisionFingerprint: `corrected:${decisionDigest}`,
          bookingCorrectionReceipt: { digest: decisionDigest, result },
        })
        .where(eq(financialTransaction.id, id));
      return result;
    },
    { isolationLevel: "serializable" },
  );
}
