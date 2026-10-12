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
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  sourceOrderObservation,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";

import {
  commitSourceOrderReconciliation,
  reviewResolution,
} from "./reconciliation";
import {
  promoteHistoricalAcceptedObservation,
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import {
  loadSourceReconciliationState,
  sourceReconciliationStateFingerprint,
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";
import { lockPartySettlement } from "./retained-settlement";
import { readImportSourceClaimFamily } from "./source-claim-family";

type AcceptedInput = Extract<
  PrepareSourceOrderReconciliationInput,
  { sourceOrderId: string }
>;
const appliedReview = z.object({
  sourceOrderId: z.uuid(),
  reviewedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  observationId: z.uuid(),
  postFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

async function acceptedFix(
  tx: DrizzleTransaction,
  id: string,
  actor: ActorContext,
  observationId?: string,
  promoteHistorical = false,
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
  if (!current.association.acceptedObservationId && promoteHistorical)
    current.association.acceptedObservationId =
      await promoteHistoricalAcceptedObservation(tx, current.association.id);
  if (!current.association.acceptedObservationId)
    throw new Error(
      "Accepted source has no known immutable observation; review its evidence first.",
    );
  const [observation] = await tx
    .select()
    .from(sourceOrderObservation)
    .where(
      eq(
        sourceOrderObservation.id,
        observationId ?? current.association.acceptedObservationId,
      ),
    );
  if (!observation)
    throw new Error("Accepted source immutable observation changed.");
  const fix: ReconciliationFix = {
    kind: "reconcile_source_order",
    purchaseId: current.association.purchaseId,
    source: importSourceIdentity.parse({
      kind: family.root.kind,
      externalKey: family.root.externalKey,
      checksum: observation.checksum,
    }),
    orderKey: current.association.orderKey,
    acceptedChecksum: current.association.checksum,
    proposedExtraction: observation.extraction,
    observationId: observation.id,
    reviewedFingerprint: "0".repeat(64),
  };
  return { fix, ownerId: current.claim.ledgerPartyId };
}

/** Only accepted prepare expands omitted lines; commit reviews the complete returned roster. */
async function completeAcceptedAttachmentResolution(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  input: AcceptedInput["resolution"],
): Promise<AcceptedInput["resolution"]> {
  const candidate = state.observation.extraction.candidate;
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
        row.name === sourceLine.title &&
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
      undefined,
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
    const review = await reviewResolution(tx, state, fix, resolution);
    if (review.spend.delta !== 0)
      throw new Error("Accepted-source association must preserve spend.");
    return prepareSourceOrderReconciliationOut.options[1].parse({
      sourceOrderId: input.sourceOrderId,
      ...review,
    });
  });
}

/** The AuditLog records a completed review, never work waiting for execution. */
export async function commitAcceptedSourceOrderReconciliation(
  db: Database,
  rawInput: CommitAcceptedSourceOrderReconciliationInput,
  actor: ActorContext,
) {
  const input = commitAcceptedSourceOrderReconciliationInput.parse(rawInput);
  if (input.review.resolution.kind !== "attach_only")
    throw new Error(
      "Accepted-source association only supports explicit attach-only review.",
    );
  return withTransaction(db, async (tx) => {
    const current = await acceptedFix(tx, input.sourceOrderId, actor);
    const [receipt] = await tx
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "purchase"),
          eq(auditLog.entityId, current.fix.purchaseId),
          sql`${auditLog.changes}->${"sourceOrderReconciliation"}->${"to"}->>${"sourceOrderId"} = ${input.sourceOrderId}`,
          sql`${auditLog.changes}->${"sourceOrderReconciliation"}->${"to"}->>${"reviewedFingerprint"} = ${input.review.reviewedFingerprint}`,
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    const recorded = receipt
      ? z
          .object({
            sourceOrderReconciliation: z.object({ to: appliedReview }),
          })
          .parse(receipt.changes).sourceOrderReconciliation.to
      : null;
    const { fix, ownerId } = recorded
      ? await acceptedFix(
          tx,
          input.sourceOrderId,
          actor,
          recorded.observationId,
        )
      : current;
    fix.review = input.review;
    fix.reviewedFingerprint = input.review.reviewedFingerprint;
    const state = await loadSourceReconciliationState(
      tx,
      fix,
      ownerId,
      input.review.resolution,
    );
    if (recorded) {
      if (
        (await reconciliationFingerprint(input.review)) !==
        recorded.reviewPayloadFingerprint
      )
        throw new Error(
          "The reviewed reconciliation payload changed; prepare it again.",
        );
      if (
        (await sourceReconciliationStateFingerprint(
          state,
          fix,
          input.review.resolution,
        )) !== recorded.postFingerprint
      )
        throw new Error(
          "Reconciliation state changed after applying this review; prepare it again.",
        );
      return commitAcceptedSourceOrderReconciliationOut.parse({
        purchaseId: state.target.shortcode,
        alreadyApplied: true,
      });
    }
    if (input.review.spend.delta !== 0)
      throw new Error(
        "Accepted-source association must preserve reviewed spend.",
      );
    await commitSourceOrderReconciliation(tx, fix, actor, ownerId);
    const after = await loadSourceReconciliationState(
      tx,
      fix,
      ownerId,
      input.review.resolution,
    );
    await logAuditEntry(tx, actor, {
      entityKind: "purchase",
      entityId: state.target.id,
      action: "update",
      changes: {
        sourceOrderReconciliation: {
          from: null,
          to: {
            sourceOrderId: input.sourceOrderId,
            reviewedFingerprint: input.review.reviewedFingerprint,
            reviewPayloadFingerprint: await reconciliationFingerprint(
              input.review,
            ),
            observationId: fix.observationId!,
            postFingerprint: await sourceReconciliationStateFingerprint(
              after,
              fix,
              input.review.resolution,
            ),
          },
        },
      },
    });
    return {
      purchaseId: parseShortcodeFor("purchase", state.target.shortcode),
      alreadyApplied: false,
    };
  });
}
