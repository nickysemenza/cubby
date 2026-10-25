import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  backgroundTaskMessageSchema,
  type BackgroundTaskMessage,
} from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import {
  type DerivedComputes,
  derivedSink,
} from "~/server/generic/derived/repo/compute";
import {
  claimDerivedMarks,
  markAllStoredDerived,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import { unobservedJobInvalidation } from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { derivedComputes } from "~/server/workflows/derived-computes";

const frontierDrains = new WeakMap<Database, Promise<void>>();

/** Fixture seeding and the offline E2E pump settle every derived mark per handle. */
export function drainDerivedRefreshFrontier(
  db: Database,
  maxPages = 1_000,
): Promise<void> {
  const existing = frontierDrains.get(db);
  if (existing) return existing;
  const pending = drainStoredDerived(db, maxPages).finally(() =>
    frontierDrains.delete(db),
  );
  frontierDrains.set(db, pending);
  return pending;
}

/** Drain every ready derived mark through the production compute adapters. */
export async function drainStoredDerived(
  db: Database,
  maxPages = 1_000,
  computes: DerivedComputes = derivedComputes,
): Promise<void> {
  for (let page = 0; page < maxPages; page++) {
    const marks = await claimDerivedMarks(db);
    if (marks.length === 0) return;
    const plan = await prepareDerivedPage(db, computes, marks);
    await publishDerivedPage(db, plan);
  }
  throw new Error(`Stored derived drain exceeded ${maxPages} pages`);
}

/**
 * Pending derived marks for `target` (and one record), for invalidation
 * assertions. Without `ref`, fanout marks (`<target>@<input>`) count too.
 */
export async function derivedMarkTickets(
  db: Database,
  target: string,
  ref?: string,
): Promise<number[]> {
  const rows = await getDb(db).execute(
    ref
      ? sql`SELECT ticket FROM "DerivedDirty" WHERE target = ${target} AND ref = ${ref}`
      : sql`SELECT ticket FROM "DerivedDirty" WHERE target = ${target} OR target LIKE ${`${target}@%`}`,
  );
  return z
    .array(z.object({ ticket: z.coerce.number() }))
    .parse(rows.rows)
    .map((row) => row.ticket);
}

/** Settle derived marks with an optional recipe costing seam (a USDA fixture). */
export async function drainRecipeRefreshJobs(
  db: Database,
  costing?: import("~/server/domains/recipe/repo/recipe-costing").RecipeCostingService,
  maxPages = 1_000,
): Promise<void> {
  if (!costing) return drainStoredDerived(db, maxPages);
  const recipeSink = derivedSink({
    prepare: async (tx, ids) => {
      const totals = new Map<
        string,
        Awaited<
          ReturnType<
            Awaited<ReturnType<typeof costing.prepareRefresh>>["compute"]
          >
        >
      >();
      for (const id of ids)
        // SAFETY: the drain passes ids of `recipe.totals` marks only.
        totals.set(
          id,
          await (
            await costing.bindTo(tx).prepareRefresh(id as RecipeId)
          ).compute(),
        );
      return totals;
    },
    publish: async (tx, ids, totals) => {
      const updates = ids.flatMap((id) => {
        const value = totals.get(id);
        // SAFETY: the drain passes ids of `recipe.totals` marks only.
        return value ? [{ id: id as RecipeId, totals: value }] : [];
      });
      await commitRecipeTotals(tx, { updates, freshOnlyIds: [] });
      return updates.map((update) => update.id);
    },
  });
  return drainStoredDerived(db, maxPages, {
    ...derivedComputes,
    "recipe.totals": recipeSink,
  });
}

/** Exercise broad catch-up: mark every stored value, then drain. */
export async function reconcileDerivedRefreshInputs(
  db: Database,
): Promise<void> {
  await markAllStoredDerived(db);
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
              or(
                inArray(job.state, ["queued", "retry_wait"]),
                and(eq(job.state, "completed"), unobservedJobInvalidation()),
              ),
            ),
          )
          .orderBy(job.availableAt, job.id)
          .limit(1);
        if (!pending) {
          messages.length = 0;
          return page;
        }
        if (pending.state !== "completed" && pending.availableAt > new Date())
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
