import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
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

export const prepareConnectionDiscoveryPage = (
  db: Database,
  input: Parameters<typeof prepareConnectionDiscoveryRoster>[1],
) =>
  withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    return prepareConnectionDiscoveryRoster(tx, input);
  });
