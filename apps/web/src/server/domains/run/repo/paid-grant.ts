import type { ActorContext } from "@cubby/schemas/context";
import { ledgerPartyId, userId, type RunId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, run, runControlEvent, user } from "~/server/db/schema";

/**
 * Records a member's "Run now, paid allowed" on a Run that has no agent scope
 * (Mail discovery); agent Runs record it through `controlRun`.
 */
export async function recordPaidGrant(
  db: Database,
  actor: ActorContext,
  input: { runId: RunId; paidOverBudgetUsd?: number },
) {
  const [controller] = await getDb(db)
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      ledgerPartyId: ledgerParty.id,
      ledgerPartyShortcode: ledgerParty.shortcode,
      ledgerPartyName: ledgerParty.name,
      ledgerPartyKind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!controller)
    throw new Error("Only a household member can allow paid AI for a Run.");
  await getDb(db)
    .insert(runControlEvent)
    .values({
      runId: input.runId,
      action: "run_now_paid",
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: ledgerPartyId.parse(controller.ledgerPartyId),
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
      paidOverBudgetUsd: input.paidOverBudgetUsd ?? null,
    });
}

// Retry chains are short; the bound only stops a corrupted cycle.
const MAX_LINEAGE = 50;

/**
 * A member's latest "Run now, paid allowed" for this Run, the retries it
 * succeeds, or the discovery Run that started any of them, with the
 * confirmed spend past the paid budget. A retry inherits its predecessor's
 * background status (`isBackgroundRun`), so it inherits the grant too.
 */
export async function readPaidGrant(db: Database, runId: RunId) {
  const scope = new Set<RunId>();
  let current: RunId | null = runId;
  for (let depth = 0; current && depth < MAX_LINEAGE; depth++) {
    if (scope.has(current)) break;
    scope.add(current);
    const [row] = await getDb(db)
      .select({
        parentRunId: run.parentRunId,
        predecessorRunId: run.predecessorRunId,
      })
      .from(run)
      .where(eq(run.id, current))
      .limit(1);
    if (row?.parentRunId) scope.add(row.parentRunId);
    current = row?.predecessorRunId ?? null;
  }
  const [grant] = await getDb(db)
    .select({
      createdAt: runControlEvent.createdAt,
      paidOverBudgetUsd: runControlEvent.paidOverBudgetUsd,
    })
    .from(runControlEvent)
    .where(
      and(
        eq(runControlEvent.action, "run_now_paid"),
        inArray(runControlEvent.runId, [...scope]),
      ),
    )
    .orderBy(desc(runControlEvent.createdAt))
    .limit(1);
  return grant ?? null;
}
