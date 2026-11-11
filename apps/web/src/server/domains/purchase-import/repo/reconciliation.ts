import type { ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  prepareSourceOrderReconciliationInput,
  prepareSourceOrderReconciliationOut,
  proposedImportFix,
  sourceOrderReconciliationReview,
  storedImportFix,
  type PrepareSourceOrderReconciliationInput,
  type PrepareSourceOrderReconciliationOut,
  type SourceOrderReconciliationResolution,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { expense, ledgerParty, purchase, runFinding } from "~/server/db/schema";
import { validateExpenseInheritance } from "~/server/domains/expense/repo/expense-inheritance";
import { refreshAutomaticBookingFingerprint } from "~/server/domains/financial-transaction/repo/financial-convergence";
import {
  loadExpenseAllocations,
  type ExpenseAllocationRow,
} from "~/server/domains/household-contribution/repo/allocation";
import {
  matchCompletePaymentSet,
  sourceFinancialFacts,
} from "~/server/domains/purchase-import/repo/writer-policy";
import {
  publishRunFinding,
  runFindingColumns,
  runFindingStatus,
  updateRunFinding,
} from "~/server/domains/run/repo/run-finding";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { cascadeRemoval } from "~/server/generic/removal/repo/core";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { redistributeReplacementAttributions } from "./aggregate-replacement";
import { prepareAcceptedSourceOrderReconciliation } from "./reconciliation-accepted";
import {
  newReconciliationExpenseContext,
  applyReconciliationLine,
  applyReconciliationRemovals,
  applyReconciliationAssociation,
  applyReconciliationHeader,
  applyReconciliationSource,
} from "./reconciliation-apply";
import {
  loadReviewedReconciliation,
  loadReconciliationExpenseValidation,
  loadFirstReconciliationObservation,
} from "./reconciliation-load";
import { reviewPreparedNewProducts } from "./reconciliation-new-product";
import { recordSourceOrderObservation } from "./reconciliation-observations";
import {
  foreignProductBinding,
  planSourceOrderReconciliation,
  planReconciliationOutputFingerprint,
  planReconciliationBindings,
  planReconciliationLine,
  planReconciliationRemovals,
  planReconciliationFinal,
  planReconciliationObservation,
  originalExpenseQuantity,
  reappliesAcceptedObservation,
} from "./reconciliation-plan";
import { resolveReconciliationProduct } from "./reconciliation-product";
import {
  loadSourceReconciliationState,
  lockFindingSettlement,
  sourceReconciliationStateFingerprint,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";
import { recordImportedShipmentEvidence } from "./shipment-intake";

function partyCentTargets(
  rows: readonly Pick<
    ExpenseAllocationRow,
    "role" | "ledgerPartyId" | "allocationKey" | "cents"
  >[],
) {
  const targets = new Map<
    string,
    Pick<
      ExpenseAllocationRow,
      "role" | "ledgerPartyId" | "allocationKey" | "cents"
    >
  >();
  for (const row of rows) {
    const key = `${row.role}:${row.allocationKey}`;
    targets.set(key, {
      ...row,
      cents: row.cents + (targets.get(key)?.cents ?? 0n),
    });
  }
  return [...targets.values()];
}

// The review policy keeps money, settlement and Product admission gates together.
// eslint-disable-next-line complexity
export async function reviewResolution(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  fix: ReconciliationFix,
  resolution: SourceOrderReconciliationResolution,
  intent: "financial" | "product_binding" = "financial",
) {
  resolution = await reviewPreparedNewProducts(tx, state, resolution);
  const candidate = fix.proposedExtraction.candidate;
  if (!candidate) throw new Error("Reconciliation needs a readable candidate.");
  const foreign = foreignProductBinding(candidate, intent);
  if (foreign && resolution.kind !== "attach_only")
    throw new Error(
      "Foreign Product review only attaches existing unpriced item Expenses; monetary replacement requires USD evidence.",
    );
  if (
    foreign &&
    (candidate.sourceEvent === "refunded" ||
      candidate.sourceEvent === "cancelled" ||
      candidate.lines.some(
        (line) =>
          line.lineKind === "principal" &&
          line.amount !== null &&
          line.amount < 0,
      ))
  )
    throw new Error(
      "Foreign refunds and cancellations require reviewed accounting reconciliation.",
    );
  if (candidate.currency !== "USD" && !foreign)
    throw new Error(
      "Monetary source reconciliation requires explicit USD currency.",
    );
  if (
    candidate.orderId !== null &&
    state.target.orderId !== null &&
    candidate.orderId !== state.target.orderId
  )
    throw new Error(
      "The proposed order identity differs from the accepted Purchase.",
    );
  const candidateOrderId = candidate.orderId;
  if (candidateOrderId !== null && state.target.orderId === null) {
    const owner = await tx.query.purchase.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(
              eq(purchase.vendorId, state.target.vendorId),
              eq(purchase.orderId, candidateOrderId),
              notDeleted(purchase),
            ),
          ),
      },
    });
    if (owner && owner.id !== state.target.id)
      throw new Error(
        "Another Purchase already owns this vendor order. Review the two Purchases before adopting the order identity.",
      );
  }
  const oldPayments = state.payments.filter(
    (row) => row.sourceClaimId === state.observation.sourceClaimId,
  );
  const paymentFacts = (payments: typeof candidate.payments) =>
    sourceFinancialFacts({ ...candidate, payments }).payments;
  const paymentsChanged =
    !reappliesAcceptedObservation(state, resolution, intent) &&
    JSON.stringify(
      paymentFacts(
        oldPayments.map((row) => ({
          amount: row.amount,
          chargedAt: row.chargedAt?.toISOString(),
          cardLastFour: row.cardLastFour ?? undefined,
        })),
      ),
    ) !== JSON.stringify(paymentFacts(candidate.payments));
  if (paymentsChanged && state.allocations.length) {
    const proposed = candidate.payments.map((row) => cents(row.amount)).sort();
    const allocated = state.allocations.map((row) => cents(row.amount)).sort();
    if (JSON.stringify(proposed) !== JSON.stringify(allocated))
      throw new Error(
        "Proposed payments disagree with existing statement allocations; explicitly resolve allocations before preparing this correction.",
      );
    const matched = matchCompletePaymentSet(
      candidate.payments,
      state.transactions.map((transaction) => {
        const account = state.financialAccounts.find(
          (row) => row.id === transaction.accountId,
        );
        const date = transaction.transactionDate ?? transaction.postedDate;
        return {
          id: transaction.id,
          amount: state.allocations.find(
            (row) => row.transactionId === transaction.id,
          )!.amount,
          occurredAt: new Date(`${date}T12:00:00Z`),
          cardLastFours: cardLastFoursOn(account?.cardNumbers ?? [], date),
          storedValue: account?.identity.kind === "stored_value",
        };
      }),
    );
    if (!matched || matched.length !== state.allocations.length)
      throw new Error(
        "Proposed payment dates or card numbers disagree with existing statement allocations; resolve allocations explicitly.",
      );
  }
  const bindings = resolution.lines;
  if (
    resolution.kind === "attach_only" &&
    new Set(bindings.map((row) => row.expenseId)).size !== bindings.length
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_INVALID",
      "Attach-only bindings require a distinct Expense for each proposed line.",
    );
  if (
    bindings.length !== candidate.lines.length ||
    new Set(bindings.map((row) => row.lineIndex)).size !== bindings.length ||
    bindings.some((row) => !candidate.lines[row.lineIndex])
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_INVALID",
      "Review exactly one binding for each proposed order line.",
    );
  for (const binding of bindings) {
    const line = candidate.lines[binding.lineIndex]!;
    const selected = binding.expenseId
      ? state.expenses.find((row) => row.shortcode === binding.expenseId)
      : null;
    if (binding.expenseId && !selected)
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_STALE",
        "A reviewed Expense no longer belongs to this Purchase.",
      );
    if (
      binding.productId &&
      (!state.products.some(
        (row) => row.shortcode === binding.productId && !row.deletedAt,
      ) ||
        line.lineKind !== "principal")
    )
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Review a live Product for a principal line.",
      );
    if (
      resolution.kind === "attach_only" &&
      (!selected ||
        (foreign
          ? selected.lineBasis !== "item_line"
          : line.amount === null
            ? selected.cost !== null || selected.lineBasis !== "item_line"
            : selected.cost === null ||
              cents(selected.cost) !== cents(line.amount)) ||
        selected.lineKind !== line.lineKind ||
        (selected.productQuantity !== null &&
          binding.productId !== null &&
          line.quantity !== undefined &&
          selected.productQuantity !== line.quantity) ||
        (selected.productId &&
          state.products.find((row) => row.id === selected.productId)
            ?.shortcode !== binding.productId))
    )
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Attach-only evidence must preserve each reviewed ledger amount, line kind and Product.",
      );
  }
  const unpricedIds = new Set(
    state.unpricedForeignExpenses.map((row) => row.id),
  );
  const beforeCents = state.expenses.every(
    (row) =>
      row.cost !== null ||
      (unpricedIds.has(row.id) &&
        state.expenses.some(
          (item) => item.lineBasis === "allocation" && item.cost !== null,
        )),
  )
    ? state.expenses.reduce((sum, row) => sum + cents(row.cost ?? 0), 0)
    : null;
  let afterCents = beforeCents;
  let attributions: Awaited<
    ReturnType<typeof redistributeReplacementAttributions>
  > = [];
  const originalAllocations = await loadExpenseAllocations(tx, {
    expenseIds: state.expenses.map((row) => row.id),
    includeFuture: true,
  });
  if (resolution.kind === "replace_lines") {
    if (
      candidate.printedGrandTotal === null ||
      candidate.orderedAt === null ||
      fix.proposedExtraction.status !== "ready"
    )
      throw new Error(
        "Expense corrections require reviewed complete USD order facts.",
      );
    // A ready extraction prices every line (importExtractionOutcome).
    const pricedCents = (row: (typeof candidate.lines)[number]) => {
      if (row.amount === null)
        throw new Error("Expense corrections require every line's price.");
      return cents(row.amount);
    };
    if (
      candidate.lines.reduce((sum, row) => sum + pricedCents(row), 0) !==
      cents(candidate.printedGrandTotal)
    )
      throw new Error(
        "Proposed order lines do not conserve the printed total.",
      );
    const selectedIds = new Set<string>(resolution.expenseIds);
    const selected = state.expenses.filter((row) =>
      selectedIds.has(row.shortcode),
    );
    if (
      selected.length !== selectedIds.size ||
      selectedIds.size !== resolution.expenseIds.length ||
      selected.some(
        (row) =>
          row.economicRole !== "vendor" ||
          (row.cost === null && !unpricedIds.has(row.id)),
      )
    )
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Review live vendor Expenses with known costs for replacement.",
      );
    if (
      !foreign &&
      unpricedIds.size &&
      (selected.some((row) => unpricedIds.has(row.id)) ||
        candidate.lines.some(
          (line) =>
            line.lineKind === "principal" &&
            line.amount !== null &&
            line.amount >= 0,
        ))
    ) {
      if (
        state.expenses.some(
          (row) =>
            (unpricedIds.has(row.id) || row.lineBasis === "allocation") &&
            !selectedIds.has(row.shortcode),
        )
      )
        throw createAppError(
          "PURCHASE_IMPORT_REVIEW_INVALID",
          "Review the foreign item roster and its USD aggregate together before pricing items.",
        );
      if (
        bindings.some(
          (binding) =>
            candidate.lines[binding.lineIndex]?.lineKind === "principal" &&
            !selected.some(
              (row) =>
                row.shortcode === binding.expenseId && unpricedIds.has(row.id),
            ),
        )
      )
        throw createAppError(
          "PURCHASE_IMPORT_REVIEW_INVALID",
          "USD itemization must reuse the original principal acquisitions.",
        );
      for (const row of selected.filter((item) => unpricedIds.has(item.id))) {
        const binding = bindings.find(
          (item) => item.expenseId === row.shortcode,
        );
        const line = binding && candidate.lines[binding.lineIndex];
        const quantity =
          row.productQuantity ?? originalExpenseQuantity(state, row.id);
        if (
          !line ||
          line.title !== row.name ||
          line.lineKind !== row.lineKind ||
          (line.quantity !== undefined &&
            quantity !== null &&
            line.quantity !== quantity)
        )
          throw createAppError(
            "PURCHASE_IMPORT_REVIEW_INVALID",
            "USD pricing must preserve each source item's identity and supported quantity.",
          );
      }
    }
    // USD pricing must reuse each original acquisition, never split or silently remove it.
    if (
      !foreign &&
      selected.some((row) => unpricedIds.has(row.id)) &&
      selected
        .filter((row) => unpricedIds.has(row.id))
        .some(
          (row) =>
            bindings.filter((binding) => binding.expenseId === row.shortcode)
              .length !== 1,
        )
    )
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Reuse each unpriced foreign item exactly once when replacing its USD aggregate.",
      );
    if (
      bindings.some((row) => row.expenseId && !selectedIds.has(row.expenseId))
    )
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Each reused Expense must be in the reviewed replacement roster.",
      );
    if (selected.length && bindings.some((row) => row.expenseId === null))
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Choose the original Expense context for each replacement line, including a split line.",
      );
    const selectedInternal = new Set(selected.map((row) => row.id));
    if (
      state.ledgerClaims.some(
        (claim) => claim.expenseId && selectedInternal.has(claim.expenseId),
      )
    )
      throw new Error(
        "Source-claimed Expenses need their existing explicit correction workflow.",
      );
    const selectedTotal = selected.reduce(
      (sum, row) => sum + cents(row.cost ?? 0),
      0,
    );
    const proposedTotal = candidate.lines.reduce(
      (sum, row) => sum + pricedCents(row),
      0,
    );
    if (selectedTotal !== proposedTotal && !resolution.attributionTargets)
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_INVALID",
        "Changed total requires explicit reviewed beneficiary and funder cent targets.",
      );
    if (resolution.attributionTargets) {
      const keys = resolution.attributionTargets.map(
        (row) => `${row.role}:${row.partyId ?? "~unattributed"}`,
      );
      if (new Set(keys).size !== keys.length)
        throw createAppError(
          "PURCHASE_IMPORT_REVIEW_INVALID",
          "Attribution cent targets must be unique per party and role.",
        );
      for (const role of ["beneficiary", "funder"] as const)
        if (
          resolution.attributionTargets
            .filter((row) => row.role === role)
            .reduce((sum, row) => sum + cents(row.amount), 0) !== proposedTotal
        )
          throw createAppError(
            "PURCHASE_IMPORT_REVIEW_INVALID",
            "Reviewed attribution cent targets must conserve the proposed total for both roles.",
          );
      const targets = [];
      for (const target of resolution.attributionTargets) {
        const id = target.partyId
          ? await resolveOrThrow(tx, "ledgerParty", target.partyId)
          : null;
        targets.push({
          role: target.role,
          ledgerPartyId: id,
          allocationKey: target.partyId ?? "~unattributed",
          cents: BigInt(cents(target.amount)),
        });
      }
      if (selectedTotal === proposedTotal) {
        const original = partyCentTargets(
          originalAllocations.filter((row) =>
            selectedInternal.has(row.expenseId),
          ),
        );
        const key = (
          row: Pick<ExpenseAllocationRow, "role" | "ledgerPartyId">,
        ) => `${row.role}:${row.ledgerPartyId ?? "~unattributed"}`;
        const originalCents = new Map(
          original.map((row) => [key(row), row.cents]),
        );
        const targetCents = new Map(
          targets.map((row) => [key(row), row.cents]),
        );
        if (
          [...new Set([...originalCents.keys(), ...targetCents.keys()])].some(
            (party) =>
              (originalCents.get(party) ?? 0n) !==
              (targetCents.get(party) ?? 0n),
          )
        )
          throw createAppError(
            "PURCHASE_IMPORT_REVIEW_INVALID",
            "Same-total replacements must preserve each party's beneficiary and funder cents.",
          );
      }
      attributions = await redistributeReplacementAttributions(
        tx,
        targets,
        candidate.lines,
      );
    } else
      attributions = await redistributeReplacementAttributions(
        tx,
        partyCentTargets(
          originalAllocations.filter((row) =>
            selectedInternal.has(row.expenseId),
          ),
        ),
        candidate.lines,
      );
    afterCents =
      beforeCents === null ? null : beforeCents - selectedTotal + proposedTotal;
  }
  return sourceOrderReconciliationReview.parse({
    reviewedFingerprint: await sourceReconciliationStateFingerprint(
      state,
      fix,
      resolution,
    ),
    resolution,
    source: fix.source,
    orderKey: fix.orderKey,
    accepted: state.accepted,
    proposed: {
      checksum: fix.source.checksum,
      extraction: fix.proposedExtraction,
    },
    spend: {
      before: beforeCents === null ? null : beforeCents / 100,
      after: afterCents === null ? null : afterCents / 100,
      delta: foreign
        ? 0
        : beforeCents === null || afterCents === null
          ? null
          : (afterCents - beforeCents) / 100,
    },
    expenses: state.expenses.map((row) => ({
      id: row.shortcode,
      title: row.name,
      amount: row.cost,
      productId:
        state.products.find((p) => p.id === row.productId)?.shortcode ?? null,
    })),
    payments: state.payments.map((row) => ({
      amount: row.amount,
      chargedAt: row.chargedAt?.toISOString(),
      cardLastFour: row.cardLastFour ?? undefined,
      tender: row.tender,
      description: row.description ?? undefined,
    })),
    proposedPayments: foreign ? [] : candidate.payments,
    allocationTotal:
      state.allocations.reduce((sum, row) => sum + cents(row.amount), 0) / 100,
    allocations: state.allocations.map((row) => ({
      transactionId: state.transactions.find((t) => t.id === row.transactionId)!
        .shortcode,
      amount: row.amount,
      postedDate: state.transactions.find((t) => t.id === row.transactionId)!
        .postedDate,
    })),
    originalAttributions: originalAllocations.map((row) => ({
      expenseId: row.expenseShortcode,
      role: row.role,
      partyId:
        state.parties.find((p) => p.id === row.ledgerPartyId)?.shortcode ??
        null,
      amount: Number(row.cents) / 100,
    })),
    attributions: attributions.map((row) => ({
      lineIndex: row.lineIndex,
      role: row.role,
      partyId: row.partyId ? partyShortcode(state, row.partyId) : null,
      amount: row.amount,
      weight: row.weight,
    })),
  });
}

