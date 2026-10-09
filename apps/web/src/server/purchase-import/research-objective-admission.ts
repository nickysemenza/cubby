import {
  parseEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { importHunt, ledgerParty, run, runTarget } from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { dispatchRunEvent, researchDispatchPending } from "./dispatch";
import { assertResearchTaskAdmission } from "./research-execution";
import {
  admitResearchObjectiveTargets,
  researchObjectiveKey,
  researchObjectivesOf,
} from "./research-objective";
import { assertReceiptObjectiveOriginal } from "./research-objective-context";
import { eligibleObjectiveContinuation } from "./research-objective-eligibility";
import {
  lockObjectiveAccounts,
  lockObjectiveHunts,
} from "./research-objective-source-locks";
import {
  authorizeResearchRetirement,
  readResearchRetirementSuccessor,
  researchRetirementAdmission,
} from "./research-retention-admission";

/** A disposal receipt carries frozen unfinished objectives without recapturing live hints. */
export async function startRetiredObjectiveResearch(
  db: Database,
  input: Pick<
    Parameters<typeof researchRetirementAdmission>[1],
    "ledgerPartyId" | "actorUserId"
  > & { predecessorRunId: RunId; receiptId: string },
  queue: PurchaseAgentQueueProducer,
) {
  const admitted = await withTransaction(db, async (tx) => {
    const [member] = await tx
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.id, input.ledgerPartyId),
          eq(ledgerParty.userId, input.actorUserId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .for("share");
    if (!member) throw new Error("Objective successor member is unavailable.");
    const [scope] = await tx
      .select()
      .from(run)
      .where(
        and(
          eq(run.id, input.predecessorRunId),
          eq(run.ledgerPartyId, input.ledgerPartyId),
          eq(run.actorUserId, input.actorUserId),
          notDeleted(run),
        ),
      );
    if (!scope) throw new Error("Objective predecessor is unavailable.");
    const purpose = agentImportRunPurpose.parse(scope.purpose);
    if (purpose === "photo_inventory")
      throw new Error(
        "Photo inventory has no research objective continuation.",
      );
    const frozen = researchObjectivesRunInput.parse(scope.input);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`research-continuation:${scope.id}`}))`,
    );
    const targets = await tx
      .select({ workKey: runTarget.workKey, state: runTarget.state })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.id),
          eq(runTarget.entityKind, "run"),
          eq(runTarget.entityId, scope.id),
          inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
        ),
      );
    const authorityInput = {
      ...input,
      parentRunId: scope.id,
      purpose,
      taskKeys: targets
        .map((target) => target.workKey!)
        .filter((key) =>
          frozen.objectives.some(
            (objective) => researchObjectiveKey(objective) === key,
          ),
        ),
    };
    const authority = await authorizeResearchRetirement(tx, authorityInput);
    if (!authority) throw new Error("Objective continuation receipt missing.");
    const existing = await readResearchRetirementSuccessor(tx, authority);
    if (existing) return existing;
    await lockObjectiveAccounts(tx, scope, frozen);
    const hunts = await lockObjectiveHunts(tx, scope, frozen);
    const raced = await readResearchRetirementSuccessor(tx, authority);
    if (raced) return raced;
    const admission = await researchRetirementAdmission(tx, authorityInput);
    if (!admission) throw new Error("Objective continuation receipt missing.");
    const predecessor = admission.predecessor;
    if (
      predecessor.vendorAccountId !== scope.vendorAccountId ||
      JSON.stringify(predecessor.input) !== JSON.stringify(scope.input)
    )
      throw new Error("Objective predecessor changed during source admission.");
    await assertResearchTaskAdmission(
      databaseForTransaction(tx),
      predecessor.id,
    );
    const eligible = eligibleObjectiveContinuation(frozen, hunts, targets);
    if (!eligible.length) return null;
    const objectives = researchObjectivesRunInput.parse({
      ...frozen,
      objectives: eligible,
    });
    const id = runEntityId.parse(crypto.randomUUID());
    const successor = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: input.ledgerPartyId,
      actorUserId: input.actorUserId,
      actorName: predecessor.actorName,
      actorEmail: predecessor.actorEmail,
      actorLedgerPartyShortcode: predecessor.actorLedgerPartyShortcode,
      actorLedgerPartyName: predecessor.actorLedgerPartyName,
      actorLedgerPartyKind: predecessor.actorLedgerPartyKind,
      vendorAccountId: predecessor.vendorAccountId,
      vendorId: predecessor.vendorId,
      purpose,
      trigger: predecessor.trigger,
      input: objectives,
      clientKey: admission.clientKey,
      parentRunId: admission.parentRunId,
      predecessorRunId: admission.predecessorRunId,
      cause: "retry",
      attempt: admission.attempt,
      coordinatorModel: coordinatorModelFor(purpose),
      skillRevision: predecessor.skillRevision,
      runtimeRevision: predecessor.runtimeRevision,
      decisionRevision: predecessor.decisionRevision + 1,
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, purpose),
    });
    await admitResearchObjectiveTargets(tx, { runId: id, objectives });
    await transferReceiptResearchObjectives(tx, {
      predecessorRunId: predecessor.id,
      successorRunId: id,
    });
    return successor;
  });
  if (!admitted) return null;
  if (researchDispatchPending(admitted)) {
    if (!admitted.dispatchEventId)
      throw new Error("Objective successor dispatch identity missing.");
    await dispatchRunEvent(db, queue, {
      version: 1,
      type: "start_or_resume",
      runId: admitted.id,
      purpose: agentImportRunPurpose.parse(admitted.purpose),
      eventId: admitted.dispatchEventId,
    });
  }
  const [current] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, admitted.id));
  if (!current) throw new Error("Objective successor disappeared.");
  return current;
}

async function assertReceiptRunOwners(
  tx: DrizzleTransaction,
  predecessor: typeof run.$inferSelect | undefined,
  successor: typeof run.$inferSelect | undefined,
) {
  if (
    !predecessor ||
    !successor ||
    successor.predecessorRunId !== predecessor.id ||
    !predecessor.ledgerPartyId ||
    successor.ledgerPartyId !== predecessor.ledgerPartyId ||
    !predecessor.actorUserId ||
    successor.actorUserId !== predecessor.actorUserId ||
    successor.retiredAt
  )
    throw new Error("Receipt successor Run ownership changed.");
  const [member] = await tx
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, predecessor.ledgerPartyId),
        eq(ledgerParty.userId, predecessor.actorUserId),
        notDeleted(ledgerParty),
      ),
    )
    .for("share");
  if (!member)
    throw new Error("Receipt successor member ownership is unavailable.");
  return { predecessor, successor };
}

/** Admission moves only carried unfinished work; its retained original stays immutable. */
export async function transferReceiptResearchObjectives(
  tx: DrizzleTransaction,
  input: { predecessorRunId: string; successorRunId: string },
) {
  const rows = await tx
    .select()
    .from(run)
    .where(
      and(
        inArray(run.id, [
          runEntityId.parse(input.predecessorRunId),
          runEntityId.parse(input.successorRunId),
        ]),
        notDeleted(run),
      ),
    )
    .for("no key update");
  const nextRun = rows.find((row) => row.id === input.successorRunId);
  const carried =
    researchObjectivesOf(nextRun?.input)?.objectives.filter(
      (objective) => objective.kind === "receipt_hunt",
    ) ?? [];
  if (!carried.length) return;
  const { predecessor, successor } = await assertReceiptRunOwners(
    tx,
    rows.find((row) => row.id === input.predecessorRunId),
    nextRun,
  );
  const previous = researchObjectivesOf(predecessor.input);
  const next = researchObjectivesOf(successor.input)!;
  const targets = await tx
    .select()
    .from(runTarget)
    .where(inArray(runTarget.runId, [predecessor.id, successor.id]))
    .for("update");
  for (const objective of carried) {
    const workKey = researchObjectiveKey(objective);
    const originalObjective = previous?.objectives.find(
      (value) => researchObjectiveKey(value) === workKey,
    );
    const originalTarget = targets.find(
      (target) => target.runId === predecessor.id && target.workKey === workKey,
    );
    const nextTarget = targets.find(
      (target) => target.runId === successor.id && target.workKey === workKey,
    );
    if (
      JSON.stringify(originalObjective) !== JSON.stringify(objective) ||
      !originalTarget ||
      !nextTarget ||
      ![
        "pending",
        "prepared",
        "unresolved",
        "needs_evidence",
        "unavailable",
      ].includes(originalTarget.state) ||
      nextTarget.state !== "pending" ||
      originalTarget.entityKind !== "run" ||
      originalTarget.entityId !== predecessor.id ||
      nextTarget.entityKind !== "run" ||
      nextTarget.entityId !== successor.id ||
      originalTarget.targetFingerprint !==
        (await sha256Hex(
          JSON.stringify([previous!.instructionRevision, objective]),
        )) ||
      nextTarget.targetFingerprint !==
        (await sha256Hex(JSON.stringify([next.instructionRevision, objective])))
    )
      throw new Error(
        "Receipt successor may carry only exact unfinished objectives.",
      );
    const { hunt } = await assertReceiptObjectiveOriginal(
      databaseForTransaction(tx),
      predecessor,
      objective,
    );
    const moved = await tx
      .update(importHunt)
      .set({
        receiptRunId: successor.id,
        state: "processing_receipt",
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importHunt.id, hunt.id),
          eq(importHunt.receiptRunId, predecessor.id),
          eq(
            importHunt.receiptImageId,
            parseEntityId("image", objective.imageId),
          ),
        ),
      )
      .returning({ id: importHunt.id });
    if (moved.length !== 1)
      throw new Error(
        "Receipt original ownership changed during successor admission.",
      );
  }
}
