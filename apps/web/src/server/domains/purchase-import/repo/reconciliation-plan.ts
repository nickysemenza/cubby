import { costTypeSchema } from "@cubby/schemas/expense-fields";
import {
  parseEntityId,
  runEntityId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  sourceOrderReconciliationReview,
  type ExtractedPurchaseLine,
  type SourceOrderReconciliationResolution,
} from "@cubby/schemas/purchase-import";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { moneyToMinor } from "@cubby/shared";
import type { z } from "zod";

import {
  expense,
  importSourceOrder,
  importSourceProduct,
  sourceOrderObservation,
} from "~/server/db/schema";
import { financialEvidenceAmountMinor } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { assertClassificationPolicies } from "~/server/domains/spending-category/repo/classification-field-policy";

import { reconciliationFingerprint } from "./reconciliation-observations";
import type {
  ReconciliationFix,
  ReconciliationState,
} from "./reconciliation-state";
import { receiptProductQuantity } from "./writer-plan";

/** Reconciliation state reads Expense cost on the dollar-number wire. */
type DollarExpense = Omit<typeof expense.$inferSelect, "cost"> & {
  cost: number | null;
};

export function foreignProductBinding(
  candidate: ReconciliationFix["proposedExtraction"]["candidate"],
  intent: "financial" | "product_binding",
) {
  return (
    intent === "product_binding" &&
    candidate?.currency != null &&
    /^[A-Z]{3}$/.test(candidate.currency) &&
    candidate.currency !== "USD"
  );
}

/**
 * Attach-only review of the current accepted observation is Product-only: its
 * financial facts were accepted already, and payment evidence may be owned by
 * any member of the canonical family, so it is neither re-compared nor
 * rewritten, and the source claim keeps its latest checksum.
 */
export function reappliesAcceptedObservation(
  state: ReconciliationState,
  resolution: SourceOrderReconciliationResolution,
  intent: "financial" | "product_binding",
) {
  return (
    intent === "product_binding" &&
    (foreignProductBinding(state.observation.extraction.candidate, intent) ||
      (resolution.kind === "attach_only" &&
        (state.association?.acceptedObservationId === state.observation.id ||
          state.currentOriginalReview)))
  );
}

export type ReconciliationPlan = ReturnType<
  typeof planSourceOrderReconciliation
>;

/** Choose the reviewed rows before applying any changes to them. */
export function planSourceOrderReconciliation(
  state: ReconciliationState,
  fix: ReconciliationFix,
  resolution: SourceOrderReconciliationResolution,
  intent: "financial" | "product_binding",
) {
  const candidate = fix.proposedExtraction.candidate!;
  const selected =
    resolution.kind === "replace_lines"
      ? state.expenses.filter((row) =>
          resolution.expenseIds.some((id) => id === row.shortcode),
        )
      : [];
  const productOnly = reappliesAcceptedObservation(state, resolution, intent);
  const syncedPayments = productOnly ? [] : candidate.payments;
  const ownedPayments = productOnly
    ? []
    : state.payments.filter(
        (row) => row.sourceClaimId === state.observation.sourceClaimId,
      );
  const payments = syncedPayments
    .map((payment, evidenceIndex) => {
      const old = ownedPayments.find(
        (row) => row.evidenceIndex === evidenceIndex,
      );
      const values = {
        amountMinor: financialEvidenceAmountMinor(payment.amount),
        chargedAt: payment.chargedAt ? new Date(payment.chargedAt) : null,
        cardLastFour: payment.cardLastFour ?? null,
        tender: payment.tender ?? "unknown",
        description: payment.description ?? null,
      };
      if (!old) return { kind: "insert" as const, evidenceIndex, values };
      return financialEvidenceAmountMinor(old.amount) !== values.amountMinor ||
        old.chargedAt?.toISOString() !== values.chargedAt?.toISOString() ||
        old.cardLastFour !== values.cardLastFour ||
        old.tender !== values.tender
        ? { kind: "update" as const, id: old.id, values }
        : null;
    })
    .filter((payment) => payment !== null);
  return {
    candidate,
    header: {
      purchaseId: state.target.id,
      statedTotal:
        resolution.kind === "replace_lines" &&
        !foreignProductBinding(candidate, intent)
          ? {
              value:
                candidate.printedGrandTotal === null
                  ? null
                  : moneyToMinor(candidate.printedGrandTotal),
            }
          : null,
      orderId: state.target.orderId === null ? candidate.orderId : null,
      imageIds: [
        state.observation.primaryDocumentImageId,
        state.observation.screenshotImageId,
      ].filter((id) => id !== null),
    },
    purchaseId: state.target.id,
    sourceClaimId: state.observation.sourceClaimId,
    refreshClaim:
      !productOnly && state.observation.sourceClaimId === state.family.root.id
        ? { id: state.family.root.id, checksum: fix.source.checksum }
        : null,
    productOnly,
    payments,
    surplusPaymentIds: ownedPayments
      .filter((row) => row.evidenceIndex >= syncedPayments.length)
      .map((row) => row.id),
    resolution,
    foreign: foreignProductBinding(candidate, intent),
    selected,
    lines: resolution.lines.map((binding) => ({
      binding,
      line: candidate.lines[binding.lineIndex]!,
      existing: binding.expenseId
        ? state.expenses.find((row) => row.shortcode === binding.expenseId)!
        : null,
    })),
  };
}