// A reviewed money split must name the exact party; never fall back to
// unattributed when a party is missing from the locked state.
function partyShortcode(
  state: Pick<ReconciliationState, "parties">,
  id: string,
) {
  const party = state.parties.find((row) => row.id === id);
  if (!party) throw new Error("A reviewed attribution party is not live.");
  return party.shortcode;
}

export function prepareSourceOrderReconciliation(
  db: Database,
  input: Extract<PrepareSourceOrderReconciliationInput, { id: string }>,
  actor: ActorContext,
): Promise<Extract<PrepareSourceOrderReconciliationOut, { id: string }>>;
export function prepareSourceOrderReconciliation(
  db: Database,
  input: Extract<
    PrepareSourceOrderReconciliationInput,
    { sourceOrderId: string }
  >,
  actor: ActorContext,
): Promise<
  Extract<PrepareSourceOrderReconciliationOut, { sourceOrderId: string }>
>;
export function prepareSourceOrderReconciliation(
  db: Database,
  input: PrepareSourceOrderReconciliationInput,
  actor: ActorContext,
): Promise<PrepareSourceOrderReconciliationOut>;
export async function prepareSourceOrderReconciliation(
  db: Database,
  rawInput: PrepareSourceOrderReconciliationInput,
  actor: ActorContext,
) {
  const input = prepareSourceOrderReconciliationInput.parse(rawInput);
  if ("sourceOrderId" in input)
    return prepareAcceptedSourceOrderReconciliation(db, input, actor);
  return withTransaction(db, async (tx) => {
    await lockFindingSettlement(tx, input.id, actor);
    const [finding] = await tx
      .select(runFindingColumns)
      .from(runFinding)
      .where(eq(runFinding.id, input.id))
      .for("update");
    if (!finding || finding.status !== runFindingStatus.enum.open)
      throw createAppError(
        "PURCHASE_IMPORT_REVIEW_STALE",
        "This source finding has already been resolved.",
      );
    const fix = storedImportFix.parse(finding.proposedFix);
    if (
      !fix ||
      fix.kind !== "reconcile_source_order" ||
      finding.entityKind !== "purchase" ||
      finding.entityId !== fix.purchaseId
    )
      throw new Error(
        "This finding has no source-order reconciliation proposal.",
      );
    const [owner] = await tx
      .select()
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.id, finding.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .for("share");
    if (!owner)
      throw new Error("Import finding owner changed for this member.");
    const state = await loadSourceReconciliationState(
      tx,
      fix,
      finding.ledgerPartyId,
      input.resolution,
    );
    const review = await reviewResolution(tx, state, fix, input.resolution);
    // The reviewed preview belongs to the current finding; `judgment` keeps
    // the original proposal.
    await updateRunFinding(tx, finding.id, {
      proposedFix: proposedImportFix.parse({
        ...fix,
        reviewedFingerprint: review.reviewedFingerprint,
        review,
      }),
    });
    return prepareSourceOrderReconciliationOut.parse({
      id: finding.id,
      ...review,
    });
  });
}

