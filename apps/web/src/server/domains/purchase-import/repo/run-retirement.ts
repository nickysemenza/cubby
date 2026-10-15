/**
 * Coordinator disposal for settled agent Runs. A Mail import transcript holds
 * the Email text the agent read, so it is destroyed once its Run settles;
 * `Run.retiredAt` records that the coordinator can never execute again.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/db/helpers";
import { run as runTable, runFinding } from "~/server/db/schema";
import type { PurchaseImportRunAgentRpc } from "~/server/domains/purchase-agent/service/environment";

// includes-deleted: retirement closes obsolete execution alerts even on retained deleted Run identities.
/** Legacy coordinator alerts have exact machine-written summaries; source review stays open. */
export const obsoleteExecutionFindingSql = (findingAlias: string) =>
  sql.raw(`(
  ${findingAlias}."entityKind" = 'run'
  AND ${findingAlias}."entityId" = ${findingAlias}."runId"
  AND ${findingAlias}.kind = 'other'
  AND ${findingAlias}."proposedFix" IS NULL
  AND ${findingAlias}.summary IN ('No coordinator activity for two hours', 'Coordinator ended without finishing the run')
  /* includes-deleted: retired identity history still owns obsolete execution alerts. */
  AND EXISTS (SELECT 1 FROM "Run" retired WHERE retired.id = ${findingAlias}."runId" AND retired."retiredAt" IS NOT NULL)
)`);

async function closeRetiredExecutionFindings(db: Database) {
  const now = new Date();
  await getDb(db)
    .update(runFinding)
    .set({ status: "dismissed", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(runFinding.status, "open"),
        obsoleteExecutionFindingSql('"RunFinding"'),
      ),
    );
}

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
 * Retirement-only authority for a coordinator name that is not an import Run
 * identity: legacy account_sync Runs stored a bare session UUID as
 * `agentSessionId`. Exactly one settled Run of a retired purpose must store
 * that exact name; execution never resolves such names.
 */
export async function assertRetirableLegacySession(
  db: Database,
  agentSessionId: string,
) {
  const rows = await getDb(db)
    .select({ status: runTable.status, purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.agentSessionId, agentSessionId))
    .limit(2);
  const [row] = rows;
  if (
    rows.length !== 1 ||
    !row ||
    !TERMINAL.some((status) => status === row.status) ||
    agentImportRunPurpose.safeParse(row.purpose).success
  )
    throw new Error(
      "Only one settled Run storing this coordinator name can retire it.",
    );
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
  await closeRetiredExecutionFindings(db);
  const rows = await getDb(db)
    .select({
      id: runTable.id,
      agentId: runTable.agentSessionId,
      status: runTable.status,
      // Text, not a Date: microsecond precision survives the round trip.
      observedAt: sql<string>`${runTable.updatedAt}::text`,
    })
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
  for (const { id, agentId, status, observedAt } of rows) {
    if (!agentId) continue;
    const retire = async () => (await coordinator(agentId).retire()).disposed;
    try {
      // A real failure repeats on the follow-up, which reports it.
      if (!((await retire().catch(() => false)) || (await retire()))) continue;
      // Reopened Runs must neither be stamped retired nor lose their findings.
      const stamped = await withTransaction(db, async (tx) => {
        const now = new Date();
        const [retiredRun] = await tx
          .update(runTable)
          .set({ retiredAt: now, retirementReason: "settled" })
          .where(
            and(
              eq(runTable.id, id),
              eq(runTable.status, status),
              sql`${runTable.updatedAt}::text = ${observedAt}`,
              isNull(runTable.retiredAt),
            ),
          )
          .returning({ id: runTable.id });
        if (!retiredRun) return false;
        await tx
          .update(runFinding)
          .set({ status: "dismissed", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(runFinding.runId, id),
              eq(runFinding.status, "open"),
              obsoleteExecutionFindingSql('"RunFinding"'),
            ),
          );
        return true;
      });
      if (stamped) retired += 1;
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
