import { HYPERDRIVE_CACHE_POLICY } from "~/lib/hyperdrive-cache-policy";

import type { DatabaseFreshness } from "./rpc";

export type { DatabaseFreshness, DatabaseFreshnessRpc } from "./rpc";

export const databaseFreshness = (lastWriteAt: number): DatabaseFreshness => ({
  lastWriteAt,
  strongUntil: lastWriteAt + HYPERDRIVE_CACHE_POLICY.freshReadSeconds * 1000,
});
