import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  commitAcceptedSourceOrderReconciliationInput,
  commitAcceptedSourceOrderReconciliationOut,
  importSourceIdentity,
  prepareSourceOrderReconciliationOut,
  type CommitAcceptedSourceOrderReconciliationInput,
  type PrepareSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  expense,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  sourceOrderObservation,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  commitSourceOrderReconciliation,
  reviewResolution,
} from "./reconciliation";
import {
  promoteHistoricalAcceptedObservation,
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import { recordReviewedOriginal } from "./reconciliation-original-review";
import {
  loadSourceReconciliationState,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";
import { lockPartySettlement } from "./retained-settlement";
import {
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";
import { sameLineTitle } from "./writer-policy";

type AcceptedInput = Extract<
  PrepareSourceOrderReconciliationInput,
  { sourceOrderId: string }
>;
type AcceptedResolution =
  | AcceptedInput["resolution"]
  | CommitAcceptedSourceOrderReconciliationInput["resolution"];

const originalReviewReceipt = z.object({
  reviewedOriginalPreparation: z.object({
    to: commitAcceptedSourceOrderReconciliationInput.shape.reviewedPreparation
      .unwrap()
      .extend({
        sourceOrderId:
          commitAcceptedSourceOrderReconciliationInput.shape.sourceOrderId,
        acceptedObservationId: z.uuid(),
      }),
  }),
});

async function acceptedFix(
  tx: DrizzleTransaction,
  id: string,
  actor: ActorContext,
  promoteHistorical: boolean,
  reviewedPreparation?: CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"],
) {
  const selectOwned = () =>
    tx
      .select({ association: importSourceOrder, claim: importSourceClaim })
      .from(importSourceOrder)
      .innerJoin(
        importSourceClaim,
        eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
      )
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(eq(importSourceOrder.id, id));
  const [owner] = await selectOwned();
  if (!owner) throw new Error("Accepted source not found for this member.");
  await lockPartySettlement(tx, owner.claim.ledgerPartyId);
  const [current] = await selectOwned();
  if (!current || current.claim.ledgerPartyId !== owner.claim.ledgerPartyId)
    throw new Error("Accepted source ownership changed; review it again.");
  const family = await readImportSourceClaimFamily(
    tx,
    {
      ledgerPartyId: current.claim.ledgerPartyId,
      kind: current.claim.kind,
      externalKey: current.claim.externalKey,
    },
    { lock: "update" },
  );
  if (!family)
    throw new Error(
      "Accepted source canonical family changed; review its ownership.",
    );
  const association = reviewedPreparation
    ? (
        await readSourceFamilyOrder(
          tx,
          family,
          current.association.orderKey,
          "update",
        )
      )?.association
    : current.association;
  if (!association || association.purchaseId !== current.association.purchaseId)
    throw new Error(
      "Reviewed source family must still name the same Purchase.",
    );
  if (
    !reviewedPreparation &&
    !association.acceptedObservationId &&
    promoteHistorical
  )
    association.acceptedObservationId =
      await promoteHistoricalAcceptedObservation(tx, association.id);
  if (!reviewedPreparation && !association.acceptedObservationId)
    throw new Error(
      "Accepted source has no known immutable observation; review its evidence first.",
    );
  const [acceptedObservation] = association.acceptedObservationId
    ? await tx
        .select()
        .from(sourceOrderObservation)
        .where(eq(sourceOrderObservation.id, association.acceptedObservationId))
    : [];
  const reviewedObservation = reviewedPreparation
    ? await recordReviewedOriginal(
        tx,
        association,
        family,
        reviewedPreparation,
        actor,
      )
    : null;
  if (acceptedObservation && reviewedObservation && reviewedPreparation) {
    const receipts = await tx
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "purchase"),
          eq(auditLog.entityId, association.purchaseId),
        ),
      );
    const sameReview = receipts.some(({ changes }) => {
      const receipt = originalReviewReceipt.safeParse(changes);
      if (!receipt.success) return false;
      const reviewed = receipt.data.reviewedOriginalPreparation.to;
      return (
        reviewed.sourceOrderId === id &&
        reviewed.run === reviewedPreparation.run &&
        reviewed.stableOrderId === reviewedPreparation.stableOrderId
      );
    });
    if (
      !sameReview ||
      (await reconciliationFingerprint(acceptedObservation.extraction)) !==
        (await reconciliationFingerprint(reviewedObservation.extraction))
    )
      throw new Error(
        "A known accepted original uses its existing immutable observation.",
      );
  }
  const observation = acceptedObservation ?? reviewedObservation;
  if (!observation)
    throw new Error("Accepted source immutable observation changed.");
  const fix: ReconciliationFix = {
    kind: "reconcile_source_order",
    purchaseId: association.purchaseId,
    source: importSourceIdentity.parse({
      kind: family.root.kind,
      externalKey: family.root.externalKey,
      checksum: observation.checksum,
    }),
    orderKey: association.orderKey,
    acceptedChecksum: association.checksum,
    proposedExtraction: observation.extraction,
    observationId: observation.id,
    reviewedFingerprint: "0".repeat(64),
    currentOriginalReview: Boolean(reviewedPreparation),
  };
  return { fix, ownerId: current.claim.ledgerPartyId };
}

