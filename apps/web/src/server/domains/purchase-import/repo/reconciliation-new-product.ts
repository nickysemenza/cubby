import type { RunId } from "@cubby/schemas/identifiers";
import {
  extractedPurchaseLine,
  importExtractionOutcome,
  preparedProductCandidate,
  type ExtractedPurchaseLine,
  type SourceOrderReconciliationResolution,
} from "@cubby/schemas/purchase-import";
import { cents } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  importPreparedLine,
  importPreparedOrder,
  run,
  sourceOrderObservation,
} from "~/server/db/schema";
import {
  importedLineMatchesExpense,
  sameLineTitle,
} from "~/server/domains/purchase-import/policy/import-lines";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  acceptedSourceExtraction,
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import type { ReconciliationState } from "./reconciliation-state";
import { assertNewLineProductIdentity } from "./writer";

type ReviewedLine = SourceOrderReconciliationResolution["lines"][number];

/**
 * Other accepted sources on the Purchase block only by an actual claim on the
 * selected item: a Product binding for the same item, or a known extraction
 * that contradicts the order identity or the item's quantity or price. Partial
 * lifecycle mail is a consistent subset, and unknown history stays unknown.
 */
export async function acceptedSiblingConflicts(
  tx: DrizzleTransaction,
  state: Pick<
    ReconciliationState,
    "observation" | "sourceOrders" | "productBindings"
  > & { associationId?: string },
  line: ExtractedPurchaseLine,
) {
  const siblings = [];
  for (const order of state.sourceOrders) {
    if (
      order.id === state.associationId ||
      order.acceptedObservationId === state.observation.id
    )
      continue;
    const candidate = (await acceptedSourceExtraction(tx, order))?.extraction
      .candidate;
    const [observation] = order.acceptedObservationId
      ? await tx
          .select({ productBindings: sourceOrderObservation.productBindings })
          .from(sourceOrderObservation)
          .where(eq(sourceOrderObservation.id, order.acceptedObservationId))
      : [];
    const bindings = [
      ...state.productBindings.filter(
        (binding) =>
          binding.sourceOrderId === order.id && binding.productId !== null,
      ),
      ...(observation?.productBindings.filter((binding) => binding.productId) ??
        []),
    ];
    siblings.push({ candidate, bindings });
  }
  return sourceItemConflicts(
    state.observation.extraction.candidate,
    line,
    siblings,
  );
}

/** Shared item ownership and contradiction policy for retained and canonical accepted sources. */
export function sourceItemConflicts(
  ours:
    | (typeof sourceOrderObservation.$inferSelect.extraction)["candidate"]
    | undefined,
  line: ExtractedPurchaseLine,
  siblings: readonly {
    candidate:
      | (typeof sourceOrderObservation.$inferSelect.extraction)["candidate"]
      | undefined;
    bindings: readonly { lineIndex: number }[];
  }[],
) {
  let competingBindings = 0;
  let contradicting = 0;
  for (const { candidate, bindings } of siblings) {
    if (!candidate || !ours) {
      // A real binding with unknown line history cannot be declared unrelated.
      if (bindings.length) competingBindings++;
      continue;
    }
    const items = candidate.lines.flatMap((row, lineIndex) =>
      sameLineTitle(row.title, line.title) &&
      (row.lineKind ?? line.lineKind) === line.lineKind
        ? [{ row, lineIndex }]
        : [],
    );
    const quantity = line.quantity ?? 1;
    if (
      (candidate.orderId !== null &&
        ours.orderId !== null &&
        candidate.orderId !== ours.orderId) ||
      (candidate.currency !== null &&
        ours.currency !== null &&
        candidate.currency !== ours.currency) ||
      items.reduce((sum, { row }) => sum + (row.quantity ?? 1), 0) > quantity ||
      items.some(
        ({ row }) =>
          (row.quantity ?? 1) === quantity &&
          (row.amount === null || line.amount === null
            ? row.amount !== line.amount
            : cents(row.amount) !== cents(line.amount)),
      )
    )
      contradicting++;
    if (
      bindings.some(
        (binding) =>
          !candidate.lines[binding.lineIndex] ||
          items.some(({ lineIndex }) => lineIndex === binding.lineIndex),
      )
    )
      competingBindings++;
  }
  return { competingBindings, contradicting };
}

