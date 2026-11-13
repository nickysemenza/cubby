import { cents } from "@cubby/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import {
  expense,
  ledgerParty,
  sourceOrderObservation,
} from "~/server/db/schema";
import { unpricedForeignExpenseSql } from "~/server/domains/purchase-import/repo/writer-policy";
import { createAppError } from "~/server/errors/app-error";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";

import { reviewResolution } from "./reconciliation";
import {
  reconciliationFingerprint,
  sourceObservationIdentitySql,
} from "./reconciliation-observations";
import {
  loadSourceReconciliationState,
  sourceReconciliationStateFingerprint,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";

/** Revalidate the reviewed state while the caller's locks are held. */
export async function loadReviewedReconciliation(
  tx: DrizzleTransaction,
  fix: ReconciliationFix,
  ownerId: typeof ledgerParty.$inferSelect.id,
  intent: "financial" | "product_binding",
) {
  if (!fix.review)
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Review the source-order reconciliation before applying it.",
    );
  const state = await loadSourceReconciliationState(tx, fix, ownerId);
  if (
    (await sourceReconciliationStateFingerprint(
      state,
      fix,
      fix.review.resolution,
    )) !== fix.reviewedFingerprint
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Reconciliation state changed after review; prepare it again.",
    );
  const current = await reviewResolution(
    tx,
    state,
    fix,
    fix.review.resolution,
    intent,
  );
  if (
    (await reconciliationFingerprint(current)) !==
    (await reconciliationFingerprint(fix.review))
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Reconciliation state changed after review; prepare it again.",
    );
  return { state, current };
}

/** Validate the ledger after the expense stage has written it. */
export async function loadReconciliationExpenseValidation(
  tx: DrizzleTransaction,
  purchaseId: ReconciliationState["target"]["id"],
  expectedAfter: number | null,
) {
  await validateProductPolicy(tx, { purchaseId });
  const [sum] = await tx
    .select({
      amount: sql<number>`(sum(${expense.cost}) / 100.0)::double precision`,
      unknown: sql<number>`count(*) FILTER (WHERE ${expense.cost} IS NULL AND NOT ${unpricedForeignExpenseSql({ id: outer(expense.id), purchaseId: outer(expense.purchaseId), lineKind: outer(expense.lineKind), cost: outer(expense.cost) })})::int`,
    })
    .from(expense)
    .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)));
  if (
    expectedAfter !== null &&
    (sum?.unknown || cents(sum?.amount ?? 0) !== cents(expectedAfter))
  )
    throw new Error(
      "Reconciliation did not conserve the reviewed Expense total.",
    );
}

/** Read the first source observation after the preceding writes. */
export async function loadFirstReconciliationObservation(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  fix: ReconciliationFix,
) {
  if (!state.observation.sourceClaimId)
    throw new Error("Retained association has no source claim");
  const [firstObservation] = await tx
    .select()
    .from(sourceOrderObservation)
    .where(
      and(
        eq(
          sourceOrderObservation.sourceClaimId,
          state.observation.sourceClaimId,
        ),
        eq(sourceOrderObservation.orderKey, fix.orderKey),
        sourceObservationIdentitySql(
          "purchase",
          sourceOrderObservation.purchaseId,
          sql`${state.target.id}`,
        ),
      ),
    )
    .orderBy(
      asc(sourceOrderObservation.createdAt),
      asc(sourceOrderObservation.id),
    )
    .limit(1);
  if (!firstObservation)
    throw new Error("Reconciliation observation provenance is missing.");
  return firstObservation;
}
