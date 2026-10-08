import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  researchObjectivesRunInput,
  type ResearchObjectivesRunInput,
} from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { importHunt, ledgerParty, run, runTarget } from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadPriorReceiptObjective } from "./receipt-evidence";
import {
  readResearchPredecessorSuccessor,
  researchContinuationTargets,
  type ResearchContinuation,
} from "./research-continuation-admission";
import { assertResearchRunExecutable } from "./research-execution";
import {
  convertHistoricalObjectives,
  isHistoricalObjectiveInput,
} from "./research-legacy-objective";
import {
  admitResearchObjectiveTargets,
  OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
  researchObjectivesOf,
} from "./research-objective";
import { transferReceiptResearchObjectives } from "./research-objective-admission";
import { eligibleObjectiveContinuation } from "./research-objective-eligibility";
import {
  lockObjectiveAccounts,
  lockObjectiveHunts,
} from "./research-objective-source-locks";

async function continuedObjectives(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  frozen: ResearchObjectivesRunInput | null,
  hunts: Awaited<ReturnType<typeof lockObjectiveHunts>>,
  action: ResearchContinuation["action"],
) {
  let objectives: ResearchObjectivesRunInput;
  if (frozen) {
    await assertResearchRunExecutable(databaseForTransaction(tx), scope.id);
    const targets = await tx
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, scope.id))
      .for("update");
    objectives = researchObjectivesRunInput.parse({
      ...frozen,
      objectives: eligibleObjectiveContinuation(
        frozen,
        hunts,
        researchContinuationTargets(scope, targets, action),
      ),
    });
  } else if (isHistoricalObjectiveInput(scope.input)) {
    objectives = await convertHistoricalObjectives(tx, scope, hunts);
  } else {
    if (!hunts.length && scope.vendorAccountId)
      throw new Error(
        "Historical account starting boundary was not retained; start a fresh account sync.",
      );
    const derived = [];
    for (const found of hunts) {
      if (
        found.settled ||
        found.held ||
        ![
          "receipt_failed",
          "processing_receipt",
          "deferred_for_review",
        ].includes(found.hunt.state)
      )
        continue;
      const prior = await loadPriorReceiptObjective(tx, found.hunt);
      if (!prior.legacy || prior.predecessor.id !== scope.id)
        throw new Error(
          "Legacy receipt no longer belongs to its original Run.",
        );
      derived.push(prior.original);
    }
    objectives = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
      objectives: derived,
    });
  }
  return objectives;
}

async function transferLegacyReceiptOwnership(
  tx: DrizzleTransaction,
  predecessor: typeof run.$inferSelect,
  successor: typeof run.$inferSelect,
  objectives: ResearchObjectivesRunInput,
) {
  for (const objective of objectives.objectives) {
    if (objective.kind !== "receipt_hunt")
      throw new Error("Legacy continuation has no retained receipt.");
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
          eq(importHunt.id, objective.huntId),
          eq(importHunt.receiptRunId, predecessor.id),
          eq(
            importHunt.receiptImageId,
            parseEntityId("image", objective.imageId),
          ),
        ),
      )
      .returning({ id: importHunt.id });
    if (moved.length !== 1)
      throw new Error("Legacy receipt ownership changed during admission.");
  }
}

/** Sources precede Run/target locks; a legacy receipt is derived only from its exact retained owner. */
export async function continueObjectiveResearchRun(
  db: Database,
  actor: ActorContext,
  continuation: ResearchContinuation,
) {
  return withTransaction(db, async (tx) => {
    const [initial] = await tx
      .select({ scope: run })
      .from(run)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, run.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(run.id, continuation.predecessorRunId),
          eq(run.actorUserId, actor.userId),
          eq(run.purpose, "account_sync"),
          notDeleted(run),
        ),
      )
      .for("share", { of: ledgerParty });
    if (!initial)
      throw new Error("Objective continuation requires the owning member.");
    const scope = initial.scope;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`research-continuation:${scope.id}`}))`,
    );
    const existing = await readResearchPredecessorSuccessor(tx, scope);
    if (existing) return { row: existing, created: false };
    const frozen = researchObjectivesOf(scope.input);
    if (
      !frozen &&
      scope.input !== null &&
      !isHistoricalObjectiveInput(scope.input)
    )
      throw new Error(
        "Legacy objective scope requires an evidence-backed conversion.",
      );
    await lockObjectiveAccounts(tx, scope, frozen);
    const hunts = await lockObjectiveHunts(tx, scope, frozen);
    const raced = await readResearchPredecessorSuccessor(tx, scope);
    if (raced) return { row: raced, created: false };
    const [locked] = await tx
      .select()
      .from(run)
      .where(eq(run.id, scope.id))
      .for("no key update");
    if (
      !locked ||
      locked.retiredAt ||
      locked.actorUserId !== actor.userId ||
      locked.ledgerPartyId !== scope.ledgerPartyId ||
      locked.vendorAccountId !== scope.vendorAccountId ||
      JSON.stringify(locked.input) !== JSON.stringify(scope.input)
    )
      throw new Error("Objective predecessor changed or is retired.");
    const terminal =
      continuation.action === "restart"
        ? ["completed", "failed", "needs_review", "dispatch_failed"]
        : ["completed", "failed", "needs_review"];
    if (!terminal.includes(locked.status))
      throw new Error(
        `Objective continuation requires a terminal predecessor (${locked.status}).`,
      );
    const objectives = await continuedObjectives(
      tx,
      locked,
      frozen,
      hunts,
      continuation.action,
    );
    const id = runEntityId.parse(crypto.randomUUID());
    const successor = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: locked.ledgerPartyId,
      actorUserId: locked.actorUserId,
      actorName: locked.actorName,
      actorEmail: locked.actorEmail,
      actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
      actorLedgerPartyName: locked.actorLedgerPartyName,
      actorLedgerPartyKind: locked.actorLedgerPartyKind,
      vendorAccountId: locked.vendorAccountId,
      vendorId: locked.vendorId,
      purpose: "account_sync",
      trigger: locked.trigger,
      notes: locked.notes,
      input: objectives,
      predecessorRunId: locked.id,
      parentRunId: locked.parentRunId,
      cause: "retry",
      attempt: locked.attempt === null ? null : locked.attempt + 1,
      clientKey: `research-continuation:${locked.id}`,
      coordinatorModel: coordinatorModelFor("account_sync"),
      skillRevision: locked.skillRevision,
      runtimeRevision: locked.runtimeRevision,
      decisionRevision: locked.decisionRevision + 1,
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, "account_sync"),
    });
    await admitResearchObjectiveTargets(tx, { runId: id, objectives });
    if (frozen)
      await transferReceiptResearchObjectives(tx, {
        predecessorRunId: locked.id,
        successorRunId: id,
      });
    else if (
      objectives.objectives.some(
        (objective) => objective.kind === "receipt_hunt",
      )
    )
      await transferLegacyReceiptOwnership(tx, locked, successor, objectives);
    return { row: successor, created: true };
  });
}
