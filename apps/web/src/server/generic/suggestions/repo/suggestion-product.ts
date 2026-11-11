import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { suggestionTable, product } from "~/server/db/schema";
import { prepareProductIdentityPair } from "~/server/domains/product/repo/match/product-identity-snapshot";
import { loadProductImageOrderFacts } from "~/server/domains/product/repo/match/product-match";
import { currentProductPairPolicy } from "~/server/domains/product/repo/match/product-match-candidate";
import { matchSurvivorImageOrder } from "~/server/domains/product/repo/match/product-match-ranking";
import { historicalConflictInputsChanged } from "~/server/domains/product/repo/product-variant-evidence";
import {
  type EntityKernelContext,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { suggestionStateColumns } from "~/server/generic/suggestions/repo/suggestion-state";

/**
 * The product_pair family's apply: lock both Products, recheck current identity
 * evidence and merge. The review engine owns Feedback and the receipt.
 */
export async function mergeReviewedProductPair(
  context: EntityKernelContext,
  input: {
    suggestionId: string;
    keepId: string;
    mergeId: string;
  },
) {
  const [prediction] = await getDb(context.db)
    .select({
      id: suggestionTable.id,
      family: suggestionTable.family,
      producer: suggestionTable.producer,
    })
    .from(suggestionTable)
    .where(eq(suggestionTable.id, input.suggestionId))
    .limit(1);
  if (!prediction || prediction.family !== "product_pair")
    throw new Error("Product pair Suggestion not found");
  const [keepId, mergeId] = await Promise.all([
    resolveOrThrow(context.db, "product", input.keepId),
    resolveOrThrow(context.db, "product", input.mergeId),
  ]);
  return withTransactionDatabase(context.db, async (transactionDb) => {
    await getDb(transactionDb)
      .select({ id: product.id })
      .from(product)
      .where(inArray(product.id, [keepId, mergeId].sort()))
      .orderBy(product.id)
      .for("update");
    const [state] = await getDb(transactionDb)
      .select(suggestionStateColumns)
      .from(suggestionTable)
      .where(eq(suggestionTable.id, prediction.id))
      .for("update")
      .limit(1);
    if (!currentProductPairPolicy(prediction.producer))
      throw new Error(
        "Product identity policy is obsolete; request a fresh suggestion",
      );
    const currentPair = await prepareProductIdentityPair(transactionDb, [
      keepId,
      mergeId,
    ]);
    if (
      !currentPair ||
      (prediction.producer?.kind === "rule" && !currentPair.exact)
    )
      throw new Error(
        "Current evidence does not support Product identity admission",
      );
    if (
      currentPair.verification === "pending_verification" &&
      !(await historicalConflictInputsChanged(
        transactionDb,
        currentPair.priorConflictIds,
        currentPair.fingerprint,
      ))
    )
      throw new Error(
        "Historical identity conflict; review updated inputs before merging",
      );
    if (currentPair.conflict)
      throw new Error("Confirmed variant conflict prevents Product merging");
    const pair = z
      .object({ otherId: z.uuid(), conflict: z.boolean().optional() })
      .parse(state?.data);
    if (
      !state?.active ||
      pair.conflict ||
      ![state.recordId, pair.otherId].includes(keepId) ||
      ![state.recordId, pair.otherId].includes(mergeId)
    )
      throw new Error(
        "Product pair is stale or has an unresolved identity conflict",
      );
    const txContext = { ...context, db: transactionDb };
    await withAuditReceipts(async () => {
      await executeEntityAs(txContext, "merge", {
        entity: "product",
        data: { keepId: input.keepId, mergeIds: [input.mergeId] },
      });
      const images = await loadProductImageOrderFacts(transactionDb, keepId);
      const ordered = matchSurvivorImageOrder(images);
      if (ordered.some((item, index) => item !== images[index])) {
        await executeEntity(txContext, {
          action: "update",
          entity: "product",
          id: parseShortcodeFor("product", input.keepId),
          data: {
            imageOrder: ordered.map((item) =>
              parseShortcodeFor("image", item.shortcode),
            ),
          },
        });
      }
    });
    return { ok: true as const };
  });
}
