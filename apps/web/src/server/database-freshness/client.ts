import { getDatabaseFreshnessNamespace } from "~/server/cf-env";

import type { DatabaseFreshness } from "./state";

const DATABASE_FRESHNESS_RPC_TIMEOUT_MS = 1000;
export interface DatabaseFreshnessPort {
  readFreshness(): Promise<DatabaseFreshness>;
  recordWrite(): Promise<DatabaseFreshness>;
}

const getPort = () =>
  getDatabaseFreshnessNamespace()?.getByName("household", {
    locationHint: "wnam",
  });

async function boundedRpc<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database freshness RPC timed out")),
          DATABASE_FRESHNESS_RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readDatabaseFreshness(
  port?: DatabaseFreshnessPort,
): Promise<DatabaseFreshness | null> {
  try {
    const target = port ?? getPort();
    if (!target) return null;
    return await boundedRpc(() => target.readFreshness());
  } catch (error) {
    console.warn("Database freshness lookup failed; using strong reads", error);
    return null;
  }
}

export async function recordDatabaseWrite(
  source: string,
  port?: DatabaseFreshnessPort,
): Promise<void> {
  try {
    const target = port ?? getPort();
    if (!target) {
      console.warn("Database freshness notification unavailable", { source });
      return;
    }
    await boundedRpc(() => target.recordWrite());
  } catch (error) {
    console.warn("Database freshness notification failed", { source, error });
  }
}
