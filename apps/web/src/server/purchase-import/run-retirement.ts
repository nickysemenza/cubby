/**
 * Coordinator disposal for settled agent Runs. A Mail import transcript holds
 * the Email text the agent read, so it is destroyed once its Run settles;
 * `Run.retiredAt` records that the coordinator can never execute again.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import type { PurchaseImportRunAgentRpc } from "~/server/purchase-agent/environment";
import { getDb } from "~/server/repo/database-helpers";

const TERMINAL = ["completed", "failed", "needs_review", "cancelled"] as const;

export async function coordinatorRetired(db: Database, runId: string) {
  const [row] = await getDb(db)
    .select({ retiredAt: runTable.retiredAt })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  return !row || row.retiredAt !== null;
}

/**
 * Only a settled Run's coordinator may be destroyed. `current` is false for a
 * retired purpose, whose stored identity the current agent cannot open.
 */
export async function assertRetirableRun(db: Database, runId: string) {
  const [row] = await getDb(db)
    .select({ status: runTable.status, purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (!row || !TERMINAL.some((status) => status === row.status))
    throw new Error("Only a settled Run's coordinator can be retired.");
  return { current: agentImportRunPurpose.safeParse(row.purpose).success };
}

/**
 * Destroy the coordinators of agent Runs that settled before `before`, a
 * bounded batch per call; a destroyed coordinator reports `disposed` on a
 * later cold call, which then stamps `retiredAt`. Any Run with an agent
 * session qualifies, including retired purposes (account_sync,
 * product_enrichment, ...), addressed by the identity stored at creation.
 */
export async function retireSettledCoordinators(
  db: Database,
  coordinator: (agentId: string) => Pick<PurchaseImportRunAgentRpc, "retire">,
  before: Date,
  limit = 25,
) {
  const rows = await getDb(db)
    .select({ id: runTable.id, agentId: runTable.agentSessionId })
    .from(runTable)
    .where(
      and(
        isNotNull(runTable.agentSessionId),
        inArray(runTable.status, [...TERMINAL]),
        isNull(runTable.retiredAt),
        lt(runTable.updatedAt, before),
      ),
    )
    .limit(limit);
  let retired = 0;
  for (const row of rows) {
    if (!row.agentId) continue;
    const { disposed } = await coordinator(row.agentId).retire();
    if (!disposed) continue;
    await getDb(db)
      .update(runTable)
      .set({ retiredAt: new Date(), retirementReason: "settled" })
      .where(eq(runTable.id, row.id));
    retired += 1;
  }
  return { considered: rows.length, retired };
}
