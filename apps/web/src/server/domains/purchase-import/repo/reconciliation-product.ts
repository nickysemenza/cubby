import type { DrizzleTransaction } from "~/server/db";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import type { ReconciliationExpenseContext } from "./reconciliation-apply";
import type { planSourceOrderReconciliation } from "./reconciliation-plan";
import type { ReconciliationState } from "./reconciliation-state";
import { resolveLineProduct } from "./writer";

/** Resolve and, where reviewed, create the Product before planning its Expense. */
export async function resolveReconciliationProduct(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  entry: ReturnType<typeof planSourceOrderReconciliation>["lines"][number],
  applied: ReconciliationExpenseContext,
) {
  const { binding, line } = entry;
  const distinctFrom = [];
  for (const distinct of binding.newProduct?.distinctFrom ?? []) {
    distinctFrom.push({
      ...distinct,
      productId: await resolveOrThrow(tx, "product", distinct.productId),
    });
  }
  const productId = binding.newProduct
    ? await resolveLineProduct(
        tx,
        line,
        {
          productId: null,
          promote: true,
          variantDoubt: false,
          unresolvedReason: null,
          probability: 1,
          lineKind: "principal",
          kitKind: "single",
          reversalKind: null,
          distinctFrom,
        },
        state.target.vendorId,
        applied.productsByExternalIdentity,
        {
          onCreated: (id) =>
            applied.audit.push({
              entityKind: "product",
              entityId: id,
              action: "create",
              changes: {
                name: { from: null, to: line.title },
                notes: { from: null, to: null },
              },
            }),
        },
      )
    : binding.productId
      ? await resolveOrThrow(tx, "product", binding.productId)
      : null;
  applied.resolvedBindings.push({ lineIndex: binding.lineIndex, productId });
  return productId;
}
