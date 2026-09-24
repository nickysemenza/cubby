import { auditLogListOut, type AuditLogListOut } from "@cubby/schemas/audit";
import {
  dashboardLocalCounts,
  type DashboardLocalCounts,
} from "@cubby/schemas/dashboard";
import type { ProblemsCount } from "@cubby/schemas/problems";

import { getDatabaseFreshnessNamespace } from "~/server/cf-env";

import type { DatabaseFreshness } from "./state";

const DATABASE_FRESHNESS_RPC_TIMEOUT_MS = 1000;
export interface DatabaseFreshnessPort {
  readFreshness(): Promise<DatabaseFreshness>;
  recordWrite(): Promise<DatabaseFreshness>;
}

export interface ProblemCountsSnapshotPort {
  getProblemCounts(): Promise<ProblemsCount>;
}

export interface ReadSnapshotPort {
  getDashboardCounts(): Promise<DashboardLocalCounts | null>;
  getRecentAudit(): Promise<AuditLogListOut | null>;
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

export async function readProblemCountsFromDurableObject(
  port?: ProblemCountsSnapshotPort,
): Promise<ProblemsCount | null> {
  const target = port ?? getPort();
  if (!target) return null;
  try {
    // A cold snapshot runs the detector pass, so it must not inherit the
    // one-second latency bound used by the tiny freshness RPCs.
    return await target.getProblemCounts();
  } catch (error) {
    console.error("Problem-count snapshot RPC failed", error);
    throw error;
  }
}

export async function readDashboardCountsSnapshot(
  port?: Pick<ReadSnapshotPort, "getDashboardCounts">,
): Promise<DashboardLocalCounts | null> {
  const target = port ?? getPort();
  if (!target) return null;
  try {
    const snapshot = await target.getDashboardCounts();
    return snapshot ? dashboardLocalCounts.parse(snapshot) : null;
  } catch (error) {
    console.error("Dashboard-count snapshot unavailable", error);
    return null;
  }
}

export async function readRecentAuditSnapshot(
  port?: Pick<ReadSnapshotPort, "getRecentAudit">,
): Promise<AuditLogListOut | null> {
  const target = port ?? getPort();
  if (!target) return null;
  try {
    const snapshot = await target.getRecentAudit();
    return snapshot ? auditLogListOut.parse(snapshot) : null;
  } catch (error) {
    console.error("Recent-audit snapshot unavailable", error);
    return null;
  }
}
