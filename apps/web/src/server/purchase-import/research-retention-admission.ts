import type { LedgerPartyId, RunId, UserId } from "@cubby/schemas/identifiers";
import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { researchRetention, run, runTarget } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

import { readResearchPredecessorSuccessor } from "./research-continuation-admission";

/** A cleanup receipt authorizes fresh tasks, never an exception to domain writes. */
async function retirementAdmission(
  client: DrizzleClient | DrizzleTransaction,
  input: {
    receiptId?: string;
    parentRunId?: RunId;
    ledgerPartyId: LedgerPartyId;
    actorUserId: UserId;
    purpose: Exclude<AgentImportRunPurpose, "photo_inventory">;
    taskKeys: readonly string[];
  },
  lockPredecessor: boolean,
) {
  if (!input.receiptId) return null;
  if (!input.parentRunId)
    throw new Error(
      "Retirement successor receipt requires its predecessor Run.",
    );
  const query = client
    .select({ parent: run, receipt: researchRetention })
    .from(run)
    .innerJoin(
      researchRetention,
      and(
        eq(researchRetention.id, input.receiptId),
        eq(researchRetention.ledgerPartyId, run.ledgerPartyId),
      ),
    )
    .where(
      and(
        eq(run.id, input.parentRunId),
        eq(run.ledgerPartyId, input.ledgerPartyId),
        eq(run.actorUserId, input.actorUserId),
        eq(run.purpose, input.purpose),
        notDeleted(run),
      ),
    );
  const [scope] = await (lockPredecessor
    ? query.for("no key update", { of: run })
    : query);
  if (
    !scope ||
    !scope.parent.retiredAt ||
    scope.parent.retirementReason !== "unrelated_source" ||
    !scope.receipt.plan.retiredRunIds.includes(scope.parent.id) ||
    scope.receipt.phase !== "coordinators_destroyed"
  )
    throw new Error(
      "Retirement successor receipt is not authorized after coordinator disposal.",
    );
  if (
    scope.parent.status === "completed" ||
    scope.parent.failureCode === "user_cancelled" ||
    scope.parent.failureCode === "dispatch_aborted"
  )
    throw new Error(
      "Retirement cannot restart completed or cancelled research.",
    );
  const targets = await client
    .select({ entityId: runTarget.entityId, workKey: runTarget.workKey })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, scope.parent.id),
        eq(
          runTarget.entityKind,
          input.purpose === "product_enrichment"
            ? "product"
            : input.purpose === "purchase_validation"
              ? "purchase"
              : "run",
        ),
        inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
      ),
    );
  const keys = new Set(
    targets.map((target) =>
      input.purpose === "product_enrichment" ||
      input.purpose === "purchase_validation"
        ? target.entityId
        : target.workKey,
    ),
  );
  if (
    input.taskKeys.some(
      (key) => !keys.has(key) || key === scope.receipt.orderMailId,
    )
  )
    throw new Error(
      "Retirement successor may contain only the predecessor's unfinished supported work.",
    );
  return {
    // A source receipt authorizes the transfer; its identity must not create a
    // second continuation or bypass a cancelled successor for the same Run.
    clientKey: `${input.purpose}:retention:${scope.parent.id}`,
    attempt: scope.parent.attempt === null ? null : scope.parent.attempt + 1,
    predecessorRunId: scope.parent.id,
    parentRunId: scope.parent.parentRunId,
    predecessor: scope.parent,
  };
}

/** Validate receipt authority before existing-child replay; fresh work rechecks under source-first locks. */
export function authorizeResearchRetirement(
  client: Parameters<typeof retirementAdmission>[0],
  input: Parameters<typeof retirementAdmission>[1],
) {
  return retirementAdmission(client, input, false);
}

export function researchRetirementAdmission(
  client: Parameters<typeof retirementAdmission>[0],
  input: Parameters<typeof retirementAdmission>[1],
) {
  return retirementAdmission(client, input, true);
}

export async function readResearchRetirementSuccessor(
  client: DrizzleClient | DrizzleTransaction,
  admission: Awaited<ReturnType<typeof researchRetirementAdmission>>,
) {
  if (!admission) return;
  return readResearchPredecessorSuccessor(client, admission.predecessor);
}