/** Accepted preview and commit expand omitted lines the same way. */
async function completeAcceptedAttachmentResolution(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  input: AcceptedResolution,
): Promise<AcceptedResolution> {
  const candidate = state.observation.extraction.candidate;
  if (
    new Set(input.lines.map((binding) => binding.expenseId)).size !==
    input.lines.length
  )
    throw new Error(
      "Attach-only bindings require a distinct Expense for each proposed line.",
    );
  if (
    new Set(input.lines.map((binding) => binding.lineIndex)).size !==
      input.lines.length ||
    input.lines.some((binding) => !candidate?.lines[binding.lineIndex])
  )
    throw new Error(
      "Accepted attachment bindings require unique known source line indexes.",
    );
  if (!candidate || input.lines.length === candidate.lines.length) return input;
  const lines = [...input.lines];
  const used = new Set(
    input.lines.flatMap((binding) =>
      binding.expenseId ? [binding.expenseId] : [],
    ),
  );
  for (const [lineIndex, sourceLine] of candidate.lines.entries()) {
    if (lines.some((binding) => binding.lineIndex === lineIndex)) continue;
    const matches = state.expenses.filter(
      (row) =>
        row.purchaseId === state.target.id &&
        !used.has(parseShortcodeFor("expense", row.shortcode)) &&
        sameLineTitle(row.name, sourceLine.title) &&
        row.cost !== null &&
        cents(row.cost) === cents(sourceLine.amount) &&
        row.lineKind === sourceLine.lineKind &&
        (row.productQuantity === null ||
          !row.productId ||
          row.productQuantity === (sourceLine.quantity ?? 1)),
    );
    const [selected] = matches;
    if (matches.length !== 1 || !selected)
      throw new Error(
        "Untouched accepted line mapping is unknown or ambiguous; review an explicit complete binding roster.",
      );
    const product = selected.productId
      ? state.products.find(
          (row) => row.id === selected.productId && !row.deletedAt,
        )
      : null;
    const acceptedProduct = state.observation.productBindings.find(
      (binding) => binding.lineIndex === lineIndex,
    )?.productId;
    if (
      (selected.productId && !product) ||
      (acceptedProduct &&
        (!selected.productId ||
          !(await sourceObservationIdentityMatches(
            tx,
            "product",
            acceptedProduct,
            selected.productId,
          ))))
    )
      throw new Error(
        "Untouched accepted Product binding changed; review an explicit complete roster.",
      );
    const expenseId = parseShortcodeFor("expense", selected.shortcode);
    used.add(expenseId);
    lines.push({
      lineIndex,
      expenseId,
      productId: product
        ? parseShortcodeFor("product", product.shortcode)
        : null,
    });
  }
  return {
    kind: "attach_only",
    lines: lines.sort((a, b) => a.lineIndex - b.lineIndex),
  };
}

