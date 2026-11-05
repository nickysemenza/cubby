import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import type {
  DrainClaim,
  DrainHandler,
  DrainStore,
} from "~/server/generic/jobs/service/drain";
import type { JobContext } from "~/server/generic/jobs/types";

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

const settledCounts = z
  .object({
    published: z.number().catch(0),
    failed: z.number().catch(0),
    covered: z.number().catch(0),
  })
  .catch({ published: 0, failed: 0, covered: 0 });

/**
 * One page of a `defineDrain` whose items are its domain's own rows, with no Job
 * claim: the store's `claim` must be exclusive, because a sibling invocation can run
 * beside this one, and its `lock` fences each item. Only a page that settled something
 * asks for another, so held rows cannot spin.
 */
export function storeDrain(input: {
  name: string;
  /** `release` ends this page's claim on rows it did not settle. */
  store: DrainStore & { release?(db: Database): Promise<void> };
  handler: DrainHandler;
}): BackgroundDrain {
  const claim: DrainClaim = {
    key: input.name,
    generation: 1,
    leaseToken: crypto.randomUUID(),
  };
  return {
    name: input.name,
    async page(db) {
      const context: JobContext = {
        signal: new AbortController().signal,
        fenced: (work) => repositoryTransactionDatabase(db, work),
        fence: async () => {},
        check: async () => {},
      };
      const { page, publish } = await input.handler
        .prepare(db, claim, context)
        .finally(() => input.store.release?.(db));
      if (publish) await repositoryTransactionDatabase(db, publish);
      return {
        more:
          Object.values(settledCounts.parse(page.result)).reduce(
            (sum, count) => sum + count,
            0,
          ) > 0,
        nextAt: page.availableAt ?? (await input.store.nextReadyAt(db)),
      };
    },
  };
}
