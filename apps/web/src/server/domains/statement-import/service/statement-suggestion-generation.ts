import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";

/**
 * Generate suggestions for one import's charges as a routine Sweep for the
 * member who recorded them. A whole-ledger pass is a member's Find suggestions.
 */
export async function scheduleStatementSuggestions(
  db: Database,
  importId: string,
  actor: ActorContext,
): Promise<void> {
  const { startSweep } = await import("~/server/domains/run/service/sweep");
  await startSweep(
    db,
    { ...actor, runId: null },
    {
      trigger: "scheduled",
      families: [{ family: "statement_transaction", scope: { importId } }],
    },
  );
}

/**
 * Generation and labelling run as a Sweep's statement step. A message queued
 * by the retired queue chain before deploy is acknowledged without work.
 * TODO(#2749): drop the two task kinds after one deploy.
 */
export async function retiredStatementSuggestionTask() {
  return "skipped" as const;
}