async function newProductRepairLine(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  binding: ReviewedLine,
) {
  const line = state.observation.extraction.candidate?.lines[binding.lineIndex];
  const selected = state.expenses.find(
    (row) => row.shortcode === binding.expenseId,
  );
  const sameRows = line
    ? state.expenses.filter(
        (row) =>
          row.purchaseId === state.target.id &&
          row.economicRole === "vendor" &&
          importedLineMatchesExpense(
            {
              title: row.name,
              amount: row.cost,
              lineKind: row.lineKind,
              productQuantity: row.productQuantity,
            },
            line,
          ),
      )
    : [];
  const ledgerClaimCount = state.ledgerClaims.filter(
    (claim) => claim.expenseId === selected?.id,
  ).length;
  const siblings = line
    ? await acceptedSiblingConflicts(
        tx,
        { ...state, associationId: state.association?.id },
        line,
      )
    : { competingBindings: 0, contradicting: 0 };
  if (
    !line ||
    line.lineKind !== "principal" ||
    binding.productId ||
    !selected ||
    selected.productId ||
    selected.economicRole !== "vendor" ||
    selected.lineBasis !== "item_line" ||
    sameRows.length !== 1 ||
    sameRows[0]?.id !== selected.id ||
    ledgerClaimCount > 0 ||
    siblings.competingBindings > 0 ||
    siblings.contradicting > 0
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      `New Product repair requires one exact unbound item Expense without competing source ownership. Line ${binding.lineIndex}: line kind ${line?.lineKind ?? "missing"}; requested existing Product ${binding.productId ? "yes" : "no"}; selected Expense ${selected ? "found" : "missing"}; selected Product ${selected?.productId ? "bound" : "unbound"}; economic role ${selected?.economicRole ?? "missing"}; line basis ${selected?.lineBasis ?? "missing"}; exact matching item Expenses: ${sameRows.length}; selected exact match ${selected && sameRows[0]?.id === selected.id ? "yes" : "no"}; ledger source claims: ${ledgerClaimCount}; competing accepted source bindings: ${siblings.competingBindings}; contradicting accepted sources: ${siblings.contradicting}.`,
    );
  return line;
}

export async function freezePreparedNewProductLine(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: typeof sourceOrderObservation.$inferSelect.vendorId,
  binding: ReviewedLine,
  order: typeof importPreparedOrder.$inferSelect,
  lines: readonly (typeof importPreparedLine.$inferSelect)[],
) {
  const stored = lines.find((row) => row.position === binding.lineIndex);
  if (
    !stored ||
    (await reconciliationFingerprint(
      extractedPurchaseLine.parse(stored.line),
    )) !== (await reconciliationFingerprint(line))
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Accepted original prepared line is missing or changed.",
    );
  const preparedFingerprint = await reconciliationFingerprint({
    order,
    line: {
      ...stored,
      candidates: z.array(preparedProductCandidate).parse(stored.candidates),
    },
  });
  const distinctFrom = [];
  for (const distinct of binding.newProduct?.distinctFrom ?? [])
    distinctFrom.push({
      ...distinct,
      productId: await resolveOrThrow(tx, "product", distinct.productId),
    });
  await assertNewLineProductIdentity(tx, line, vendorId, distinctFrom);
  if (
    binding.newProduct?.preparedFingerprint &&
    binding.newProduct.preparedFingerprint !== preparedFingerprint
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Accepted original preparation changed after review; prepare it again.",
    );
  return preparedFingerprint;
}

/** A fresh owned preparation may review the same immutable original. Never
 * infer an extraction or binding from today's ledger when history is unknown. */