/** Original supported quantity survives USD evidence that omits a count. */
export function originalExpenseQuantity(
  state: ReconciliationState,
  expenseId: string,
) {
  const quantities = new Set(
    state.productBindings.flatMap((binding) => {
      if (binding.expenseId !== expenseId) return [];
      const candidate = state.sourceOrders.find(
        (order) => order.id === binding.sourceOrderId,
      )?.originalOrder?.extraction.candidate;
      const quantity = candidate?.lines[binding.lineIndex]?.quantity;
      return candidate?.currency &&
        candidate.currency !== "USD" &&
        quantity !== undefined
        ? [quantity]
        : [];
    }),
  );
  if (quantities.size > 1)
    throw new Error(
      "Original source quantities disagree; review item correspondence before USD pricing.",
    );
  return quantities.values().next().value ?? null;
}

/** Prepare the Expense write once Product resolution has completed. */
function planReconciledExpense(
  state: ReconciliationState,
  line: ExtractedPurchaseLine,
  existing: DollarExpense | null,
  selected: readonly DollarExpense[],
  productId: ProductId | null,
) {
  const template = existing ?? selected[0];
  const principal = line.lineKind === "principal";
  const fields = {
    purchaseId: state.target.id,
    name: line.title,
    cost: line.amount,
    lineKind: line.lineKind,
    lineBasis: "item_line" as const,
    productId,
    productQuantity: productId
      ? (receiptProductQuantity(productId, line, { reversalKind: null }) ??
        existing?.productQuantity ??
        (existing &&
        state.unpricedForeignExpenses.some((row) => row.id === existing.id)
          ? originalExpenseQuantity(state, existing.id)
          : null))
      : null,
    projectId: principal ? (template?.projectId ?? null) : null,
    spendingCategoryId: principal
      ? (template?.spendingCategoryId ?? null)
      : null,
    trade: tradeSchema.nullable().parse(template?.trade ?? null),
    costType: costTypeSchema.parse(
      line.costType ?? template?.costType ?? "materials",
    ),
    date: template?.date ?? state.target.date,
    notes: template?.notes ?? null,
    future: template?.future ?? false,
    bookingTransactionCode: template?.bookingTransactionCode ?? null,
    url: line.productUrl ?? template?.url ?? null,
    economicRole: "vendor" as const,
  };
  assertClassificationPolicies("expense", fields);
  return { fields, principal };
}

export function planReconciliationOutputFingerprint(
  state: ReconciliationState,
  fix: ReconciliationFix,
) {
  return reconciliationFingerprint({
    observation: state.observation.id,
    reviewedFingerprint: fix.reviewedFingerprint,
  });
}

