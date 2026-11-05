import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db/database";

const log = createLogger("drains");

/** One round's wall budget for every drain; a drain with more wakes the next round. */
const DRAIN_ROUND_MS = 20_000;

type DrainPage = {
  /** Claimable work remains after real progress: wake another round now. */
  more: boolean;
  /** When the drain's next known work falls due, if later. */
  nextAt: Date | null;
};

/**
 * A registered function over the rows a domain already owes. It has no queue row
 * of its own: the rows are the durable state, so a lost wake loses nothing and
 * the hourly cron finds them again. Fan-out over records belongs here, never in
 * a row per record.
 */
export type BackgroundDrain = {
  name: string;
  page(db: Database, round: { deadline: number }): Promise<DrainPage>;
};

/**
 * One round: every drain runs its page, then at most one wake follows. An escaped
 * error still lets the other drains finish and rejects the round, so queue
 * delivery retries.
 */
export async function runDrains(
  db: Database,
  drains: readonly BackgroundDrain[],
  timeBudgetMs = DRAIN_ROUND_MS,
): Promise<void> {
  const deadline = Date.now() + timeBudgetMs;
  const settled = await Promise.allSettled(
    drains.map((drain) => drain.page(db, { deadline })),
  );
  const pages = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const { wakeAt, wakeJobs } =
    await import("~/server/workflows/background-tasks/publish");
  const next = pages
    .flatMap((page) => (page.nextAt ? [page.nextAt.getTime()] : []))
    .sort((a, b) => a - b)[0];
  if (pages.some((page) => page.more))
    await wakeJobs({ source: "drain-budget" });
  else if (next !== undefined)
    await wakeAt(new Date(next), { source: "drain-next-due" });
  const failures: unknown[] = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    log.error("drain page failed", {
      drain: drains[index]?.name,
      error: result.reason,
    });
    return [result.reason];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Drains failed");
}
