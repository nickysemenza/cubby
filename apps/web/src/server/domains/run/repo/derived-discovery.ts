import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { assertCurrentJob } from "~/server/generic/jobs/repo/execution";
import { repeatJob } from "~/server/generic/jobs/repo/jobs";

import { prepareConnectionDiscoveryRoster } from "./connection-refresh";

/** A completed bounded pass repeats; failures and member controls stay terminal. */
export const claimDerivedDiscovery = (db: Database) =>
  repeatJob(
    db,
    {
      key: "discovery:connections",
      kind: "discovery.connections",
      input: {},
    },
    2 * 60_000,
  );

/** Whether a member cancelled one of the pass's Runs. */
export async function memberStoppedDiscovery(
  db: Database,
  runIds: readonly RunId[],
) {
  if (!runIds.length) return false;
  const [stopped] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(inArray(run.id, [...runIds]), eq(run.failureCode, "user_cancelled")),
    )
    .limit(1);
  return stopped !== undefined;
}

export const prepareConnectionDiscoveryPage = (
  db: Database,
  input: Parameters<typeof prepareConnectionDiscoveryRoster>[1],
) =>
  withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    return prepareConnectionDiscoveryRoster(tx, input);
  });