/** Current item drift is a refusal for both fresh bindings and replays. */
function validateAcceptedAttachmentExpenses(
  state: ReconciliationState,
  resolution: AcceptedResolution,
) {
  const candidate = state.observation.extraction.candidate;
  for (const binding of resolution.lines) {
    const line = candidate?.lines[binding.lineIndex];
    const selected = state.expenses.find(
      (row) => row.shortcode === binding.expenseId,
    );
    const titleMatches =
      !!line && !!selected && sameLineTitle(selected.name, line.title);
    const ledgerClaimCount = state.ledgerClaims.filter(
      (claim) => claim.expenseId === selected?.id,
    ).length;
    if (
      !line ||
      !selected ||
      selected.purchaseId !== state.target.id ||
      selected.economicRole !== "vendor" ||
      selected.lineBasis !== "item_line" ||
      !titleMatches ||
      selected.cost === null ||
      cents(selected.cost) !== cents(line.amount) ||
      selected.lineKind !== line.lineKind ||
      (selected.productQuantity !== null &&
        selected.productQuantity !== (line.quantity ?? 1)) ||
      ledgerClaimCount > 0
    )
      throw new Error(
        `Accepted-source association must preserve an exact current item Expense without ledger source claims. Line ${binding.lineIndex}: economic role ${selected?.economicRole ?? "missing"}; line basis ${selected?.lineBasis ?? "missing"}; title matches: ${titleMatches}; amount ${selected?.cost ?? "missing"}; expected amount ${line?.amount ?? "missing"}; line kind ${selected?.lineKind ?? "missing"}; expected line kind ${line?.lineKind ?? "missing"}; quantity ${selected?.productQuantity ?? "unbound"}; expected quantity ${line?.quantity ?? 1}; ledger source claims: ${ledgerClaimCount}.`,
      );
  }
}

export async function prepareAcceptedSourceOrderReconciliation(
  db: Database,
  input: AcceptedInput,
  actor: ActorContext,
) {
  return withTransaction(db, async (tx) => {
    const { fix, ownerId } = await acceptedFix(
      tx,
      input.sourceOrderId,
      actor,
      !input.resolution.lines.some((binding) => binding.newProduct),
    );
    const state = await loadSourceReconciliationState(
      tx,
      fix,
      ownerId,
      input.resolution,
    );
    const resolution = await completeAcceptedAttachmentResolution(
      tx,
      state,
      input.resolution,
    );
    validateAcceptedAttachmentExpenses(state, resolution);
    const review = await reviewResolution(
      tx,
      state,
      fix,
      resolution,
      "product_binding",
    );
    if (review.spend.delta !== 0)
      throw new Error("Accepted-source association must preserve spend.");
    return prepareSourceOrderReconciliationOut.options[1].parse({
      sourceOrderId: input.sourceOrderId,
      ...review,
    });
  });
}

/** New Product decisions leave one receipt on their Expense for replay. */
const appliedNewProduct = z.object({
  acceptedSourceProduct: z.object({
    to: z.object({
      sourceOrderId: z.uuid(),
      lineIndex: z.number().int().nonnegative(),
      productId: z.uuid(),
    }),
  }),
});

/**
 * An unchanged command is recognized from the current item binding, never a
 * caller token: every completed line's live Expense has been validated, the
 * accepted observation binds the same Product, and an explicit new Product
 * decision retains its receipt intent. Other bindings need fresh review.
 */