async function retainUnresolvedProductFinding(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  ownerId: typeof ledgerParty.$inferSelect.id,
  expenseId: typeof expense.$inferSelect.id,
  title: string,
) {
  await publishRunFinding(tx, {
    runId: state.observation.runId,
    ledgerPartyId: ownerId,
    entityKind: "purchase",
    entityId: state.target.id,
    kind: "product_unresolved",
    summary: `Product resolution is required for “${title}”: The reviewed order line has no matched Product.`,
    proposedFix: null,
    evidenceFingerprint: `replacement:${expenseId}`,
  });
}

// Every reviewed effect and conservation assertion shares this transaction.
export async function commitSourceOrderReconciliation(
  tx: DrizzleTransaction,
  fix: ReconciliationFix,
  actor: ActorContext,
  ownerId: typeof ledgerParty.$inferSelect.id,
  intent: "financial" | "product_binding" = "financial",
) {
  const { state, current } = await loadReviewedReconciliation(
    tx,
    fix,
    ownerId,
    intent,
  );
  const plan = planSourceOrderReconciliation(
    state,
    fix,
    current.resolution,
    intent,
  );
  const applied = newReconciliationExpenseContext();
  for (const entry of plan.lines) {
    const productId = await resolveReconciliationProduct(
      tx,
      state,
      entry,
      applied,
    );
    const linePlan = planReconciliationLine(
      state,
      plan,
      entry,
      productId,
      applied.reused,
      current,
    );
    const result = await applyReconciliationLine(tx, linePlan, applied);
    if (result.row) await validateExpenseInheritance(tx, result.row);
    if (result.findingId)
      await retainUnresolvedProductFinding(
        tx,
        state,
        ownerId,
        result.findingId,
        entry.line.title,
      );
  }
  const removed = planReconciliationRemovals(plan, applied.reused);
  await applyReconciliationRemovals(tx, removed);
  if (removed.length)
    await cascadeRemoval(tx, {
      entity: "expense",
      ids: removed,
      audit: { into: applied.audit },
    });
  await loadReconciliationExpenseValidation(
    tx,
    state.target.id,
    current.spend.after,
  );
  await applyReconciliationHeader(tx, plan, applied);
  const outputFingerprint = await planReconciliationOutputFingerprint(
    state,
    fix,
  );
  const firstObservation = await loadFirstReconciliationObservation(
    tx,
    state,
    fix,
  );
  const observationPlan = planReconciliationObservation(
    state,
    fix,
    applied.resolvedBindings,
  );
  const acceptedObservation = await recordSourceOrderObservation(
    tx,
    observationPlan.identity,
    observationPlan.input,
    observationPlan.bindings,
  );
  const association = await applyReconciliationAssociation(
    tx,
    state,
    fix,
    firstObservation,
    acceptedObservation,
    outputFingerprint,
  );
  const bindingPlan = await planReconciliationBindings(
    state,
    plan,
    firstObservation,
    association.id,
    applied.lineExpenses,
  );
  const finalPlan = planReconciliationFinal(
    state,
    current,
    plan,
    acceptedObservation,
    fix,
    ownerId,
  );
  await applyReconciliationSource(tx, plan, association, bindingPlan);
  if (finalPlan.shipment)
    await recordImportedShipmentEvidence(
      databaseForTransaction(tx),
      finalPlan.shipment,
      actor,
    );
  applied.audit.push(finalPlan.audit);
  await logAuditEntries(tx, actor, applied.audit);
  for (const code of finalPlan.bookingCodes)
    await refreshAutomaticBookingFingerprint(
      databaseForTransaction(tx),
      parseShortcodeFor("financialTransaction", code),
    );
}
