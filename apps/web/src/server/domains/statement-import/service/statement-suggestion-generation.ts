import type { Database } from "~/server/db";
import { systemActor } from "~/server/domains/run/repo/ensure-run";

/**
 * Generate suggestions for one import's charges as a routine Sweep, once the
 * caller's write commits. A whole-ledger pass is a member's Find suggestions.
 */
export async function scheduleStatementSuggestions(
  db: Database,
  importId: string,
): Promise<void> {
  const { startSweep } = await import("~/server/domains/run/service/sweep");
  await startSweep(db, systemActor(), {
    trigger: "scheduled",
    families: [{ family: "statement_transaction", scope: { importId } }],
  });
}

/**
 * Generation and labelling run as a Sweep's statement step. A message queued
 * by the retired queue chain before deploy is acknowledged without work.
 * TODO(#2749): drop the two task kinds after one deploy.
 */
export async function retiredStatementSuggestionTask() {
  return "skipped" as const;
}
