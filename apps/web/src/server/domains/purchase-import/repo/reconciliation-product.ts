import type { ProductId } from "@cubby/schemas/identifiers";

import type { DrizzleTransaction } from "~/server/db";
import {
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import type { ReconciliationExpenseContext } from "./reconciliation-apply";
import type { ReconciliationPlan } from "./reconciliation-plan";
import type { ReconciliationState } from "./reconciliation-state";
import { lineProductResolver } from "./writer";
import type { LineIdentityDecision } from "./writer-decisions";

type ReconciliationLine = ReconciliationPlan["lines"][number];

const newProductDecision = (
  distinctFrom: LineIdentityDecision["distinctFrom"],
): LineIdentityDecision => ({
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

/**
 * Resolves and, where reviewed, creates each line's Product before its Expense
 * is planned, in plan order. Product codes resolve in one read; a code it
 * misses fails at its own line. `flush` writes learned identifiers after the
 * last line.
 */
export async function prepareReconciliationProducts(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  lines: readonly ReconciliationLine[],
  applied: ReconciliationExpenseContext,
) {
  const codes = await resolveLiveShortcodes(
    tx,
    lines.flatMap(({ binding }) =>
      binding.newProduct
        ? (binding.newProduct.distinctFrom ?? []).map(
            ({ productId }) => productId,
          )
        : binding.productId
          ? [binding.productId]
          : [],
    ),
    "product",
  );
  const productFor = async (code: string) =>
    codes.get(code) ?? (await resolveOrThrow(tx, "product", code));
  const products = lineProductResolver(
    tx,
    state.target.vendorId,
    lines.flatMap(({ binding, line }) =>
      binding.newProduct ? [{ line, decision: newProductDecision([]) }] : [],
    ),
    {},
  );
  return {
    async resolve({ binding, line }: ReconciliationLine) {
      const distinctFrom = [];
      for (const distinct of binding.newProduct?.distinctFrom ?? []) {
        distinctFrom.push({
          ...distinct,
          productId: await productFor(distinct.productId),
        });
      }
      const productId: ProductId | null = binding.newProduct
        ? await products.resolve(line, newProductDecision(distinctFrom), (id) =>
            applied.audit.push({
              entityKind: "product",
              entityId: id,
              action: "create",
              changes: {
                name: { from: null, to: line.title },
                notes: { from: null, to: null },
              },
            }),
          )
        : binding.productId
          ? await productFor(binding.productId)
          : null;
      applied.resolvedBindings.push({
        lineIndex: binding.lineIndex,
        productId,
      });
      return productId;
    },
    flush: () => products.flush(),
  };
}
