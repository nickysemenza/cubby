/**
 * Coordinator disposal for settled agent Runs. A Mail import transcript holds
 * the Email text the agent read, so it is destroyed once its Run settles;
 * `Run.retiredAt` records that the coordinator can never execute again.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

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
 * Destroy the coordinators of agent Runs that settled before `before`, oldest
 * first, a bounded batch per call (one catch-up makes at most two coordinator
 * RPCs per Run). A destroying call reports `disposed: false` (SDK destroy may
 * even abort it); an immediate follow-up reaches a fresh instance whose empty
 * inventory acknowledges disposal, which stamps `retiredAt`. Any Run with an
 * agent session qualifies, including retired purposes (account_sync,
 * product_enrichment, ...), addressed by the identity stored at creation. A
 * failing coordinator does not stall the Runs behind it; failures are thrown
 * after the batch.
 */
export async function retireSettledCoordinators(
  db: Database,
  coordinator: (agentId: string) => Pick<PurchaseImportRunAgentRpc, "retire">,
  before: Date,
  limit = 200,
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
    .orderBy(asc(runTable.updatedAt), asc(runTable.id))
    .limit(limit);
  let retired = 0;
  const failures: string[] = [];
  for (const { id, agentId } of rows) {
    if (!agentId) continue;
    const retire = async () => (await coordinator(agentId).retire()).disposed;
    try {
      // A real failure repeats on the follow-up, which reports it.
      if (!((await retire().catch(() => false)) || (await retire()))) continue;
      await getDb(db)
        .update(runTable)
        .set({ retiredAt: new Date(), retirementReason: "settled" })
        .where(eq(runTable.id, id));
      retired += 1;
    } catch (error) {
      failures.push(`${id}: ${String(error)}`);
    }
  }
  if (failures.length)
    throw new Error(
      `Coordinator retirement failed for ${failures.length} of ${rows.length} Runs (${retired} retired): ${failures.join("; ")}`,
    );
  return { considered: rows.length, retired };
}
