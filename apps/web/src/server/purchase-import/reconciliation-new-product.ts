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
import {
  importPreparedLine,
  importPreparedOrder,
  run,
} from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  acceptedSourceExtraction,
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import type { ReconciliationState } from "./reconciliation-state";
import { assertNewLineProductIdentity } from "./writer";
import { importedLineMatchesExpense, sameLineTitle } from "./writer-policy";

type ReviewedLine = SourceOrderReconciliationResolution["lines"][number];

/**
 * Other accepted sources on the Purchase block only by an actual claim on the
 * selected item: a Product binding for the same item, or a known extraction
 * that contradicts the order identity or the item's quantity or price. Partial
 * lifecycle mail is a consistent subset, and unknown history stays unknown.
 */
async function acceptedSiblingConflicts(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  line: ExtractedPurchaseLine,
) {
  const ours = state.observation.extraction.candidate;
  let competingBindings = 0;
  let contradicting = 0;
  for (const order of state.sourceOrders) {
    if (order.id === state.association?.id) continue;
    const candidate = (await acceptedSourceExtraction(tx, order))?.extraction
      .candidate;
    if (!candidate || !ours) {
      // A real binding with unknown line history cannot be declared unrelated.
      if (
        state.productBindings.some(
          (binding) => binding.sourceOrderId === order.id,
        )
      )
        competingBindings++;
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
          cents(row.amount) !== 0 &&
          cents(row.amount) !== cents(line.amount),
      )
    )
      contradicting++;
    if (
      state.productBindings.some(
        (binding) =>
          binding.sourceOrderId === order.id &&
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
    ? await acceptedSiblingConflicts(tx, state, line)
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
    throw new Error(
      `New Product repair requires one exact unbound item Expense without competing source ownership. Line ${binding.lineIndex}: line kind ${line?.lineKind ?? "missing"}; requested existing Product ${binding.productId ? "yes" : "no"}; selected Expense ${selected ? "found" : "missing"}; selected Product ${selected?.productId ? "bound" : "unbound"}; economic role ${selected?.economicRole ?? "missing"}; line basis ${selected?.lineBasis ?? "missing"}; exact matching item Expenses: ${sameRows.length}; selected exact match ${selected && sameRows[0]?.id === selected.id ? "yes" : "no"}; ledger source claims: ${ledgerClaimCount}; competing accepted source bindings: ${siblings.competingBindings}; contradicting accepted sources: ${siblings.contradicting}.`,
    );
  return line;
}

async function freezePreparedNewProductLine(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  binding: ReviewedLine,
  order: typeof importPreparedOrder.$inferSelect,
  lines: readonly (typeof importPreparedLine.$inferSelect)[],
) {
  const line = await newProductRepairLine(tx, state, binding);
  const stored = lines.find((row) => row.position === binding.lineIndex);
  if (
    !stored ||
    (await reconciliationFingerprint(
      extractedPurchaseLine.parse(stored.line),
    )) !== (await reconciliationFingerprint(line))
  )
    throw new Error("Accepted original prepared line is missing or changed.");
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
  await assertNewLineProductIdentity(
    tx,
    line,
    state.target.vendorId,
    distinctFrom,
  );
  if (
    binding.newProduct?.preparedFingerprint &&
    binding.newProduct.preparedFingerprint !== preparedFingerprint
  )
    throw new Error(
      "Accepted original preparation changed after review; prepare it again.",
    );
  return preparedFingerprint;
}

/** Freeze existing prepared identities, never reconstruct missing original choices. */
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
    state.association.acceptedObservationId !== state.observation.id ||
    !state.observation.runId
  )
    throw new Error(
      "New Product repair requires a known accepted original and its preparation.",
    );
  const source = state.family.members.find(
    (claim) => claim.id === state.observation.sourceClaimId,
  );
  if (!source)
    throw new Error("Accepted original preparation ownership is unknown.");
  const orders = await tx
    .select({ order: importPreparedOrder })
    .from(importPreparedOrder)
    .innerJoin(
      run,
      and(
        eq(run.id, importPreparedOrder.runId),
        eq(run.ledgerPartyId, state.family.root.ledgerPartyId),
        notDeleted(run),
      ),
    )
    .where(
      and(
        eq(importPreparedOrder.runId, state.observation.runId),
        eq(importPreparedOrder.sourceKind, source.kind),
        eq(importPreparedOrder.sourceExternalKey, source.externalKey),
        eq(importPreparedOrder.sourceChecksum, state.observation.checksum),
        eq(importPreparedOrder.evidenceChecksum, state.observation.checksum),
      ),
    )
    .limit(51)
    .for("share", { of: importPreparedOrder });
  const matches = [];
  for (const { order } of orders)
    if (
      (await reconciliationFingerprint(
        importExtractionOutcome.parse(order.extraction),
      )) === (await reconciliationFingerprint(state.observation.extraction))
    )
      matches.push(order);
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
      state.target.vendorId,
    ))
  )
    throw new Error(
      "Accepted original preparation is missing, changed or ambiguous.",
    );
  const lines = await tx
    .select()
    .from(importPreparedLine)
    .where(eq(importPreparedLine.preparedOrderId, order.id))
    .for("share");
  const prepared = new Map<number, string>();
  for (const binding of requests) {
    prepared.set(
      binding.lineIndex,
      await freezePreparedNewProductLine(tx, state, binding, order, lines),
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
