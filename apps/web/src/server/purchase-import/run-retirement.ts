/**
 * Coordinator disposal for settled agent Runs. A Mail import transcript holds
 * the Email text the agent read, so it is destroyed once its Run settles;
 * `Run.retiredAt` records that the coordinator can never execute again.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";

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

/** Only a settled Run's coordinator may be destroyed. */
export async function assertRetirableRun(db: Database, runId: string) {
  const [row] = await getDb(db)
    .select({ status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (!row || !TERMINAL.some((status) => status === row.status))
    throw new Error("Only a settled Run's coordinator can be retired.");
}

/**
 * Destroy the coordinators of agent Runs that settled before `before`, a
 * bounded batch per call; a destroyed coordinator reports `disposed` on a
 * later cold call, which then stamps `retiredAt`.
 */
export async function retireSettledCoordinators(
  db: Database,
  coordinator: (agentId: string) => Pick<PurchaseImportRunAgentRpc, "retire">,
  before: Date,
  limit = 25,
) {
  const rows = await getDb(db)
    .select({ id: runTable.id, purpose: runTable.purpose })
    .from(runTable)
    .where(
      and(
        inArray(runTable.purpose, agentImportRunPurpose.options),
        inArray(runTable.status, [...TERMINAL]),
        isNull(runTable.retiredAt),
        lt(runTable.updatedAt, before),
      ),
    )
    .limit(limit);
  let retired = 0;
  for (const row of rows) {
    const purpose = agentImportRunPurpose.parse(row.purpose);
    const { disposed } = await coordinator(
      importRunAgentIdentity(row.id, purpose),
    ).retire();
    if (!disposed) continue;
    await getDb(db)
      .update(runTable)
      .set({ retiredAt: new Date(), retirementReason: "settled" })
      .where(eq(runTable.id, row.id));
    retired += 1;
  }
  return { considered: rows.length, retired };
}
