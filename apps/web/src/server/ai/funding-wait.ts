import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { askState, kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";

import {
  AiBudgetExhaustedError,
  assertAiBudget,
  paidFundingStopMessage,
  readAiBudget,
} from "~/server/ai/budget";
import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/** Admit paid work against its Run's confirmed allowance. */
export async function admitPaid(db: Database, call: { runId?: RunId }) {
  try {
    const allowance = call.runId
      ? ((await (
          await import("~/server/ai/funding")
        ).readPaidAllowance(db, call.runId)) ?? 0)
      : 0;
    await assertAiBudget(db, allowance);
  } catch (error) {
    if (call.runId && error instanceof AiBudgetExhaustedError)
      await (
        await import("~/server/domains/run/repo/execution-context")
      ).pauseForFunding(db, call.runId, error);
    throw error;
  }
}

/** Preserve the raw refusal and fence a stale Run report when given its generation. */
export async function stopForFunding(
  db: Database,
  runId: RunId | undefined,
  raw: string,
  generation?: string | null,
) {
  const status = await readAiBudget(db);
  const stop = new AiBudgetExhaustedError(
    status,
    paidFundingStopMessage(raw, status),
  );
  if (runId)
    await (
      await import("~/server/domains/run/repo/execution-context")
    ).pauseForFunding(db, runId, stop, generation);
  return stop;
}

/** A grant is durable before the recorded paid refusal is cleared. */
export async function grantPaid(
  db: Database,
  actor: ActorContext,
  runId: RunId,
  usd?: number,
) {
  await (
    await import("~/server/domains/run/repo/paid-grant")
  ).recordPaidGrant(db, actor, { runId, paidOverBudgetUsd: usd });
  await (
    await import("~/server/db/repository-access.boundary")
  ).repositoryAfterCommit(db, async () => {
    await (await import("~/server/ai/funding")).resetFundingRefusal("paid");
  });
}

type FundingWait = {
  name: "runs" | "images" | "jobs" | "kernel";
  count(db: Database, now: Date): Promise<number>;
  wake(db: Database, now: Date, anyWindow: boolean): Promise<number>;
};

/** A funding change counts and releases the same rows, in wake order. */
export const fundingWaiters: readonly FundingWait[] = [
  {
    name: "kernel",
    async count(db) {
      const result = await repositoryQueries(db).execute<{
        n: number;
      }>(sql`SELECT (
        (SELECT count(*) FROM "Ask" WHERE state = ${askState.enum.queued} AND "waitCause" = ${kernelWaitCause.enum.funding} AND "cancelledAt" IS NULL)
        + (SELECT count(*) FROM "Pass" WHERE "waitCause" = ${kernelWaitCause.enum.funding} AND "doneAt" IS NULL AND "cancelledAt" IS NULL)
      )::int AS n`);
      return result.rows[0]?.n ?? 0;
    },
    async wake(db, now) {
      return (await import("~/server/kernel/api")).releaseFundingWaits(db, now);
    },
  },
  {
    name: "runs",
    async count(db, now) {
      const [imports, discovery] = await Promise.all([
        import("~/server/domains/run/repo/run-control"),
        import("~/server/domains/run/repo/execution-context"),
      ]);
      const counts = await Promise.all([
        imports.countFundingStoppedImports(db, now),
        discovery.countFundingPausedDiscovery(db, now),
      ]);
      return counts[0] + counts[1];
    },
    async wake(db, now, anyWindow) {
      const imports = await import("~/server/domains/run/repo/run-control");
      const { aiBudgetWindow } = await import("~/server/ai/budget-window");
      let count = await imports.redispatchBudgetPausedImports(
        db,
        now,
        anyWindow ? now : aiBudgetWindow(now).start,
      );
      if (anyWindow)
        count += await (
          await import("~/server/domains/run/repo/execution-context")
        ).releaseFundingPausedDiscovery(db, now);
      return count;
    },
  },
  {
    name: "images",
    count: async (db) =>
      (
        await import("~/server/domains/image-processing/repo/image-processing-history")
      ).countFundingWaitingImageJobs(db),
    wake: async (db) =>
      (
        await import("~/server/domains/image-processing/repo/image-processing-history")
      ).wakeFundingWaitingImageJobs(db),
  },
  {
    name: "jobs",
    count: async (db, now) =>
      (
        await import("~/server/generic/jobs/repo/operator")
      ).countQueuedJobsToBringForward(db, now),
    wake: async (db, now) =>
      (
        await (
          await import("~/server/generic/jobs/repo/operator")
        ).bringQueuedJobsForward(db, now)
      ).length,
  },
];

export async function readFundingWaits(db: Database, now = new Date()) {
  const counts = await Promise.all(
    fundingWaiters.map(async (entry) => ({
      name: entry.name,
      count: await entry.count(db, now),
    })),
  );
  return counts.reduce(
    (total, item) =>
      item.name === "runs"
        ? { ...total, runs: total.runs + item.count }
        : { ...total, work: total.work + item.count },
    { runs: 0, work: 0 },
  );
}

export async function resumeFundingPausedRuns(
  db: Database,
  {
    now = new Date(),
    anyWindow = false,
  }: { now?: Date; anyWindow?: boolean } = {},
) {
  let woken = 0;
  for (const entry of fundingWaiters)
    if (anyWindow || entry.name === "runs")
      woken += await entry.wake(db, now, anyWindow);
  await (
    await import("~/server/workflows/background-tasks/publish")
  ).wakeJobs({ source: "funding-window" });
  return woken;
}
