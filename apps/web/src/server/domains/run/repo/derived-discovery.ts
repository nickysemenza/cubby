import type { Database } from "~/server/db";
import { repeatJob } from "~/server/generic/jobs/repo/producer";
import type { Fenced } from "~/server/generic/jobs/types";

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
  fenced: Fenced,
  input: Parameters<typeof prepareConnectionDiscoveryRoster>[1],
) => fenced((tx) => prepareConnectionDiscoveryRoster(tx, input));
