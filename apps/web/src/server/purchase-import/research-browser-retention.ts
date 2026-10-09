import { runEntityId } from "@cubby/schemas/identifiers";
import { researchSourceMetadata } from "@cubby/schemas/research";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run, runEvidence, runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { browserCommandRecord } from "./browser-results";
import { authorizeResearchCoordinatorRetirement } from "./research-retention";

const commandAccount = browserCommandRecord
  .pick({ brokerAccountId: true })
  .loose();
const evidenceAccount = researchSourceMetadata
  .pick({ brokerAccountId: true })
  .loose();

/** Inventory transport before erasing disposable operation/evidence metadata. */
export async function researchBrowserAccountIds(
  db: Database,
  input: Parameters<typeof authorizeResearchCoordinatorRetirement>[1],
): Promise<string[]> {
  await authorizeResearchCoordinatorRetirement(db, input);
  const runId = runEntityId.parse(input.runId);
  // includes-deleted: retired historical accounts still own physical replay caches.
  const [scope] = await getDb(db)
    .select({ accountId: run.vendorAccountId })
    .from(run)
    .where(eq(run.id, runId));
  if (!scope) throw new Error("Retired Run transport identity unavailable.");
  const operations = await getDb(db)
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runId),
        eq(runOperation.kind, "browser_command"),
      ),
    );
  const evidence = await getDb(db)
    .select({ kind: runEvidence.kind, metadata: runEvidence.sourceMetadata })
    .from(runEvidence)
    .where(eq(runEvidence.runId, runId));
  const accounts = new Set<string>();
  if (scope.accountId) accounts.add(scope.accountId);
  for (const operation of operations) {
    const account =
      commandAccount.parse(operation.result ?? {}).brokerAccountId ??
      scope.accountId;
    if (!account)
      throw new Error(
        "Historical browser command transport identity unavailable; cleanup remains pending.",
      );
    accounts.add(account);
  }
  for (const source of evidence) {
    const account = evidenceAccount.parse(source.metadata).brokerAccountId;
    if (account) accounts.add(account);
    else if (source.kind === "browser_capture") {
      if (!scope.accountId)
        throw new Error(
          "Historical browser evidence transport identity unavailable; cleanup remains pending.",
        );
      accounts.add(scope.accountId);
    }
  }
  return [...accounts].sort();
}
