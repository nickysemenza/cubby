import type { LedgerPartyId, RunId, UserId } from "@cubby/schemas/identifiers";
import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { and, eq } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { run, runTarget } from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";

import { assertResearchRunExecutable } from "./research-execution";
import {
  historicalMailSources,
  isHistoricalMailRun,
} from "./research-legacy-mail";

export type ResearchContinuation = {
  predecessorRunId: RunId;
  action: "retry" | "restart";
};

type Scope = {
  continuation?: ResearchContinuation;
  ledgerPartyId: LedgerPartyId;
  actorUserId: UserId;
  purpose: Exclude<AgentImportRunPurpose, "photo_inventory">;
};

const retryStates = new Set([
  "pending",
  "prepared",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);

export function researchContinuationTargets(
  scope: Pick<typeof run.$inferSelect, "purpose" | "input">,
  targets: (typeof runTarget.$inferSelect)[],
  action: ResearchContinuation["action"],
) {
  const legacyProduct =
    scope.purpose === "product_enrichment" && scope.input === null;
  const legacyPurchase =
    scope.purpose === "purchase_validation" && scope.input === null;
  if (
    (legacyProduct || legacyPurchase) &&
    (!targets.length ||
      targets.length > 50 ||
      targets.some(
        (target) =>
          target.entityKind !== (legacyPurchase ? "purchase" : "product") ||
          target.workKey !== "",
      ) ||
      new Set(targets.map((target) => target.entityId)).size !== targets.length)
  )
    throw new Error(
      legacyProduct
        ? "Legacy Product target scope is missing or differs from its saved entity roster."
        : "Legacy Purchase target scope is missing or differs from its saved entity roster.",
    );
  return targets.filter(
    (target) =>
      target.outcome !== "unrelated" &&
      (action === "restart" ||
        retryStates.has(target.state) ||
        ((legacyProduct || legacyPurchase) && target.state === "skipped")),
  );
}

/** Call under the owner's admission lock, before refreshing a frozen successor. */
export async function readResearchContinuationSuccessor(
  tx: DrizzleTransaction,
  input: Scope,
) {
  if (!input.continuation) return;
  const [predecessor] = await tx
    .select()
    .from(run)
    .where(
      and(
        eq(run.id, input.continuation.predecessorRunId),
        eq(run.ledgerPartyId, input.ledgerPartyId),
        eq(run.actorUserId, input.actorUserId),
        notDeleted(run),
      ),
    );
  if (!predecessor)
    throw new Error(
      "Research continuation requires the owning member and predecessor.",
    );
  if (continuationPurpose(predecessor) !== input.purpose)
    throw new Error("Research continuation predecessor purpose changed.");
  return readResearchPredecessorSuccessor(tx, predecessor);
}

function continuationPurpose(predecessor: typeof run.$inferSelect) {
  return isHistoricalMailRun(predecessor) ? "mail_import" : predecessor.purpose;
}

/** All admission causes consume the same predecessor; stopped children remain authoritative. */
export async function readResearchPredecessorSuccessor(
  client: DrizzleClient | DrizzleTransaction,
  predecessor: typeof run.$inferSelect,
) {
  // includes-deleted: removing a successor must not authorize a second attempt.
  const [existing] = await client
    .select()
    .from(run)
    .where(eq(run.predecessorRunId, predecessor.id));
  if (
    existing &&
    (existing.ledgerPartyId !== predecessor.ledgerPartyId ||
      existing.actorUserId !== predecessor.actorUserId ||
      existing.purpose !== continuationPurpose(predecessor))
  )
    throw new Error("Research continuation successor ownership changed.");
  return existing;
}

/** Owning admission establishes lock order; supplied lineage is never authority. */
export async function researchContinuationAdmission(
  tx: DrizzleTransaction,
  input: Scope & { taskKeys: readonly string[] },
) {
  if (!input.continuation) return null;
  const [predecessor] = await tx
    .select()
    .from(run)
    .where(
      and(
        eq(run.id, input.continuation.predecessorRunId),
        eq(run.ledgerPartyId, input.ledgerPartyId),
        eq(run.actorUserId, input.actorUserId),
        notDeleted(run),
      ),
    )
    .for("no key update");
  if (!predecessor || predecessor.retiredAt)
    throw new Error(
      "Research continuation predecessor is unavailable or retired.",
    );
  if (continuationPurpose(predecessor) !== input.purpose)
    throw new Error("Research continuation predecessor purpose changed.");
  const states =
    input.continuation.action === "restart"
      ? ["completed", "failed", "needs_review", "dispatch_failed"]
      : ["completed", "failed", "needs_review"];
  if (!states.includes(predecessor.status))
    throw new Error(
      `Research continuation requires a terminal predecessor (${predecessor.status}).`,
    );
  const historicalMail = isHistoricalMailRun(predecessor);
  if (
    !historicalMail &&
    !(
      ["product_enrichment", "purchase_validation"].includes(
        predecessor.purpose,
      ) && predecessor.input === null
    )
  )
    await assertResearchRunExecutable(
      databaseForTransaction(tx),
      predecessor.id,
    );
  const targets = await tx
    .select()
    .from(runTarget)
    .where(eq(runTarget.runId, predecessor.id));
  const selected = researchContinuationTargets(
    predecessor,
    targets,
    input.continuation.action,
  );
  const keys = new Set(
    historicalMail
      ? (await historicalMailSources(tx, predecessor)).selected.map(
          (source) => source.id,
        )
      : selected.map((target) =>
          ["product_enrichment", "purchase_validation"].includes(input.purpose)
            ? target.entityId
            : target.workKey,
        ),
  );
  if (
    !input.taskKeys.length ||
    new Set(input.taskKeys).size !== input.taskKeys.length ||
    keys.size !== input.taskKeys.length ||
    input.taskKeys.some((key) => !keys.has(key))
  )
    throw new Error(
      "Research continuation scope changed or has no eligible work.",
    );
  return {
    clientKey: `research-continuation:${predecessor.id}`,
    predecessorRunId: predecessor.id,
    parentRunId: predecessor.parentRunId,
    attempt: predecessor.attempt === null ? null : predecessor.attempt + 1,
    predecessor,
  };
}
