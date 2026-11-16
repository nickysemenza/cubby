import type { ActorContext } from "@cubby/schemas/context";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
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

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, withTransaction } from "~/server/db/helpers";
import { ledgerParty, runFinding } from "~/server/db/schema";
import {
  loadExpenseAllocations,
  type ExpenseAllocationRow,
} from "~/server/domains/household-contribution/repo/allocation";
import {
  matchCompletePaymentSet,
  sourceFinancialFacts,
} from "~/server/domains/purchase-import/policy/import-lines";
import {
  runFindingColumns,
  runFindingStatus,
  updateRunFinding,
} from "~/server/domains/run/repo/run-finding";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { enterWriteTransaction } from "~/server/kernel/gate";

import { redistributeReplacementAttributions } from "./aggregate-replacement";
import { findVendorOrderOwner, vendorOrderOwners } from "./order-identity";
import { prepareAcceptedSourceOrderReconciliation } from "./reconciliation-accepted";
import { reviewPreparedNewProducts } from "./reconciliation-new-product";
import { reconciliationFingerprint } from "./reconciliation-observations";
import {
  foreignProductBinding,
  originalExpenseQuantity,
  reappliesAcceptedObservation,
} from "./reconciliation-plan";
import {
  loadSourceReconciliationState,
  lockFindingSettlement,
  sourceReconciliationStateFingerprint,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";

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
async function reviewResolution(
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
  if (
    candidateOrderId !== null &&
    state.target.orderId === null &&
    vendorOrderOwners(
      await findVendorOrderOwner(tx, {
        vendorId: state.target.vendorId,
        orderId: candidateOrderId,
      }),
    ).some((row) => row.id !== state.target.id)
  )
    throw new Error(
      "Another Purchase already owns this vendor order. Review the two Purchases before adopting the order identity.",
    );
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
          tender: row.tender,
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
        targets,
        candidate.lines,
      );
    } else
      attributions = await redistributeReplacementAttributions(
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
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
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

/** Approving a source repair accepts a new immutable extraction, then dirties its existing event. */
// oxlint-disable-next-line complexity -- review fences, exact Decisions and money read-back share one atomic approval.
export async function commitSourceOrderReconciliation(
  tx: import("~/server/db").DrizzleTransaction,
  fix: Extract<
    import("@cubby/schemas/purchase-import").ProposedImportFix,
    { kind: "reconcile_source_order" }
  >,
  actor: ActorContext,
  ownerId: import("@cubby/schemas/identifiers").LedgerPartyId,
  intent: "financial" | "product_binding" = "financial",
) {
  const { databaseForTransaction } = await import("~/server/db/helpers");
  const { appendOrderPayments, orderEventKey } =
    await import("~/server/domains/purchase-import/repo/order-evidence");
  const { settleOrderEvidence } =
    await import("~/server/domains/purchase-import/repo/settle-order-evidence");
  const { decide } = await import("~/server/kernel/api");
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
  const {
    planSourceOrderReconciliation,
    planReconciliationLine,
    planReconciliationRemovals,
  } = await import("~/server/domains/purchase-import/repo/reconciliation-plan");
  const { lineProductResolver } =
    await import("~/server/domains/purchase-import/repo/writer");
  const { nullableWholeCentToMinor, moneyToMinor } =
    await import("@cubby/shared");
  const { recordKey, decision } = await import("~/server/db/kernel-schema");
  const { expense } = await import("~/server/db/schema");
  const { isNull, inArray, desc } = await import("drizzle-orm");
  const { recordIdentity, recordSubject } = await import("~/server/kernel/api");
  const { jsonSnapshot } = await import("~/server/lib/canonical-json");
  const prior = state.observation;
  const target = state.target;
  const database = databaseForTransaction(tx);
  const [owner] = await tx
    .select()
    .from(recordKey)
    .where(
      and(
        eq(recordKey.entity, "purchase"),
        eq(recordKey.entityId, target.id),
        eq(recordKey.scopeKind, "purchaseEvent"),
        isNull(recordKey.mergedAt),
        isNull(recordKey.rejectedAt),
      ),
    )
    .for("update");
  if (!owner)
    throw new Error("The accepted Purchase has no live reconciliation owner");
  const scope = { kind: "purchaseEvent", key: owner.scopeKey };
  const plan = planSourceOrderReconciliation(
    state,
    fix,
    current.resolution,
    intent,
  );
  const newIdentity = (
    distinctFrom: import("./writer-decisions").LineIdentityDecision["distinctFrom"],
  ): import("./writer-decisions").LineIdentityDecision => ({
    productId: null,
    promote: true,
    variantDoubt: false,
    unresolvedReason: null,
    probability: 1,
    lineKind: "principal",
    kitKind: "single",
    reversalKind: null,
    distinctFrom,
  });
  const products = lineProductResolver(
    tx,
    target.vendorId,
    plan.lines.flatMap(({ binding, line }) =>
      binding.newProduct ? [{ line, decision: newIdentity([]) }] : [],
    ),
    { actor },
  );
  const resolvedProducts = new Map<
    number,
    import("@cubby/schemas/identifiers").ProductId | null
  >();
  for (const { binding, line } of plan.lines) {
    const distinctFrom = [];
    for (const distinct of binding.newProduct?.distinctFrom ?? [])
      distinctFrom.push({
        ...distinct,
        productId: await resolveOrThrow(tx, "product", distinct.productId),
      });
    const id = binding.newProduct
      ? await products.resolve(line, newIdentity(distinctFrom))
      : binding.productId
        ? await resolveOrThrow(tx, "product", binding.productId)
        : null;
    resolvedProducts.set(binding.lineIndex, id);
  }
  await products.flush();
  // The locked review already proves these immutable source bytes. Product
  // and line choices are Decisions, not another source capture.
  const head = prior;
  await appendOrderPayments(database, [head]);
  const key = orderEventKey(head);
  const priorChoices = await tx
    .selectDistinctOn([decision.field])
    .from(decision)
    .where(
      and(
        eq(decision.channel, decisionChannel.enum.assignment),
        inArray(decision.subject, [
          `purchaseEvent:${key}`,
          `purchaseEvent:${orderEventKey(prior)}`,
          `purchaseEvent:${scope.key}`,
        ]),
      ),
    )
    .orderBy(decision.field, desc(decision.at), desc(decision.id));
  const unresolvedItems: {
    expenseId: string;
    lineIndex: number;
    title: string;
    reason: string;
  }[] = [];
  const decisions: import("~/server/kernel/api").DecisionInput[] = [
    {
      channel: "assignment",
      kind: "set",
      subject: key,
      field: "purchaseId",
      value: target.id,
      scopes: [scope],
    },
  ];
  // The review independently checked these unchanged bank allocations and
  // their payment facts. Preserve that settlement even when the cost changes.
  for (const allocation of state.allocations)
    decisions.push({
      channel: "identity",
      kind: "same",
      subject: key,
      field: recordSubject("financialTransaction", allocation.transactionId),
      scopes: [scope],
    });
  const assign = (subject: string, field: string, value: unknown) =>
    decisions.push({
      channel: "assignment",
      kind: value === null ? "none" : "set",
      subject,
      field,
      value: jsonSnapshot.parse(value),
      scopes: [scope],
    });
  const reject = (entity: string, id: string) =>
    decisions.push({
      channel: "rejection",
      kind: "reject",
      subject: recordSubject(entity, id),
      scopes: [scope],
    });
  const lineExpenses = new Map<number, string>();
  const reused = new Set<typeof expense.$inferSelect.id>();
  const valuesFor = (
    fields: NonNullable<ReturnType<typeof planReconciliationLine>["fields"]>,
  ) => {
    if (!("cost" in fields)) return fields;
    const cost = fields.cost;
    if (cost !== null && typeof cost !== "number")
      throw new Error("The reviewed Expense cost is invalid");
    return {
      ...fields,
      cost: nullableWholeCentToMinor(cost)?.toString() ?? null,
    };
  };
  for (const entry of plan.lines) {
    const action = planReconciliationLine(
      state,
      plan,
      entry,
      resolvedProducts.get(entry.binding.lineIndex) ?? null,
      reused,
      current,
    );
    const binding = head.productBindings.find(
      (row) => row.lineIndex === entry.binding.lineIndex,
    );
    const stableLine = binding?.stableLineId ?? String(entry.binding.lineIndex);
    const existing =
      action.kind === "attach" || action.reuse ? entry.existing : undefined;
    if (existing) reused.add(existing.id);
    const naturalKey = `line:${stableLine}`;
    const expenseId =
      existing?.id ?? recordIdentity(scope, "Expense", naturalKey);
    lineExpenses.set(entry.binding.lineIndex, expenseId);
    const previousLine = prior.productBindings.find(
      (row) => row.lineIndex === entry.binding.lineIndex,
    );
    const originalChoice =
      priorChoices.find((row) => row.field === `line:${stableLine}`) ??
      priorChoices.find(
        (row) =>
          row.field ===
          `line:${previousLine?.stableLineId ?? entry.binding.lineIndex}`,
      );
    const originalValue = originalChoice?.value;
    if (
      action.finding &&
      originalValue &&
      typeof originalValue === "object" &&
      !Array.isArray(originalValue) &&
      originalValue.kind === "unresolved"
    )
      unresolvedItems.push({
        expenseId,
        lineIndex: entry.binding.lineIndex,
        title: entry.line.title,
        reason:
          typeof originalValue.reason === "string"
            ? originalValue.reason
            : "The exact Product identity needs review.",
      });
    assign(
      `purchaseEvent:${key}`,
      `line-record:${stableLine}`,
      existing?.id ?? null,
    );
    const productId = resolvedProducts.get(entry.binding.lineIndex) ?? null;
    assign(
      `purchaseEvent:${key}`,
      `line:${stableLine}`,
      productId ? { kind: "existing", productId } : { kind: "expense_only" },
    );
    if (action.fields) {
      const fields = valuesFor(action.fields);
      if (existing)
        for (const [field, value] of Object.entries(fields))
          assign(recordSubject("expense", existing.id), field, value);
      else
        assign(`purchaseEvent:${scope.key}`, `record:Expense:${naturalKey}`, {
          table: "Expense",
          naturalKey,
          values: fields,
        });
    }
    if (action.kind === "replace") {
      for (const priorShare of state.attributions.filter(
        (row) => row.expenseId === existing?.id,
      ))
        reject("ExpenseAttribution", priorShare.id);
      for (const allocation of action.allocations) {
        const shareKey = `review:${head.id}:${entry.binding.lineIndex}:${allocation.role}:${allocation.ledgerPartyId ?? "unattributed"}`;
        assign(
          `purchaseEvent:${scope.key}`,
          `record:ExpenseAttribution:${shareKey}`,
          {
            table: "ExpenseAttribution",
            naturalKey: shareKey,
            values: { expenseId, ...allocation },
          },
        );
      }
    }
  }
  for (const id of planReconciliationRemovals(plan, reused))
    reject("expense", id);
  if (plan.header.statedTotal)
    assign(
      recordSubject("purchase", target.id),
      "statedTotal",
      plan.header.statedTotal.value?.toString() ?? null,
    );
  if (plan.header.orderId !== null)
    assign(
      recordSubject("purchase", target.id),
      "orderId",
      plan.header.orderId,
    );
  await decide(database, actor, decisions);
  const independentOwners = reused.size
    ? await tx
        .select({ kind: recordKey.scopeKind, key: recordKey.scopeKey })
        .from(recordKey)
        .where(
          and(
            eq(recordKey.entity, "expense"),
            inArray(recordKey.entityId, [...reused]),
            isNull(recordKey.mergedAt),
            isNull(recordKey.rejectedAt),
          ),
        )
    : [];
  const originalScopes = [
    ...new Map(
      independentOwners
        .filter((owner) => owner.kind !== scope.kind || owner.key !== scope.key)
        .map((owner) => [`${owner.kind}:${owner.key}`, owner] as const),
    ).values(),
  ];
  if (originalScopes.length) {
    const { reconcileNow } = await import("~/server/kernel/api");
    const originalOutcomes = await reconcileNow(database, originalScopes);
    const originalFailure = originalOutcomes.find(
      (outcome) => outcome.status === "failed" || outcome.status === "conflict",
    );
    if (originalFailure)
      throw new Error(
        originalFailure.error ??
          "The reviewed item's owning event did not reconcile",
      );
  }
  const outcomes = await settleOrderEvidence(database, [head]);
  const failed = outcomes.find(
    (row) => row.status === "failed" || row.status === "conflict",
  );
  if (failed)
    throw new Error(
      failed.error ?? "The reviewed source correction did not reconcile",
    );
  const checkedIds = [
    ...new Set([
      ...state.expenses.map((row) => row.id),
      ...lineExpenses.values(),
    ]),
  ];
  const after = await tx
    .select({ cost: expense.cost })
    .from(expense)
    .where(
      and(
        inArray(
          expense.id,
          checkedIds.map((id) => parseEntityId("expense", id)),
        ),
        notDeleted(expense),
      ),
    );
  const afterTotal = after.some((row) => row.cost === null)
    ? null
    : after.reduce((sum, row) => sum + (row.cost ?? 0n), 0n);
  if (afterTotal !== nullableWholeCentToMinor(current.spend.after))
    throw new Error(
      "The reviewed source correction did not preserve its exact spending result",
    );
  const { acceptedOrders } =
    await import("~/server/domains/purchase-import/repo/accepted-order-read");
  const [bound] = await tx
    .select({ purchaseId: acceptedOrders.purchaseId })
    .from(acceptedOrders)
    .where(eq(acceptedOrders.id, head.id));
  if (bound?.purchaseId !== target.id)
    throw new Error(
      "The reviewed source correction did not retain its Purchase identity",
    );
  if (plan.resolution.kind === "replace_lines") {
    const actual = await loadExpenseAllocations(tx, {
      expenseIds: [...lineExpenses.values()].map((id) =>
        parseEntityId("expense", id),
      ),
      includeFuture: true,
    });
    const expectedCents = new Map<string, bigint>();
    for (const share of current.attributions) {
      const expenseId = lineExpenses.get(share.lineIndex);
      if (!expenseId)
        throw new Error("The reviewed attribution line is missing");
      const partyId = share.partyId
        ? state.parties.find((row) => row.shortcode === share.partyId)?.id
        : null;
      if (share.partyId && !partyId)
        throw new Error("The reviewed attribution party is missing");
      const key = `${expenseId}:${share.role}:${partyId ?? "unattributed"}`;
      expectedCents.set(
        key,
        (expectedCents.get(key) ?? 0n) + moneyToMinor(share.amount),
      );
    }
    const actualCents = new Map(
      actual.map((row) => [
        `${row.expenseId}:${row.role}:${row.ledgerPartyId ?? "unattributed"}`,
        row.cents,
      ]),
    );
    if (
      [...new Set([...expectedCents.keys(), ...actualCents.keys()])].some(
        (key) =>
          (expectedCents.get(key) ?? 0n) !== (actualCents.get(key) ?? 0n),
      )
    )
      throw new Error(
        "The source correction did not preserve its reviewed beneficiary and funder cents",
      );
  }
  const { financialTransactionAllocation } = await import("~/server/db/schema");
  const { allocationDollars } =
    await import("~/server/domains/financial-transaction/repo/allocation-money");
  const afterAllocations = await tx
    .select()
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.purchaseId, target.id),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .orderBy(financialTransactionAllocation.id);
  if (
    (await reconciliationFingerprint(
      afterAllocations.map(allocationDollars),
    )) !== (await reconciliationFingerprint(state.allocations))
  )
    throw new Error(
      "The reviewed source correction changed an accepted bank allocation",
    );
  await (
    await import("~/server/domains/purchase-import/repo/reconciliation-observations")
  ).recordReviewedSourceMetadata(
    tx,
    state,
    fix,
    plan,
    head,
    lineExpenses,
    actor,
    current,
  );
  if (!plan.productOnly) {
    if (!target.vendorId)
      throw new Error("The accepted source Vendor is missing");
    const { recordRetainedImportAcceptance } =
      await import("~/server/domains/purchase-import/repo/source-claim-family");
    await recordRetainedImportAcceptance(tx, {
      ledgerPartyId: ownerId,
      kind: fix.source.kind,
      externalKey: fix.source.externalKey,
      checksum: head.checksum,
      orderKey: fix.orderKey,
      vendorId: target.vendorId,
      purchaseId: target.id,
      observationId: head.id,
      runId: prior.runId,
    });
    const { publishRunFinding } =
      await import("~/server/domains/run/repo/run-finding");
    for (const item of unresolvedItems)
      await publishRunFinding(tx, {
        runId: prior.runId,
        ledgerPartyId: ownerId,
        entityKind: "purchase",
        entityId: target.id,
        kind: "product_unresolved",
        summary: `Product resolution is required for “${item.title}”: ${item.reason}`,
        proposedFix: null,
        evidenceFingerprint: await reconciliationFingerprint({
          observationId: head.id,
          expenseId: item.expenseId,
          lineIndex: item.lineIndex,
          reason: item.reason,
        }),
      });
  }
  return outcomes;
}
