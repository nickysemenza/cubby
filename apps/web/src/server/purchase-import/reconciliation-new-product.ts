import {
  extractedPurchaseLine,
  importExtractionOutcome,
  preparedProductCandidate,
  type SourceOrderReconciliationResolution,
} from "@cubby/schemas/purchase-import";
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
  reconciliationFingerprint,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import type { ReconciliationState } from "./reconciliation-state";
import { assertNewLineProductIdentity } from "./writer";
import { importedLineMatchesExpense } from "./writer-policy";

type ReviewedLine = SourceOrderReconciliationResolution["lines"][number];

function newProductRepairLine(
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
  const otherSourceOrderCount = state.sourceOrders.filter(
    (accepted) => accepted.id !== state.association?.id,
  ).length;
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
    otherSourceOrderCount > 0
  )
    throw new Error(
      `New Product repair requires one exact unbound item Expense without competing source ownership. Line ${binding.lineIndex}: line kind ${line?.lineKind ?? "missing"}; requested existing Product ${binding.productId ? "yes" : "no"}; selected Expense ${selected ? "found" : "missing"}; selected Product ${selected?.productId ? "bound" : "unbound"}; economic role ${selected?.economicRole ?? "missing"}; line basis ${selected?.lineBasis ?? "missing"}; exact matching item Expenses: ${sameRows.length}; selected exact match ${selected && sameRows[0]?.id === selected.id ? "yes" : "no"}; ledger source claims: ${ledgerClaimCount}; other accepted source orders: ${otherSourceOrderCount}.`,
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
  const line = newProductRepairLine(state, binding);
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