async function appliedAcceptedBinding(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  sourceOrderId: string,
  resolution: AcceptedResolution,
) {
  if (!resolution.lines.some((row) => row.productId || row.newProduct))
    return false;
  for (const binding of resolution.lines) {
    const selected = state.expenses.find(
      (row) => row.shortcode === binding.expenseId,
    )!;
    const accepted = state.observation.productBindings.find(
      (row) => row.lineIndex === binding.lineIndex,
    )?.productId;
    if (!selected.productId) {
      if (binding.productId || binding.newProduct || accepted) return false;
      continue;
    }
    if (
      !accepted ||
      !(await sourceObservationIdentityMatches(
        tx,
        "product",
        accepted,
        selected.productId,
      ))
    )
      return false;
    if (binding.productId) {
      if (
        !(await sourceObservationIdentityMatches(
          tx,
          "product",
          await resolveOrThrow(tx, "product", binding.productId),
          selected.productId,
        ))
      )
        return false;
      continue;
    }
    if (!binding.newProduct) return false;
    const receipts = await tx
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "expense"),
          eq(auditLog.entityId, selected.id),
        ),
      );
    let created = false;
    for (const receipt of receipts) {
      const parsed = appliedNewProduct.safeParse(receipt.changes);
      const to = parsed.success ? parsed.data.acceptedSourceProduct.to : null;
      if (
        to?.sourceOrderId === sourceOrderId &&
        to.lineIndex === binding.lineIndex &&
        (await sourceObservationIdentityMatches(
          tx,
          "product",
          to.productId,
          selected.productId,
        ))
      )
        created = true;
    }
    if (!created) return false;
  }
  return true;
}

/** Product-only: binds existing exact item Expenses after re-reading and
 * validating current state in this transaction; money is never changed. */
export async function commitAcceptedSourceOrderReconciliation(
  db: Database,
  rawInput: CommitAcceptedSourceOrderReconciliationInput,
  actor: ActorContext,
) {
  const input = commitAcceptedSourceOrderReconciliationInput.parse(rawInput);
  return withTransaction(db, async (tx) => {
    const { fix, ownerId } = await acceptedFix(
      tx,
      input.sourceOrderId,
      actor,
      !input.resolution.lines.some((binding) => binding.newProduct),
      input.reviewedPreparation,
    );
    const state = await loadSourceReconciliationState(
      tx,
      fix,
      ownerId,
      input.resolution,
    );
    const purchaseId = parseShortcodeFor("purchase", state.target.shortcode);
    const resolution = await completeAcceptedAttachmentResolution(
      tx,
      state,
      input.resolution,
    );
    validateAcceptedAttachmentExpenses(state, resolution);
    if (
      await appliedAcceptedBinding(tx, state, input.sourceOrderId, resolution)
    )
      return commitAcceptedSourceOrderReconciliationOut.parse({
        purchaseId,
        alreadyApplied: true,
      });
    const review = await reviewResolution(
      tx,
      state,
      fix,
      resolution,
      "product_binding",
    );
    if (review.spend.delta !== 0)
      throw new Error("Accepted-source association must preserve spend.");
    fix.review = review;
    fix.reviewedFingerprint = review.reviewedFingerprint;
    await commitSourceOrderReconciliation(
      tx,
      fix,
      actor,
      ownerId,
      "product_binding",
    );
    if (input.reviewedPreparation) {
      const accepted = await readSourceFamilyOrder(
        tx,
        state.family,
        fix.orderKey,
      );
      if (!accepted?.association.acceptedObservationId)
        throw new Error("The reviewed original was not accepted.");
      await logAuditEntry(tx, actor, {
        entityKind: "purchase",
        entityId: state.target.id,
        action: "update",
        changes: {
          reviewedOriginalPreparation: {
            from: null,
            to: {
              sourceOrderId: input.sourceOrderId,
              ...input.reviewedPreparation,
              acceptedObservationId: accepted.association.acceptedObservationId,
            },
          },
        },
      });
    }
    for (const binding of input.resolution.lines) {
      if (!binding.newProduct) continue;
      const selected = state.expenses.find(
        (row) => row.shortcode === binding.expenseId,
      )!;
      const [bound] = await tx
        .select({ productId: expense.productId })
        .from(expense)
        .where(eq(expense.id, selected.id));
      if (!bound?.productId)
        throw new Error("The reviewed new Product was not bound.");
      await logAuditEntry(tx, actor, {
        entityKind: "expense",
        entityId: selected.id,
        action: "update",
        changes: {
          acceptedSourceProduct: {
            from: null,
            to: {
              sourceOrderId: input.sourceOrderId,
              lineIndex: binding.lineIndex,
              productId: bound.productId,
            },
          },
        },
      });
    }
    return commitAcceptedSourceOrderReconciliationOut.parse({
      purchaseId,
      alreadyApplied: false,
    });
  });
}
