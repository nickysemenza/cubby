import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  ProposedImportFix,
  SourceOrderReconciliationResolution,
} from "@cubby/schemas/purchase-import";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  entityAttachment,
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  ledgerParty,
  ledgerSourceClaim,
  product,
  purchase,
  purchasePaymentEvidence,
  runFinding,
  sourceOrderObservation,
  vendorAccount,
} from "~/server/db/schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  acceptedSourceExtraction,
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import { lockPartySettlement } from "./retained-settlement";
import {
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";

export type ReconciliationFix = Extract<
  ProposedImportFix,
  { kind: "reconcile_source_order" }
> & { currentOriginalReview?: boolean };

/** Settlement precedes finding/source/Purchase locks on both write paths. */
export async function lockFindingSettlement(
  tx: DrizzleTransaction,
  id: string,
  actor: ActorContext,
) {
  const [owner] = await tx
    .select({ ledgerPartyId: runFinding.ledgerPartyId })
    .from(runFinding)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, runFinding.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(eq(runFinding.id, id));
  if (!owner) throw new Error("Import finding not found for this member.");
  await lockPartySettlement(tx, owner.ledgerPartyId);
}

async function reviewedProductIds(
  tx: DrizzleTransaction,
  resolution: SourceOrderReconciliationResolution | undefined,
) {
  const ids = new Set<string>();
  for (const binding of resolution?.lines ?? []) {
    if (binding.productId)
      ids.add(await resolveOrThrow(tx, "product", binding.productId));
    for (const distinct of binding.newProduct?.distinctFrom ?? [])
      ids.add(await resolveOrThrow(tx, "product", distinct.productId));
  }
  return ids;
}

// One locked snapshot covers source ownership, ledger and Product dependencies.
export async function loadSourceReconciliationState(
  tx: DrizzleTransaction,
  fix: ReconciliationFix,
  ownerId: typeof ledgerParty.$inferSelect.id,
  resolution: SourceOrderReconciliationResolution | undefined = fix.review
    ?.resolution,
  currentOriginalReview = fix.currentOriginalReview ?? false,
) {
  const family = await readImportSourceClaimFamily(
    tx,
    {
      ledgerPartyId: ownerId,
      kind: fix.source.kind,
      externalKey: fix.source.externalKey,
    },
    { lock: "update", writable: true },
  );
  if (!family)
    throw new Error("Source ownership changed; prepare reconciliation again.");
  const retained = await readSourceFamilyOrder(
    tx,
    family,
    fix.orderKey,
    "update",
  );
  const association = retained?.association ?? null;
  if (
    (association?.checksum ?? null) !== fix.acceptedChecksum ||
    (association && association.purchaseId !== fix.purchaseId)
  )
    throw new Error("Accepted source changed; prepare reconciliation again.");
  const [target] = await tx
    .select()
    .from(purchase)
    .where(
      and(
        eq(purchase.id, parseEntityId("purchase", fix.purchaseId)),
        notDeleted(purchase),
      ),
    )
    .for("update");
  if (!target) throw new Error("The accepted Purchase changed or was removed.");
  const accountIds = family.members.flatMap((claim) =>
    claim.vendorAccountId
      ? [parseEntityId("vendorAccount", claim.vendorAccountId)]
      : [],
  );
  const vendorAccounts = accountIds.length
    ? await tx
        .select()
        .from(vendorAccount)
        .where(inArray(vendorAccount.id, accountIds))
        .orderBy(asc(vendorAccount.id))
        .for("share")
    : [];
  if (
    vendorAccounts.length !== new Set(accountIds).size ||
    vendorAccounts.some(
      (account) =>
        account.deletedAt ||
        account.ledgerPartyId !== ownerId ||
        account.vendorId !== target.vendorId,
    )
  )
    throw new Error(
      "Source account ownership changed; prepare reconciliation again.",
    );
  const [observation] = fix.observationId
    ? await tx
        .select()
        .from(sourceOrderObservation)
        .where(eq(sourceOrderObservation.id, fix.observationId))
    : [];
  if (
    !observation ||
    !family.members.some((claim) => claim.id === observation.sourceClaimId) ||
    !(await sourceObservationIdentityMatches(
      tx,
      "purchase",
      observation.purchaseId,
      target.id,
    )) ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      observation.vendorId,
      target.vendorId,
    )) ||
    observation.orderKey !== fix.orderKey ||
    observation.checksum !== fix.source.checksum ||
    (await reconciliationFingerprint(observation.extraction)) !==
      (await reconciliationFingerprint(fix.proposedExtraction))
  )
    throw new Error(
      "Reconciliation requires the unchanged immutable source observation.",
    );
  const explicitExpenseIds = [];
  for (const binding of resolution?.lines ?? [])
    if (binding.expenseId)
      explicitExpenseIds.push(
        await resolveOrThrow(tx, "expense", binding.expenseId),
      );
  if (resolution?.kind === "replace_lines")
    for (const code of resolution.expenseIds)
      explicitExpenseIds.push(await resolveOrThrow(tx, "expense", code));
  const expenses = await tx
    .select()
    .from(expense)
    .where(
      and(
        or(
          eq(expense.purchaseId, target.id),
          explicitExpenseIds.length
            ? inArray(expense.id, explicitExpenseIds)
            : undefined,
        ),
        notDeleted(expense),
      ),
    )
    .orderBy(asc(expense.id))
    .for("update");
  if (
    expenses.some(
      (row) => row.purchaseId !== null && row.purchaseId !== target.id,
    )
  )
    throw new Error("A selected Expense belongs to a different Purchase.");
  const expenseIds = expenses.map((row) => row.id);
  const attributions = expenseIds.length
    ? await tx
        .select()
        .from(expenseAttribution)
        .where(
          and(
            inArray(expenseAttribution.expenseId, expenseIds),
            notDeleted(expenseAttribution),
          ),
        )
        .orderBy(asc(expenseAttribution.id))
        .for("update")
    : [];
  const ledgerClaims = expenseIds.length
    ? await tx
        .select()
        .from(ledgerSourceClaim)
        .where(
          and(
            inArray(ledgerSourceClaim.expenseId, expenseIds),
            notDeleted(ledgerSourceClaim),
          ),
        )
        .orderBy(asc(ledgerSourceClaim.id))
        .for("update")
    : [];
  const payments = await tx
    .select()
    .from(purchasePaymentEvidence)
    .where(eq(purchasePaymentEvidence.purchaseId, target.id))
    .orderBy(asc(purchasePaymentEvidence.id))
    .for("update");
  const allocations = await tx
    .select()
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(financialTransactionAllocation.purchaseId, target.id),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .orderBy(asc(financialTransactionAllocation.id))
    .for("update");
  const transactionIds = allocations.map((row) => row.transactionId);
  const transactions = transactionIds.length
    ? await tx
        .select()
        .from(financialTransaction)
        .where(inArray(financialTransaction.id, transactionIds))
        .orderBy(asc(financialTransaction.id))
        .for("share")
    : [];
  const financialAccountIds = transactions.map((row) => row.accountId);
  const financialAccounts = financialAccountIds.length
    ? await tx
        .select()
        .from(financialAccount)
        .where(inArray(financialAccount.id, financialAccountIds))
        .orderBy(asc(financialAccount.id))
        .for("share")
    : [];
  const sourceOrders = await tx
    .select()
    .from(importSourceOrder)
    .where(eq(importSourceOrder.purchaseId, target.id))
    .orderBy(asc(importSourceOrder.id))
    .for("update");
  const productBindings = sourceOrders.length
    ? await tx
        .select()
        .from(importSourceProduct)
        .where(
          inArray(
            importSourceProduct.sourceOrderId,
            sourceOrders.map((row) => row.id),
          ),
        )
        .orderBy(
          asc(importSourceProduct.sourceOrderId),
          asc(importSourceProduct.lineIndex),
        )
        .for("update")
    : [];
  const allProductIds = new Set(
    expenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  for (const binding of observation.productBindings)
    if (binding.productId)
      allProductIds.add(parseEntityId("product", binding.productId));
  for (const id of await reviewedProductIds(tx, resolution))
    allProductIds.add(parseEntityId("product", id));
  const products = allProductIds.size
    ? await tx
        .select()
        .from(product)
        .where(inArray(product.id, [...allProductIds]))
        .orderBy(asc(product.id))
        .for("share")
    : [];
  const inventory = allProductIds.size
    ? await tx
        .select()
        .from(inventoryEntry)
        .where(
          and(
            inArray(inventoryEntry.productId, [...allProductIds]),
            notDeleted(inventoryEntry),
          ),
        )
        .orderBy(asc(inventoryEntry.id))
        .for("share")
    : [];
  const parties = await tx
    .select()
    .from(ledgerParty)
    .where(notDeleted(ledgerParty))
    .orderBy(asc(ledgerParty.id))
    .for("share");
  const attachments = await tx
    .select()
    .from(entityAttachment)
    .where(
      and(
        eq(entityAttachment.entityKind, "purchase"),
        eq(entityAttachment.entityId, target.id),
        notDeleted(entityAttachment),
      ),
    )
    .orderBy(asc(entityAttachment.id))
    .for("update");
  const accepted = association
    ? await acceptedSourceExtraction(tx, association)
    : sourceOrders[0]
      ? await acceptedSourceExtraction(tx, sourceOrders[0])
      : null;
  return {
    family,
    association,
    target,
    observation,
    currentOriginalReview,
    accepted,
    expenses,
    attributions,
    ledgerClaims,
    payments,
    allocations,
    transactions,
    financialAccounts,
    sourceOrders,
    productBindings,
    products,
    inventory,
    parties,
    vendorAccounts,
    attachments,
  };
}

export type ReconciliationState = Awaited<
  ReturnType<typeof loadSourceReconciliationState>
>;
export async function sourceReconciliationStateFingerprint(
  state: ReconciliationState,
  proposal: Pick<
    ReconciliationFix,
    "source" | "orderKey" | "proposedExtraction" | "observationId"
  >,
  resolution?: SourceOrderReconciliationResolution,
) {
  return reconciliationFingerprint({
    ...state,
    proposal: {
      source: proposal.source,
      orderKey: proposal.orderKey,
      proposedExtraction: proposal.proposedExtraction,
      observationId: proposal.observationId,
    },
    resolution,
  });
}
