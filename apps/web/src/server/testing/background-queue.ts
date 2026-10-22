import {
  backgroundTaskMessageSchema,
  type BackgroundTaskMessage,
} from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray } from "drizzle-orm";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { scheduleRefreshFamilies } from "~/server/generic/derived-refresh/repo/families";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import {
  refreshFamilyHandler,
  createProductionRefreshFamilyHandler,
} from "~/server/workflows/background-tasks/refresh-families";

const searchDrains = new WeakMap<Database, Promise<void>>();

/** Fixture seeding and the offline E2E pump share one real Job drain per handle. */
export function drainDerivedRefreshFrontier(
  db: Database,
  maxPages = 10_000,
): Promise<void> {
  const existing = searchDrains.get(db);
  if (existing) return existing;
  const pending = drainSearchJobs(db, maxPages).finally(() =>
    searchDrains.delete(db),
  );
  searchDrains.set(db, pending);
  return pending;
}

async function drainSearchJobs(db: Database, maxPages: number): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (let page = 0; page < maxPages; page++) {
    const [pending] = await getDb(db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:search"));
    if (!pending || pending.state === "completed") return;
    if (["failed", "cancelled", "paused"].includes(pending.state))
      throw new Error(
        `Synthetic search refresh stopped: ${pending.error ?? pending.state}`,
      );
    // Explicit fixture settlement does not wait for the scheduler's backoff clock.
    await getDb(db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, pending.id));
    const outcome = await advanceJob(db, pending.id, {
      "refresh.family": refreshFamilyHandler,
    });
    if (outcome === "failed")
      throw new Error(
        "Synthetic search publication failed; inspect its retained Job.error",
      );
    if (outcome === "skipped") {
      // Another runtime can already own the same durable Job; wait for its fenced publication.
      if (performance.now() >= deadline)
        throw new Error(
          `Synthetic search Job did not settle: ${pending.state}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Synthetic search refresh exceeded ${maxPages} pages`);
}

/** Settle only recipe intent using real Job ownership and an optional USDA fixture seam. */
export async function drainRecipeRefreshJobs(
  db: Database,
  costing?: import("~/server/domains/recipe/repo/recipe-costing").RecipeCostingService,
  maxPages = 10_000,
): Promise<void> {
  const handler = costing
    ? createProductionRefreshFamilyHandler({
        prepareRecipe: (tx, id) => costing.bindTo(tx).prepareRefresh(id),
      })
    : refreshFamilyHandler;
  for (let page = 0; page < maxPages; page++) {
    const [pending] = await getDb(db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:recipes"));
    if (!pending || pending.state === "completed") return;
    if (["failed", "cancelled", "paused"].includes(pending.state))
      throw new Error(
        `Synthetic recipe refresh stopped: ${pending.error ?? pending.state}`,
      );
    const outcome = await advanceJob(db, pending.id, {
      "refresh.family": handler,
    });
    if (outcome === "failed" || outcome === "skipped") {
      const [settled] = await getDb(db)
        .select()
        .from(job)
        .where(eq(job.id, pending.id));
      throw new Error(
        `Synthetic recipe refresh ${outcome}: ${settled?.error ?? settled?.state}`,
      );
    }
  }
  throw new Error(`Synthetic recipe refresh exceeded ${maxPages} pages`);
}

/** Exercise broad raw-SQL catch-up without manufacturing old frontier rows. */
export async function reconcileDerivedRefreshInputs(
  db: Database,
): Promise<void> {
  await scheduleRefreshFamilies(db, { invalidate: true });
  await drainDerivedRefreshFrontier(db);
}

/** A lost wake does not hide intent: drain committed Jobs, not captured messages. */
export function captureBackgroundQueue() {
  const messages: BackgroundTaskMessage[] = [];
  setCfEnv(
    fromPartial<Env>({
      BACKGROUND_QUEUE: {
        sendBatch: async (batch: Iterable<{ body: unknown }>) => {
          for (const { body } of batch)
            messages.push(backgroundTaskMessageSchema.parse(body));
        },
      },
    }),
  );
  return {
    messages,
    async drain(
      db: Database,
      options: { maxTasks?: number; handlers?: JobHandlers } = {},
    ): Promise<number> {
      const handlers =
        options.handlers ??
        (await import("~/server/workflows/jobs")).productionJobHandlers;
      const maxPages = options.maxTasks ?? 10_000;
      for (let page = 0; page < maxPages; page++) {
        const [pending] = await getDb(db)
          .select()
          .from(job)
          .where(
            and(
              inArray(job.kind, Object.keys(handlers)),
              inArray(job.state, ["queued", "retry_wait"]),
            ),
          )
          .orderBy(job.availableAt, job.id)
          .limit(1);
        if (!pending) {
          messages.length = 0;
          return page;
        }
        if (pending.availableAt > new Date())
          throw new Error(
            `Synthetic drain reached deferred Job ${pending.kind}`,
          );
        const outcome = await advanceJob(db, pending.id, handlers);
        if (outcome === "failed")
          throw new Error(
            `Synthetic Job ${pending.kind} failed; inspect retained Job.error`,
          );
      }
      throw new Error(`Background Job drain exceeded ${maxPages} pages`);
    },
    restore: () => setCfEnv(undefined),
  };
}

/** Domain regression seams execute under the same persisted Job ownership as a worker. */
export async function withJobFixtureExecution<T>(
  db: Database,
  input: import("@cubby/schemas/job").EnqueueJobInput,
  work: () => Promise<T>,
) {
  const { enqueueJob, externalJobClaim, claimJob } =
    await import("~/server/generic/jobs/repo/jobs");
  const saved = await enqueueJob(db, input);
  const claim =
    (await externalJobClaim(db, saved.key)) ?? (await claimJob(db, saved.id));
  if (!claim)
    throw new Error(`Synthetic execution ${saved.key} is ${saved.state}`);
  return (
    await import("~/server/generic/jobs/repo/execution")
  ).withJobExecution(db, claim, work);
}
