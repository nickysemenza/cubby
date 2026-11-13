import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { productIdentityObservation } from "~/server/db/schema";
import { historicalConflictInputsChanged } from "~/server/domains/product/repo/product-variant-evidence";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import type { Review } from "~/server/generic/suggestions/repo/review";
import {
  decide,
  householdWrite,
  reconcileNow,
  recordSubject,
} from "~/server/kernel/api";

import { prepareProductIdentityPair } from "./product-identity-snapshot";
import { listProductMatchRows } from "./product-match-candidate";
import { productPairObservation } from "./product-pair-observation";

/** Product pair reviews record identity intent; the reconciler owns merging. */
export async function reviewProductPair(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  proposalHash: string,
) {
  const [fact] = input.suggestionId
    ? await getDb(db)
        .select()
        .from(productIdentityObservation)
        .where(eq(productIdentityObservation.id, input.suggestionId))
    : [];
  if (!fact) return null;
  return householdWrite(db, async (database) => {
    const observed = productPairObservation.parse(fact.payload);
    const [row] = await listProductMatchRows(database, undefined, {
      suggestionIds: [fact.id],
    });
    if (!row) throw new Error("Product pair is no longer available");
    if (
      input.expectedFingerprint &&
      input.expectedFingerprint !== row.fingerprint
    )
      throw new Error(
        "Product identity evidence changed; review the current pair",
      );
    const applying = input.intent === "apply";
    if (applying && !input.expectedFingerprint)
      throw new Error(
        "Review the current Product identity fingerprint before merging",
      );
    if (applying && (input.verdict !== "correct" || input.correction.present))
      throw new Error("Merge requires an accepted Product identity pair");
    const current = await prepareProductIdentityPair(database, [
      row.productAId,
      row.productBId,
    ]);
    if (
      applying &&
      (!current ||
        current.conflict ||
        (current.verification === "pending_verification" &&
          !(await historicalConflictInputsChanged(
            database,
            current.priorConflictIds,
            current.fingerprint,
          ))))
    )
      throw new Error(
        "Product identity conflicts require corrected evidence before merging",
      );
    const scope = { kind: "productIdentity", key: observed.productPair };
    const [held] = await decide(database, context.actorContext, [
      applying || ["wrong", "dismissed"].includes(input.verdict)
        ? {
            channel: "identity",
            kind: applying ? "same" : "distinct",
            subject: recordSubject("product", row.productAId),
            field: recordSubject("product", row.productBId),
            scopes: [scope],
            proposalHash,
          }
        : {
            channel: "assignment",
            kind: "set",
            subject: `productPair:${observed.productPair}`,
            field: `review:${input.operationId}`,
            value: { verdict: input.verdict, reason: input.reason ?? null },
            scopes: [scope],
            proposalHash,
          },
    ]);
    if (applying && input.application?.kind === "product_merge")
      await decide(database, context.actorContext, [
        {
          channel: "assignment",
          kind: "set",
          subject: `productPair:${observed.productPair}`,
          field: "keepId",
          value: input.application.keepId,
          scopes: [scope],
        },
      ]);
    const outcomes = await reconcileNow(database, [scope]);
    const failure = outcomes.find((outcome) => outcome.error);
    if (failure) throw new Error(failure.error!);
    return {
      suggestionId: fact.id,
      feedbackId: held!.id,
      status: "decided",
      applied: applying,
    };
  });
}