export async function reviewPreparedNewProducts(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  resolution: SourceOrderReconciliationResolution,
): Promise<SourceOrderReconciliationResolution> {
  const requests = resolution.lines.filter((binding) => binding.newProduct);
  if (!requests.length) return resolution;
  if (
    resolution.kind !== "attach_only" ||
    !state.association ||
    (state.association.acceptedObservationId !== state.observation.id &&
      !state.currentOriginalReview)
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "New Product repair requires a known accepted original and its preparation.",
    );
  const source = state.currentOriginalReview
    ? state.family.root
    : state.family.members.find(
        (claim) => claim.id === state.observation.sourceClaimId,
      );
  if (!source)
    throw new Error("Accepted original preparation ownership is unknown.");
  const { order, lines } = await readAcceptedPreparation(
    tx,
    state.observation,
    source,
    state.family.root.ledgerPartyId,
    state.target.vendorId,
  );
  const prepared = new Map<number, string>();
  for (const binding of requests) {
    prepared.set(
      binding.lineIndex,
      await freezePreparedNewProductLine(
        tx,
        await newProductRepairLine(tx, state, binding),
        state.target.vendorId,
        binding,
        order,
        lines,
      ),
    );
  }
  return {
    ...resolution,
    lines: resolution.lines.map((binding) =>
      binding.newProduct
        ? {
            ...binding,
            newProduct: {
              ...binding.newProduct,
              preparedFingerprint: prepared.get(binding.lineIndex)!,
            },
          }
        : binding,
    ),
  };
}

/** Read the immutable original preparation under its member and source ownership. */
export async function readAcceptedPreparation(
  tx: DrizzleTransaction,
  observation: typeof sourceOrderObservation.$inferSelect,
  source: { kind: string; externalKey: string },
  ownerId: NonNullable<
    typeof sourceOrderObservation.$inferSelect.ledgerPartyId
  >,
  vendorId: typeof sourceOrderObservation.$inferSelect.vendorId,
  selection?: { run: string; stableOrderId: string },
) {
  const selectedRunId = selection
    ? await resolveOrThrow(tx, "run", selection.run)
    : null;
  const readOrders = (runId: RunId | null) =>
    tx
      .select({ order: importPreparedOrder })
      .from(importPreparedOrder)
      .innerJoin(
        run,
        and(
          selectedRunId
            ? eq(importPreparedOrder.runId, selectedRunId)
            : runId
              ? eq(importPreparedOrder.runId, runId)
              : undefined,
          eq(run.id, importPreparedOrder.runId),
          eq(run.ledgerPartyId, ownerId),
          notDeleted(run),
        ),
      )
      .where(
        and(
          eq(importPreparedOrder.sourceKind, source.kind),
          selection
            ? eq(importPreparedOrder.stableOrderId, selection.stableOrderId)
            : undefined,
          eq(importPreparedOrder.sourceExternalKey, source.externalKey),
          eq(importPreparedOrder.sourceChecksum, observation.checksum),
          eq(importPreparedOrder.evidenceChecksum, observation.checksum),
        ),
      )
      .limit(51)
      .for("share", { of: importPreparedOrder });
  const matchingOrders = async (
    orders: Awaited<ReturnType<typeof readOrders>>,
  ) => {
    const matches = [];
    for (const { order } of orders)
      if (
        (await reconciliationFingerprint(
          importExtractionOutcome.parse(order.extraction),
        )) === (await reconciliationFingerprint(observation.extraction))
      )
        matches.push(order);
    return matches;
  };
  // Later equivalent reviews must not make a valid original ambiguous or
  // consume its bounded lookup. Fallback history is inspected only if needed.
  let orders = await readOrders(observation.runId);
  let matches = await matchingOrders(orders);
  if (!matches.length && observation.runId && !selection) {
    orders = await readOrders(null);
    matches = await matchingOrders(orders);
  }
  const [order] = matches;
  if (
    orders.length > 50 ||
    matches.length !== 1 ||
    !order ||
    !order.vendorId ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      order.vendorId,
      vendorId,
    ))
  )
    throw createAppError(
      "PURCHASE_IMPORT_REVIEW_STALE",
      "Accepted original preparation is missing, changed or ambiguous.",
    );
  const lines = await tx
    .select()
    .from(importPreparedLine)
    .where(eq(importPreparedLine.preparedOrderId, order.id))
    .for("share");
  return { order, lines };
}
