import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { mergeProductMatchInput } from "@cubby/schemas/recommendations";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  productIdentitySnapshot,
  prepareProductIdentityPair,
} from "~/server/ai/product-identity";
import {
  assessment,
  assessmentState,
  feedback,
  product,
} from "~/server/db/schema";
import {
  type EntityKernelContext,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import { recordFeedback } from "~/server/repo/assessment";
import { withAuditReceipts } from "~/server/repo/audit-receipts";
import { getDb, withTransactionDatabase } from "~/server/repo/database-helpers";
import { canonicalJson } from "~/server/repo/entity-source";
import { loadProductImageOrderFacts } from "~/server/repo/product-match";
import { currentProductPairPolicy } from "~/server/repo/product-match-candidate";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { matchSurvivorImageOrder } from "~/server/services/product-match-ranking";

export async function mergeReviewedProductPair(
  context: EntityKernelContext,
  input: z.output<typeof mergeProductMatchInput>,
) {
  const operationId = `merge:${input.keepId}:${input.mergeId}:${input.expectedFingerprint}`;
  const previousReceipt = async (db: EntityKernelContext["db"]) =>
    getDb(db)
      .select({ id: feedback.id })
      .from(feedback)
      .where(
        and(
          eq(feedback.assessmentId, input.assessmentId),
          eq(feedback.operationId, `application:${operationId}`),
        ),
      )
      .limit(1);
  if ((await previousReceipt(context.db)).length) return { ok: true as const };
  const [keepId, mergeId] = await Promise.all([
    resolveOrThrow(context.db, "product", input.keepId),
    resolveOrThrow(context.db, "product", input.mergeId),
  ]);
  const [prediction] = await getDb(context.db)
    .select()
    .from(assessment)
    .where(eq(assessment.id, input.assessmentId))
    .limit(1);
  if (!prediction || prediction.family !== "product_pair")
    throw new Error("Product pair Assessment not found");
  await recordFeedback(context.db, {
    assessmentId: prediction.id,
    operationId,
    verdict: "correct",
    intent: "apply",
    authority: "member",
    actorUserId: context.actorContext.userId,
  });
  return withTransactionDatabase(context.db, async (transactionDb) => {
    await getDb(transactionDb)
      .select({ id: product.id })
      .from(product)
      .where(inArray(product.id, [keepId, mergeId].sort()))
      .orderBy(product.id)
      .for("update");
    const [state] = await getDb(transactionDb)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .for("update")
      .limit(1);
    if ((await previousReceipt(transactionDb)).length)
      return { ok: true as const };
    if (!currentProductPairPolicy(prediction.producer))
      throw new Error(
        "Product identity policy is obsolete; request a fresh assessment",
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
    const snapshots = await Promise.all(
      [keepId, mergeId].map((id) => productIdentitySnapshot(transactionDb, id)),
    );
    if (snapshots.some((value) => !value))
      throw new Error("Product identity evidence changed");
    const fingerprint = await sha256Hex(
      canonicalJson(snapshots.map((value) => value!.fingerprint).sort()),
    );
    if (
      state.fingerprint !== input.expectedFingerprint ||
      fingerprint !== input.expectedFingerprint
    )
      throw new Error(
        "Product pair evidence changed; request a fresh comparison",
      );
    const txContext = { ...context, db: transactionDb };
    const applied = await withAuditReceipts(async () => {
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
          id: input.keepId,
          data: {
            imageOrder: ordered.map((item) =>
              parseShortcodeFor("image", item.shortcode),
            ),
          },
        });
      }
    });
    await recordFeedback(transactionDb, {
      assessmentId: prediction.id,
      operationId: `application:${operationId}`,
      verdict: "correct",
      intent: "apply",
      authority: "member",
      actorUserId: context.actorContext.userId,
      receipt: {
        kind: "product_merge",
        auditIds: applied.auditIds,
        appliedAt: new Date().toISOString(),
        keepId,
        mergeId,
      },
    });
    return { ok: true as const };
  });
}
