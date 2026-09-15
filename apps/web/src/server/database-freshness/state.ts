import { HYPERDRIVE_CACHE_POLICY } from "~/lib/hyperdrive-cache-policy";

export interface DatabaseFreshness {
  lastWriteAt: number;
  strongUntil: number;
}

export const databaseFreshness = (lastWriteAt: number): DatabaseFreshness => ({
  lastWriteAt,
  strongUntil: lastWriteAt + HYPERDRIVE_CACHE_POLICY.freshReadSeconds * 1000,
});
