import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  mailResearchRunInput,
  purchaseValidationResearchRunInput,
} from "@cubby/schemas/run-fields";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  researchRetention,
  run,
  runEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { deleteS3Object } from "~/server/utils/s3";

import { startProductResearch } from "./product-research-run";
import { startPurchaseValidationResearch } from "./purchase-validation-research";
import { researchBrowserAccountIds } from "./research-browser-retention";
import { assertResearchTaskAdmission } from "./research-execution";
import { researchObjectivesOf } from "./research-objective";
import { startRetiredObjectiveResearch } from "./research-objective-admission";
import {
  authorizeResearchCoordinatorRetirement,
  processResearchRetention,
} from "./research-retention";
import {
  authorizeResearchRetirement,
  readResearchRetirementSuccessor,
} from "./research-retention-admission";
import { startMailResearch } from "./research-run";

/** Bound Worker effects; the external receipt owns ordering, manifests, and replay. */
export async function processBoundResearchRetention(
  db: Database,
  env: Env,
  input: { runId: string; receiptId: string },
) {
  await authorizeResearchCoordinatorRetirement(db, input);
  const retiredScope = async (runId: string) => {
    await authorizeResearchCoordinatorRetirement(db, { ...input, runId });
    // includes-deleted: cleanup remains authorized without restarting member-deleted work.
    const [scope] = await getDb(db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(runId)));
    if (!scope) throw new Error("Retired research Run is unavailable.");
    return scope;
  };
  return processResearchRetention(db, input.receiptId, {
    deleteObject: deleteS3Object,
    async forgetBrowserRun(retirement) {
      const accounts = await researchBrowserAccountIds(db, retirement);
      for (const accountId of accounts) {
        const result =
          await env.PURCHASE_IMPORT.getByName(accountId).forgetRun(retirement);
        if (!result.forgotten)
          throw new Error(
            "Browser cache disposal awaits its recorded devices or reviewed historical cache cutover.",
          );
      }
    },
    async retireCoordinator(retirement) {
      const scope = await retiredScope(retirement.runId);
      const purpose = agentImportRunPurpose.parse(scope.purpose);
      return env.PURCHASE_IMPORT_RUN.getByName(
        importRunAgentIdentity(scope.id, purpose),
      ).retire({ receiptId: retirement.receiptId });
    },
    async deleteScreenshot(screenshot) {
      const scope = await retiredScope(screenshot.runId);
      const ledgerPartyId = scope.ledgerPartyId;
      if (!ledgerPartyId)
        throw new Error("Screenshot disposal requires its owning member.");
      const id = z.uuid().safeParse(screenshot.imageRef);
      if (!id.success)
        throw new Error(
          "Historical browser Image disposal requires the reviewed ownership and deletion-manifest cutover.",
        );
      const [receipt] = await getDb(db)
        .select({ plan: researchRetention.plan })
        .from(researchRetention)
        .where(
          and(
            eq(researchRetention.id, screenshot.receiptId),
            eq(researchRetention.ledgerPartyId, ledgerPartyId),
          ),
        );
      if (
        !receipt?.plan.screenshotRefs.some(
          (entry) =>
            entry.runId === screenshot.runId &&
            entry.imageRef === screenshot.imageRef,
        )
      )
        throw new Error(
          "Screenshot disposal is absent from its authorized receipt.",
        );
      const [binary] = await getDb(db)
        .select({ id: runEvidence.id })
        .from(runEvidence)
        .where(
          and(
            eq(runEvidence.id, id.data),
            eq(runEvidence.runId, runEntityId.parse(screenshot.runId)),
          ),
        );
      if (!binary) {
        // Earlier physical disposal covered this fenced Run's frozen files.
        // A missing UUID alone never establishes screenshot ownership.
        const [disposed] = await getDb(db)
          .select({ id: researchRetention.id })
          .from(researchRetention)
          .where(
            and(
              eq(researchRetention.ledgerPartyId, ledgerPartyId),
              inArray(researchRetention.phase, [
                "objects_deleted",
                "coordinators_destroyed",
                "completed",
              ]),
              sql`${researchRetention.plan}->'retiredRunIds' @> ${JSON.stringify([scope.id])}::jsonb`,
            ),
          )
          .limit(1);
        if (!disposed)
          throw new Error(
            "Browser binary evidence does not belong to the retired Run.",
          );
      }
      // Binary object keys are already in the immutable receipt manifest. This reference
      // is not an Image and must never erase an independently owned household photo.
      return { disposition: "preserved" };
    },
    async transferUnfinished(retirement) {
      const scope = await retiredScope(retirement.runId);
      if (!scope.ledgerPartyId || !scope.actorUserId)
        throw new Error("Research successor requires its owning member.");
      if (researchObjectivesOf(scope.input)) {
        const successor = await startRetiredObjectiveResearch(
          db,
          {
            predecessorRunId: scope.id,
            receiptId: retirement.receiptId,
            ledgerPartyId: scope.ledgerPartyId,
            actorUserId: scope.actorUserId,
          },
          env.PURCHASE_AGENT_QUEUE,
        );
        return successor ? [successor.id] : [];
      }
      const targets = await getDb(db)
        .select()
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, scope.id),
            inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
          ),
        );
      const lineage = {
        ledgerPartyId: scope.ledgerPartyId,
        userId: scope.actorUserId,
        parentRunId: scope.id,
        retirementReceiptId: retirement.receiptId,
      };
      if (scope.purpose === "purchase_validation") {
        const authority = await authorizeResearchRetirement(getDb(db), {
          receiptId: retirement.receiptId,
          parentRunId: scope.id,
          ledgerPartyId: scope.ledgerPartyId,
          actorUserId: scope.actorUserId,
          purpose: "purchase_validation",
          taskKeys: targets.map((target) => target.entityId),
        });
        const existing = await readResearchRetirementSuccessor(
          getDb(db),
          authority,
        );
        if (!existing) {
          await assertResearchTaskAdmission(db, scope.id);
          if (!targets.length) return [];
        }
      } else if (!targets.length) return [];
      if (scope.purpose === "mail_import") {
        const frozen = mailResearchRunInput.parse(scope.input);
        const keys = new Set(targets.map((target) => target.workKey));
        const remaining = frozen.sources.filter(
          (source) =>
            keys.has(source.orderMailId) &&
            source.orderMailId !== retirement.excludedSourceId,
        );
        if (!remaining.length) return [];
        return (
          await startMailResearch(
            db,
            {
              ...lineage,
              messageIds: remaining.map((source) => source.orderMailId),
              expectedChecksums: remaining,
            },
            env.PURCHASE_AGENT_QUEUE,
          )
        ).map((entry) => entry.runId);
      }
      if (scope.purpose === "product_enrichment") {
        return (
          await startProductResearch(
            db,
            {
              ...lineage,
              productIds: targets.map((target) =>
                parseEntityId("product", target.entityId),
              ),
            },
            env.PURCHASE_AGENT_QUEUE,
          )
        ).map((entry) => entry.runId);
      }
      if (scope.purpose === "purchase_validation") {
        const frozen = purchaseValidationResearchRunInput.parse(scope.input);
        if (
          targets.some(
            (target) =>
              target.entityKind !== "purchase" ||
              !frozen.purchases.some(
                (item) => item.purchaseId === target.entityId,
              ),
          )
        )
          throw new Error(
            "Retired Purchase task differs from its frozen scope.",
          );
        const remaining = frozen.purchases.filter((item) =>
          targets.some((target) => target.entityId === item.purchaseId),
        );
        const successor = await startPurchaseValidationResearch(
          db,
          {
            ...lineage,
            purchaseIds: remaining.map((item) =>
              parseEntityId("purchase", item.purchaseId),
            ),
            selectedSources: remaining.flatMap((item) =>
              item.selectedSource
                ? [
                    {
                      purchaseId: parseEntityId("purchase", item.purchaseId),
                      sourceOrderId: item.selectedSource.sourceOrderId,
                    },
                  ]
                : [],
            ),
          },
          env.PURCHASE_AGENT_QUEUE,
        );
        return [successor.row.id];
      }
      throw new Error(
        "Retired objective research awaits its exact frozen-objective successor admission.",
      );
    },
  });
}
