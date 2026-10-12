import type { ActorContext } from "@cubby/schemas/context";
import { costTypeSchema } from "@cubby/schemas/expense-fields";
import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
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
import { tradeSchema } from "@cubby/schemas/task-fields";
import { cents } from "@cubby/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  expense,
  expenseAttribution,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerParty,
  purchase,
  purchasePaymentEvidence,
  runFinding,
  sourceOrderObservation,
} from "~/server/db/schema";
import { logAuditEntries } from "~/server/repo/audit-log";
import { assertClassificationPolicies } from "~/server/repo/classification-field-policy";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { validateExpenseInheritance } from "~/server/repo/expense-inheritance";
import {
  loadExpenseAllocations,
  type ExpenseAllocationRow,
} from "~/server/repo/household-contribution/allocation";
import { validateProductPolicy } from "~/server/repo/inheritance-validation";
import { cascadeRemoval } from "~/server/repo/removal/core";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { redistributeReplacementAttributions } from "./aggregate-replacement";
import { prepareAcceptedSourceOrderReconciliation } from "./reconciliation-accepted";
import {
  reconciliationFingerprint,
  recordSourceOrderObservation,
} from "./reconciliation-observations";
import {
  loadSourceReconciliationState,
  lockFindingSettlement,
  sourceReconciliationStateFingerprint,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";
import { matchCompletePaymentSet, sourceFinancialFacts } from "./writer-policy";
export { commitAcceptedSourceOrderReconciliation } from "./reconciliation-accepted";

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
) {
  const candidate = fix.proposedExtraction.candidate;
  if (!candidate) throw new Error("Reconciliation needs a readable candidate.");
  if (candidate.currency !== "USD")
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
  if (candidate.orderId !== null && state.target.orderId === null) {
    const owner = await tx.query.purchase.findFirst({
      where: and(
        eq(purchase.vendorId, state.target.vendorId),
        eq(purchase.orderId, candidate.orderId),
        notDeleted(purchase),
      ),
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
    throw new Error(
      "Attach-only bindings require a distinct Expense for each proposed line.",
    );
  if (
    bindings.length !== candidate.lines.length ||
    new Set(bindings.map((row) => row.lineIndex)).size !== bindings.length ||
    bindings.some((row) => !candidate.lines[row.lineIndex])
  )
    throw new Error("Review exactly one binding for each proposed order line.");
  for (const binding of bindings) {
    const line = candidate.lines[binding.lineIndex]!;
    const selected = binding.expenseId
      ? state.expenses.find((row) => row.shortcode === binding.expenseId)
      : null;
    if (binding.expenseId && !selected)
      throw new Error("A reviewed Expense no longer belongs to this Purchase.");
    if (
      binding.productId &&
      (!state.products.some(
        (row) => row.shortcode === binding.productId && !row.deletedAt,
      ) ||
        line.lineKind !== "principal")
    )
      throw new Error("Review a live Product for a principal line.");
    if (
      resolution.kind === "attach_only" &&
      (!selected ||
        selected.cost === null ||
        cents(selected.cost) !== cents(line.amount) ||
        selected.lineKind !== line.lineKind ||
        (selected.productQuantity !== null &&
          binding.productId !== null &&
          selected.productQuantity !== (line.quantity ?? 1)) ||
        (selected.productId &&
          state.products.find((row) => row.id === selected.productId)
            ?.shortcode !== binding.productId))
    )
      throw new Error(
        "Attach-only evidence must preserve each reviewed ledger amount, line kind and Product.",
      );
  }
  const beforeCents = state.expenses.every((row) => row.cost !== null)
    ? state.expenses.reduce((sum, row) => sum + cents(row.cost!), 0)
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
    if (
      candidate.lines.reduce((sum, row) => sum + cents(row.amount), 0) !==
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
      selected.some((row) => row.cost === null || row.economicRole !== "vendor")
    )
      throw new Error(
        "Review live vendor Expenses with known costs for replacement.",
      );
    if (
      bindings.some((row) => row.expenseId && !selectedIds.has(row.expenseId))
    )
      throw new Error(
        "Each reused Expense must be in the reviewed replacement roster.",
      );
    if (selected.length && bindings.some((row) => row.expenseId === null))
      throw new Error(
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
      (sum, row) => sum + cents(row.cost!),
      0,
    );
    const proposedTotal = candidate.lines.reduce(
      (sum, row) => sum + cents(row.amount),
      0,
    );
    if (selectedTotal !== proposedTotal && !resolution.attributionTargets)
      throw new Error(
        "Changed total requires explicit reviewed beneficiary and funder cent targets.",
      );
    if (resolution.attributionTargets) {
      const keys = resolution.attributionTargets.map(
        (row) => `${row.role}:${row.partyId ?? "~unattributed"}`,
      );
      if (new Set(keys).size !== keys.length)
        throw new Error(
          "Attribution cent targets must be unique per party and role.",
        );
      for (const role of ["beneficiary", "funder"] as const)
        if (
          resolution.attributionTargets
            .filter((row) => row.role === role)
            .reduce((sum, row) => sum + cents(row.amount), 0) !== proposedTotal
        )
          throw new Error(
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
          throw new Error(
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
      delta:
        beforeCents === null || afterCents === null
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
      description: row.description ?? undefined,
    })),
    proposedPayments: candidate.payments,
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

function partyIdForShortcode(
  state: Pick<ReconciliationState, "parties">,
  shortcode: string,
) {
  const party = state.parties.find((row) => row.shortcode === shortcode);
  if (!party) throw new Error("A reviewed attribution party is not live.");
  return party.id;
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
      .select()
      .from(runFinding)
      .where(eq(runFinding.id, input.id))
      .for("update");
    if (!finding || finding.status !== "open")
      throw new Error("This source finding has already been resolved.");
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
    await tx
      .update(runFinding)
      .set({
        proposedFix: proposedImportFix.parse({
          ...fix,
          reviewedFingerprint: review.reviewedFingerprint,
          review,
        }),
        updatedAt: new Date(),
      })
      .where(eq(runFinding.id, finding.id));
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
  await tx
    .insert(runFinding)
    .values({
      runId: state.observation.runId,
      ledgerPartyId: ownerId,
      entityKind: "purchase",
      entityId: state.target.id,
      kind: "product_unresolved",
      summary: `Product resolution is required for “${title}”: The reviewed order line has no matched Product.`,
      evidenceFingerprint: `replacement:${expenseId}`,
    })
    .onConflictDoNothing();
}

// Every reviewed effect and conservation assertion shares this transaction.
// eslint-disable-next-line complexity
export async function commitSourceOrderReconciliation(
  tx: DrizzleTransaction,
  fix: ReconciliationFix,
  actor: ActorContext,
  ownerId: typeof ledgerParty.$inferSelect.id,
) {
  if (!fix.review)
    throw new Error(
      "Review the source-order reconciliation before applying it.",
    );
  const state = await loadSourceReconciliationState(tx, fix, ownerId);
  // Refuse stale state before recalculating a now-invalid attribution correction.
  if (
    (await sourceReconciliationStateFingerprint(
      state,
      fix,
      fix.review.resolution,
    )) !== fix.reviewedFingerprint
  )
    throw new Error(
      "Reconciliation state changed after review; prepare it again.",
    );
  const current = await reviewResolution(tx, state, fix, fix.review.resolution);
  if (
    (await reconciliationFingerprint(current)) !==
    (await reconciliationFingerprint(fix.review))
  )
    throw new Error(
      "Reconciliation state changed after review; prepare it again.",
    );
  const candidate = fix.proposedExtraction.candidate!;
  const resolution = current.resolution;
  const audit = [];
  const reused = new Set<typeof expense.$inferSelect.id>();
  const selected =
    resolution.kind === "replace_lines"
      ? state.expenses.filter((row) =>
          resolution.expenseIds.some((id) => id === row.shortcode),
        )
      : [];
  for (const binding of resolution.lines) {
    const line = candidate.lines[binding.lineIndex]!;
    const existing = binding.expenseId
      ? state.expenses.find((row) => row.shortcode === binding.expenseId)!
      : null;
    const productId = binding.productId
      ? await resolveOrThrow(tx, "product", binding.productId)
      : null;
    if (resolution.kind === "attach_only") {
      if (
        existing &&
        ((!existing.productId && productId) || existing.purchaseId === null)
      ) {
        await tx
          .update(expense)
          .set({
            purchaseId: state.target.id,
            productId,
            productQuantity:
              existing.productQuantity ??
              (productId ? (line.quantity ?? 1) : null),
            updatedAt: new Date(),
          })
          .where(eq(expense.id, existing.id));
        audit.push({
          entityKind: "expense" as const,
          entityId: existing.id,
          action: "update" as const,
          changes: { productId: { from: null, to: productId } },
        });
      }
      if (existing && line.lineKind === "principal" && productId === null)
        await retainUnresolvedProductFinding(
          tx,
          state,
          ownerId,
          existing.id,
          line.title,
        );
      continue;
    }
    const template = existing ?? selected[0];
    const principal = line.lineKind === "principal";
    const fields = {
      purchaseId: state.target.id,
      name: line.title,
      cost: line.amount,
      lineKind: line.lineKind,
      lineBasis: "item_line" as const,
      productId,
      productQuantity: productId ? (line.quantity ?? 1) : null,
      projectId: principal ? (template?.projectId ?? null) : null,
      spendingCategoryId: principal
        ? (template?.spendingCategoryId ?? null)
        : null,
      trade: tradeSchema.nullable().parse(template?.trade ?? null),
      // A source-stated cost type wins; a replaced aggregate's was a placeholder.
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
    let row;
    if (existing && !reused.has(existing.id)) {
      [row] = await tx
        .update(expense)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(expense.id, existing.id))
        .returning();
      reused.add(existing.id);
      audit.push({
        entityKind: "expense" as const,
        entityId: existing.id,
        action: "update" as const,
        changes: {
          cost: { from: existing.cost, to: line.amount },
          name: { from: existing.name, to: line.title },
          productId: { from: existing.productId, to: productId },
        },
      });
      await tx
        .update(expenseAttribution)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(expenseAttribution.expenseId, existing.id),
            notDeleted(expenseAttribution),
          ),
        );
    } else {
      row = await insertWithShortcode(tx, "expense", fields);
      audit.push({
        entityKind: "expense" as const,
        entityId: row.id,
        action: "create" as const,
      });
    }
    if (!row) throw new Error("The reviewed Expense changed during commit.");
    const allocations = current.attributions.filter(
      (allocation) => allocation.lineIndex === binding.lineIndex,
    );
    if (allocations.length)
      await tx.insert(expenseAttribution).values(
        allocations.map((allocation) => ({
          expenseId: row.id,
          role: allocation.role,
          ledgerPartyId: allocation.partyId
            ? partyIdForShortcode(state, allocation.partyId)
            : null,
          weight: allocation.weight,
        })),
      );
    await validateExpenseInheritance(tx, row);
    if (principal && productId === null)
      await retainUnresolvedProductFinding(
        tx,
        state,
        ownerId,
        row.id,
        line.title,
      );
  }
  const removed = selected.filter((row) => !reused.has(row.id));
  if (removed.length) {
    await tx
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(
        inArray(
          expense.id,
          removed.map((row) => row.id),
        ),
      );
    await cascadeRemoval(tx, {
      entity: "expense",
      ids: removed.map((row) => row.id),
      audit: { into: audit },
    });
  }
  await validateProductPolicy(tx, { purchaseId: state.target.id });
  const [sum] = await tx
    .select({
      amount: sql<number>`sum(${expense.cost})::double precision`,
      unknown: sql<number>`count(*) FILTER (WHERE ${expense.cost} IS NULL)::int`,
    })
    .from(expense)
    .where(and(eq(expense.purchaseId, state.target.id), notDeleted(expense)));
  if (
    current.spend.after !== null &&
    (sum?.unknown || cents(sum?.amount ?? 0) !== cents(current.spend.after))
  )
    throw new Error(
      "Reconciliation did not conserve the reviewed Expense total.",
    );
  if (resolution.kind === "replace_lines")
    await tx
      .update(purchase)
      .set({
        itemizationEvidence: true,
        statedTotal: candidate.printedGrandTotal,
        updatedAt: new Date(),
      })
      .where(eq(purchase.id, state.target.id));
  if (state.target.orderId === null && candidate.orderId !== null) {
    await tx
      .update(purchase)
      .set({ orderId: candidate.orderId, updatedAt: new Date() })
      .where(eq(purchase.id, state.target.id));
    audit.push({
      entityKind: "purchase" as const,
      entityId: state.target.id,
      action: "update" as const,
      changes: { orderId: { from: null, to: candidate.orderId } },
    });
  }
  for (const imageId of [
    state.observation.primaryDocumentImageId,
    state.observation.screenshotImageId,
  ])
    if (imageId)
      await tx
        .insert(entityAttachment)
        .values({
          entityId: state.target.id,
          entityKind: "purchase",
          role: "attachment",
          imageId,
          documentKind: "order_confirmation",
        })
        .onConflictDoNothing();
  const outputFingerprint = await reconciliationFingerprint({
    observation: state.observation.id,
    reviewedFingerprint: fix.reviewedFingerprint,
  });
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
      ),
    )
    .orderBy(
      asc(sourceOrderObservation.createdAt),
      asc(sourceOrderObservation.id),
    )
    .limit(1);
  if (!firstObservation)
    throw new Error("Reconciliation observation provenance is missing.");
  const acceptedObservation = await recordSourceOrderObservation(
    tx,
    {
      sourceClaimId: state.observation.sourceClaimId,
      orderKey: fix.orderKey,
      purchaseId: state.target.id,
    },
    {
      runId: state.observation.runId,
      vendorId: state.target.vendorId,
      source: fix.source,
      extraction: fix.proposedExtraction,
      primaryDocumentImageId: state.observation.primaryDocumentImageId,
      screenshotImageId: state.observation.screenshotImageId,
    },
    resolution.lines.map((binding) => ({
      lineIndex: binding.lineIndex,
      productId:
        state.products.find((row) => row.shortcode === binding.productId)?.id ??
        null,
    })),
  );
  const [association] = await tx
    .insert(importSourceOrder)
    .values({
      sourceClaimId: state.observation.sourceClaimId,
      orderKey: fix.orderKey,
      purchaseId: state.target.id,
      checksum: fix.source.checksum,
      outputFingerprint,
      originalOrder: {
        checksum: firstObservation.checksum,
        extraction: firstObservation.extraction,
      },
      acceptedObservationId: acceptedObservation.id,
    })
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      set: {
        checksum: fix.source.checksum,
        acceptedObservationId: acceptedObservation.id,
        outputFingerprint,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!association)
    throw new Error("Accepted source association was not persisted.");
  if (!state.association)
    for (const binding of firstObservation.productBindings)
      if (binding.productId)
        await tx
          .insert(importSourceProduct)
          .values({
            sourceOrderId: association.id,
            lineIndex: binding.lineIndex,
            productId: parseEntityId("product", binding.productId),
          })
          .onConflictDoNothing();
  const ownedPayments = state.payments.filter(
    (row) => row.sourceClaimId === state.observation.sourceClaimId,
  );
  for (const [evidenceIndex, payment] of candidate.payments.entries()) {
    const old = ownedPayments.find(
      (row) => row.evidenceIndex === evidenceIndex,
    );
    const values = {
      amount: payment.amount,
      chargedAt: payment.chargedAt ? new Date(payment.chargedAt) : null,
      cardLastFour: payment.cardLastFour ?? null,
      description: payment.description ?? null,
    };
    if (old) {
      // Cosmetic description changes do not replace an accepted payment row.
      if (
        cents(old.amount) !== cents(values.amount) ||
        old.chargedAt?.toISOString() !== values.chargedAt?.toISOString() ||
        old.cardLastFour !== values.cardLastFour
      )
        await tx
          .update(purchasePaymentEvidence)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(purchasePaymentEvidence.id, old.id));
    } else
      await tx.insert(purchasePaymentEvidence).values({
        purchaseId: state.target.id,
        sourceClaimId: state.observation.sourceClaimId,
        evidenceIndex,
        ...values,
      });
  }
  const surplus = ownedPayments.filter(
    (row) => row.evidenceIndex >= candidate.payments.length,
  );
  if (surplus.length)
    await tx.delete(purchasePaymentEvidence).where(
      inArray(
        purchasePaymentEvidence.id,
        surplus.map((row) => row.id),
      ),
    );
  // Historical aliases retain their bytes and timestamps; only the canonical
  // source identity can be refreshed by a reviewed reconciliation.
  if (state.observation.sourceClaimId === state.family.root.id)
    await tx
      .update(importSourceClaim)
      .set({ checksum: fix.source.checksum, updatedAt: new Date() })
      .where(eq(importSourceClaim.id, state.family.root.id));
  audit.push({
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
  });
  await logAuditEntries(tx, actor, audit);
}