/** Plan source binding changes after the association and Expense IDs exist. */
export async function planReconciliationBindings(
  state: ReconciliationState,
  plan: ReconciliationPlan,
  firstObservation: typeof sourceOrderObservation.$inferSelect,
  associationId: typeof importSourceOrder.$inferSelect.id,
  lineExpenses: Map<number, typeof expense.$inferSelect.id>,
) {
  const { candidate, resolution, selected } = plan;
  const detached: (typeof importSourceProduct.$inferSelect.id)[] = [];
  const bindings: {
    lineIndex: number;
    productId: ProductId | null;
    expenseId: typeof expense.$inferSelect.id | null;
  }[] = [];
  const preservedOriginalExpenses = new Map<
    number,
    typeof expense.$inferSelect.id
  >();
  if (resolution.kind === "replace_lines") {
    const selectedIds = new Set(selected.map((row) => row.id));
    // A reused Expense may now describe a different item. Check every receipt
    // that referred to it, including sibling sources, before retaining its SKU.
    for (const prior of state.productBindings) {
      if (!prior.expenseId || !selectedIds.has(prior.expenseId)) continue;
      const originalCandidate = state.sourceOrders.find(
        (order) => order.id === prior.sourceOrderId,
      )?.originalOrder?.extraction.candidate;
      const original = originalCandidate?.lines[prior.lineIndex];
      const replacementIndex = [...lineExpenses].find(
        ([, id]) => id === prior.expenseId,
      )?.[0];
      const replacement =
        replacementIndex === undefined
          ? null
          : candidate.lines[replacementIndex];
      const foreignHandover = !!(
        original &&
        replacement &&
        originalCandidate?.currency &&
        originalCandidate.currency !== "USD" &&
        candidate.currency === "USD" &&
        original.title === replacement.title &&
        original.lineKind === replacement.lineKind &&
        (original.quantity === undefined ||
          replacement.quantity === undefined ||
          (original.quantity ?? null) === replacement.quantity)
      );
      // The same source's final upsert must retain this explicitly reviewed
      // acquisition even though its new USD amounts have different fingerprints.
      if (foreignHandover && prior.sourceOrderId === associationId)
        preservedOriginalExpenses.set(prior.lineIndex, prior.expenseId);
      if (
        !original ||
        !replacement ||
        ((await reconciliationFingerprint(original)) !==
          (await reconciliationFingerprint(replacement)) &&
          !foreignHandover)
      )
        detached.push(prior.id);
    }
  }
  const originalLines = firstObservation.extraction.candidate?.lines ?? [];
  const originalKeys = await Promise.all(
    originalLines.map(reconciliationFingerprint),
  );
  const proposedKeys = await Promise.all(
    candidate.lines.map(reconciliationFingerprint),
  );
  const sameRoster =
    (await reconciliationFingerprint(originalKeys)) ===
    (await reconciliationFingerprint(proposedKeys));
  // Only line contents establish correspondence. Header/payment edits cannot
  // discard unchanged receipt identifiers; ambiguous reordered lines stay unknown.
  for (const [lineIndex, originalKey] of originalKeys.entries()) {
    const matches = proposedKeys.flatMap((key, index) =>
      key === originalKey ? [index] : [],
    );
    const proposedIndex = sameRoster
      ? lineIndex
      : matches.length === 1 &&
          originalKeys.filter((key) => key === originalKey).length === 1
        ? matches[0]
        : undefined;
    const expenseId =
      preservedOriginalExpenses.get(lineIndex) ??
      (proposedIndex === undefined
        ? null
        : (lineExpenses.get(proposedIndex) ?? null));
    const binding = firstObservation.productBindings.find(
      (row) => row.lineIndex === lineIndex,
    );
    bindings.push({
      lineIndex,
      productId: binding?.productId
        ? parseEntityId("product", binding.productId)
        : null,
      expenseId,
    });
  }
  return { detached, bindings };
}

