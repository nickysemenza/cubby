import type { ActorContext } from "@cubby/schemas/context";
import {
  productId,
  parseEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  mailResearchRunInput,
  productResearchRunInput,
  purchaseValidationResearchRunInput,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, run, runTarget } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { researchDispatchPending } from "./dispatch";
import { admitProductResearch } from "./product-research-run";
import { admitPurchaseValidationResearch } from "./purchase-validation-research";
import {
  readResearchPredecessorSuccessor,
  researchContinuationTargets,
  type ResearchContinuation,
} from "./research-continuation-admission";
import {
  historicalMailSources,
  isHistoricalMailRun,
} from "./research-legacy-mail";
import { continueObjectiveResearchRun } from "./research-objective-continuation";
import { admitMailResearch } from "./research-run";

function continuedProductIds(
  scope: typeof run.$inferSelect,
  targets: (typeof runTarget.$inferSelect)[],
) {
  return [
    ...new Set(
      (scope.input === null
        ? targets.map((target) => target.entityId)
        : productResearchRunInput
            .parse(scope.input)
            .products.flatMap((item) => {
              const target = targets.find(
                (target) => target.workKey === item.productId,
              );
              return target ? [target.entityId] : [];
            })
      ).map((id) => productId.parse(id)),
    ),
  ];
}

async function continuedValidation(
  db: Database,
  actor: ActorContext,
  scope: typeof run.$inferSelect,
  targets: (typeof runTarget.$inferSelect)[],
  input: ResearchContinuation & { manualEvidenceUnavailable?: boolean },
) {
  const saved =
    scope.input === null
      ? null
      : purchaseValidationResearchRunInput.parse(scope.input);
  return await admitPurchaseValidationResearch(db, {
    ledgerPartyId: scope.ledgerPartyId!,
    userId: actor.userId,
    purchaseIds: [
      ...new Set(
        targets.map((target) => parseEntityId("purchase", target.entityId)),
      ),
    ],
    selectedSources:
      saved?.purchases.flatMap((item) => {
        const target = targets.find(
          (target) => target.workKey === item.purchaseId,
        );
        return item.selectedSource && target
          ? [
              {
                purchaseId: parseEntityId("purchase", target.entityId),
                sourceOrderId: item.selectedSource.sourceOrderId,
              },
            ]
          : [];
      }) ?? [],
    manualEvidenceUnavailable:
      input.manualEvidenceUnavailable ??
      saved?.purchases.some((item) => item.manualEvidenceUnavailable),
    continuation: input,
  });
}

/** Reuse source admission; never copy a predecessor's task/evidence bookkeeping. */
export async function continueResearchRun(
  db: Database,
  actor: ActorContext,
  input: {
    predecessorRunId: RunId;
    action: ResearchContinuation["action"];
    manualEvidenceUnavailable?: boolean;
  },
) {
  const database = getDb(db);
  const [predecessor] = await database
    .select({ scope: run })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(run.id, input.predecessorRunId),
        eq(run.actorUserId, actor.userId),
        notDeleted(run),
      ),
    );
  const scope = predecessor?.scope;
  if (!scope?.ledgerPartyId)
    throw new Error("Research continuation requires the owning member.");
  let admission:
    | Awaited<ReturnType<typeof admitMailResearch>>[number]
    | undefined;
  const existing = await readResearchPredecessorSuccessor(database, scope);
  if (existing) {
    admission = { row: existing, created: false };
  } else if (isHistoricalMailRun(scope)) {
    const { selected } = await historicalMailSources(database, scope);
    [admission] = await admitMailResearch(db, {
      ledgerPartyId: scope.ledgerPartyId,
      userId: actor.userId,
      messageIds: selected.map((source) => source.id),
      expectedChecksums: selected.map((source) => ({
        orderMailId: source.id,
        checksum: source.rawChecksum,
      })),
      continuation: input,
    });
  } else if (scope.purpose === "account_sync") {
    admission = await continueObjectiveResearchRun(db, actor, input);
  } else {
    const targets = researchContinuationTargets(
      scope,
      await database
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, scope.id)),
      input.action,
    );
    if (!targets.length)
      throw new Error("Research Run has no eligible work to continue.");
    if (scope.purpose === "product_enrichment") {
      const ids = continuedProductIds(scope, targets);
      const [productAdmission] = await admitProductResearch(db, {
        ledgerPartyId: scope.ledgerPartyId,
        userId: actor.userId,
        productIds: ids,
        // This boundary is an explicit member control. A retry's causal label
        // must not revoke catalog research or manufacture purchase context.
        cause: "member_request",
        continuation: input,
      });
      if (productAdmission)
        admission = {
          row: productAdmission.run,
          created: productAdmission.created,
        };
    } else if (scope.purpose === "purchase_validation") {
      admission = await continuedValidation(db, actor, scope, targets, input);
    } else {
      const sources = mailResearchRunInput.parse(scope.input);
      const selected = sources.sources.filter((source) =>
        targets.some((target) => target.workKey === source.orderMailId),
      );
      [admission] = await admitMailResearch(db, {
        ledgerPartyId: scope.ledgerPartyId,
        userId: actor.userId,
        messageIds: selected.map((source) => source.orderMailId),
        expectedChecksums: selected,
        continuation: input,
      });
    }
  }
  if (!admission) throw new Error("Research continuation was not admitted.");
  if (admission.row.predecessorRunId !== scope.id)
    throw new Error("Research work is already owned by another Run.");
  const successor = admission.row;
  const summary = {
    publicId: scope.shortcode,
    status: scope.status,
    successorRunId: successor.id,
    successorRunPublicId: successor.shortcode,
    successorStatus: successor.status,
    created: admission.created,
  };
  const pendingDispatch = researchDispatchPending(successor);
  if (!admission.created && !pendingDispatch) return summary;
  if (!successor.dispatchEventId)
    throw new Error("Research continuation dispatch identity is missing.");
  return {
    ...summary,
    dispatchRunId: successor.id,
    dispatchPublicId: successor.shortcode,
    dispatchPurpose: agentImportRunPurpose.parse(successor.purpose),
    dispatchEventId: successor.dispatchEventId,
  };
}