function partyIdForShortcode(
  state: Pick<ReconciliationState, "parties">,
  shortcode: string,
) {
  const party = state.parties.find((row) => row.shortcode === shortcode);
  if (!party) throw new Error("A reviewed attribution party is not live.");
  return party.id;
}

/** Prepare one Expense after Product resolution has produced its ID. */
export function planReconciliationLine(
  state: ReconciliationState,
  plan: ReconciliationPlan,
  entry: ReconciliationPlan["lines"][number],
  productId: ProductId | null,
  reused: ReadonlySet<typeof expense.$inferSelect.id>,
  current: z.infer<typeof sourceOrderReconciliationReview>,
) {
  const { binding, line, existing } = entry;
  const finding = line.lineKind === "principal" && productId === null;
  if (plan.resolution.kind === "attach_only")
    return {
      kind: "attach" as const,
      entry,
      productId,
      finding,
      fields:
        existing &&
        ((!existing.productId && productId) || existing.purchaseId === null)
          ? {
              purchaseId: state.target.id,
              productId,
              productQuantity:
                existing.productQuantity ??
                receiptProductQuantity(productId, line, { reversalKind: null }),
            }
          : null,
    };
  const { fields } = planReconciledExpense(
    state,
    line,
    existing,
    plan.selected,
    productId,
  );
  const allocations = current.attributions
    .filter((allocation) => allocation.lineIndex === binding.lineIndex)
    .map((allocation) => ({
      role: allocation.role,
      ledgerPartyId: allocation.partyId
        ? partyIdForShortcode(state, allocation.partyId)
        : null,
      weight: allocation.weight,
    }));
  return {
    kind: "replace" as const,
    entry,
    productId,
    finding,
    fields,
    allocations,
    reuse: !!existing && !reused.has(existing.id),
  };
}

export function planReconciliationRemovals(
  plan: ReconciliationPlan,
  reused: ReadonlySet<typeof expense.$inferSelect.id>,
) {
  return plan.selected
    .filter((row) => !reused.has(row.id))
    .map((row) => row.id);
}

/** Prepare the audit and downstream work after the accepted observation exists. */
export function planReconciliationFinal(
  state: ReconciliationState,
  current: z.infer<typeof sourceOrderReconciliationReview>,
  plan: ReconciliationPlan,
  acceptedObservation: typeof sourceOrderObservation.$inferSelect,
  fix: ReconciliationFix,
  ownerId: ReconciliationState["family"]["root"]["ledgerPartyId"],
) {
  return {
    shipment: plan.productOnly
      ? null
      : {
          source: fix.source,
          runId: state.observation.runId
            ? runEntityId.parse(state.observation.runId)
            : null,
          ledgerPartyId: ownerId,
          purchaseId: state.target.id,
          shipments: plan.candidate.shipments ?? [],
        },
    audit: {
      entityKind: "purchase" as const,
      entityId: state.target.id,
      action: "update" as const,
      changes: {
        acceptedObservationId: {
          from: state.association?.acceptedObservationId ?? null,
          to: acceptedObservation.id,
        },
        spend: { from: current.spend.before, to: current.spend.after },
      },
    },
    bookingCodes:
      plan.resolution.kind === "replace_lines" && !plan.foreign
        ? [
            ...new Set(
              plan.selected.flatMap((row) =>
                row.bookingTransactionCode ? [row.bookingTransactionCode] : [],
              ),
            ),
          ]
        : [],
  };
}

/** Prepare inputs to the shared observation transaction stage. */
export function planReconciliationObservation(
  state: ReconciliationState,
  fix: ReconciliationFix,
  bindings: { lineIndex: number; productId: ProductId | null }[],
) {
  return {
    identity: {
      sourceClaimId: state.observation.sourceClaimId,
      orderKey: fix.orderKey,
      purchaseId: state.target.id,
    },
    input: {
      runId: state.observation.runId,
      vendorId: state.target.vendorId,
      source: fix.source,
      extraction: fix.proposedExtraction,
      primaryDocumentImageId: state.observation.primaryDocumentImageId,
      screenshotImageId: state.observation.screenshotImageId,
    },
    bindings,
  };
}
